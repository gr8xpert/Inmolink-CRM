<?php
/**
 * Server-side rendering of the plugin's views.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin;

use Inmolink\Plugin\Api\Client;
use Inmolink\Plugin\Cache\Cache;
use Inmolink\Plugin\Cache\Result;
use Inmolink\Plugin\I18n\Locale;
use Inmolink\Plugin\Routing\Router;
use Inmolink\Plugin\Routing\Urls;
use Inmolink\Plugin\Seo\JsonLd;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Renders the plugin templates (`templates/*.php`, overridable by the theme as `inmolink/*.php`). Blocks and
 * shortcodes call these. When neither the API nor a cached copy has the data, the visitor sees an empty state — never
 * an API error. Templates show API fields only: the website API has already applied the white-label rules (no owner
 * agency, owner contacts or commission exist in its answers).
 */
class Renderer {

	/** Visitor query-string filters a results or map block accepts (the API's own names). */
	public const QUERY_ARGS = array( 'q', 'kind', 'transaction', 'types', 'locations', 'features', 'priceMin', 'priceMax', 'bedsMin', 'bathsMin', 'areaMin', 'areaMax', 'sort', 'cursor' );

	/** Block attributes that are search filters (0 / '' = not set). */
	private const FILTER_ATTRS = array( 'transaction', 'types', 'locations', 'features', 'kind', 'development', 'sort', 'limit', 'priceMin', 'priceMax', 'bedsMin' );

	/** Search form fields a block may show. */
	public const FORM_FIELDS = array( 'q', 'transaction', 'types', 'priceMin', 'priceMax', 'bedsMin' );

	/**
	 * Creates the renderer.
	 *
	 * @param Listings     $listings     Listing service.
	 * @param Developments $developments Development service.
	 * @param Cache        $cache        Transient cache (taxonomy).
	 */
	public function __construct(
		private readonly Listings $listings,
		private readonly ?Developments $developments = null,
		private readonly ?Cache $cache = null
	) {}

	/**
	 * The renderer wired from the settings.
	 */
	public static function from_settings(): self {
		$cache = new Cache( Client::from_settings() );
		return new self( Listings::from_settings(), new Developments( $cache ), $cache );
	}

	/**
	 * A results view for explicit search arguments.
	 *
	 * @param array<string,mixed> $args Search arguments ({@see Listings::search_query()}).
	 */
	public function search( array $args ): string {
		return $this->results_view( $args, false, true );
	}

	/**
	 * The `inmolink/results` block: its filters, overridden by the visitor's query string when `useQuery` is on.
	 *
	 * @param array<string,mixed> $attributes Block attributes.
	 */
	public function results( array $attributes ): string {
		$args    = self::filters( $attributes );
		$visitor = ! isset( $attributes['useQuery'] ) || false !== $attributes['useQuery'] ? self::visitor_query() : array();
		return $this->results_view( array_merge( $args, $visitor ), true, array() === $visitor );
	}

	/**
	 * The `inmolink/search` block.
	 *
	 * @param array<string,mixed> $attributes Block attributes.
	 */
	public function search_form( array $attributes ): string {
		$fields = array_values( array_intersect( array_map( 'trim', explode( ',', (string) ( $attributes['fields'] ?? implode( ',', self::FORM_FIELDS ) ) ) ), self::FORM_FIELDS ) );
		// Same site only (or a host allowed by `allowed_redirect_hosts`): visitors' searches never go elsewhere.
		$action = isset( $attributes['resultsUrl'] ) && is_string( $attributes['resultsUrl'] ) && '' !== $attributes['resultsUrl']
			? (string) wp_validate_redirect( esc_url_raw( $attributes['resultsUrl'], array( 'http', 'https' ) ), '' )
			: '';
		$locale = Locale::current();
		return $this->template(
			'search-form',
			array(
				'fields' => array() === $fields ? self::FORM_FIELDS : $fields,
				'action' => $action,
				'values' => Listings::search_query( self::visitor_query() ),
				'types'  => in_array( 'types', $fields, true ) || array() === $fields ? $this->property_types( $locale ) : array(),
			)
		);
	}

	/**
	 * A listing detail view.
	 *
	 * @param string      $ref     Reference.
	 * @param string|null $lang    Locale.
	 * @param bool        $jsonld  Print JSON-LD inline (not on routed pages: the head has it).
	 */
	public function detail( string $ref, ?string $lang = null, bool $jsonld = false ): string {
		$locale = Settings::resolve_locale( $lang ?? Locale::current() );
		$result = $this->listings->detail( $ref, $locale );
		return $this->detail_view( $result, $locale, $jsonld );
	}

	/**
	 * The `inmolink/detail` block: its `ref`, or the listing of the current pretty URL.
	 *
	 * @param array<string,mixed> $attributes Block attributes.
	 */
	public function detail_block( array $attributes ): string {
		$ref = isset( $attributes['ref'] ) && is_string( $attributes['ref'] ) ? trim( $attributes['ref'] ) : '';
		if ( '' === $ref ) {
			$route = Router::current();
			if ( null !== $route && 'listing' === $route['kind'] ) {
				return $this->detail_view( $route['result'], $route['locale'], false );
			}
			return '';
		}
		return $this->detail( $ref, Locale::current(), true );
	}

	/**
	 * The `inmolink/developments` block.
	 *
	 * @param array<string,mixed> $attributes Block attributes.
	 */
	public function developments( array $attributes ): string {
		$locale = Locale::current();
		$args   = array(
			'lang'      => $locale,
			'locations' => $attributes['locations'] ?? '',
			'limit'     => ! empty( $attributes['limit'] ) ? $attributes['limit'] : 12,
		);
		$result = null !== $this->developments ? $this->developments->list( $args ) : null;
		return $this->template(
			'developments',
			array(
				'items'  => self::items( $result ),
				'locale' => $locale,
				'stale'  => null !== $result && $result->stale,
			)
		);
	}

	/**
	 * A development detail view with its units.
	 *
	 * @param string      $ref    Development reference.
	 * @param string      $locale API locale.
	 * @param Result|null $known  The detail already fetched (routed page).
	 */
	public function development( string $ref, string $locale, ?Result $known = null ): string {
		$result = $known ?? ( null !== $this->developments ? $this->developments->detail( $ref, $locale ) : null );
		$units  = null !== $result && null !== $this->developments ? $this->developments->units( $ref, $locale ) : null;
		return $this->template(
			'development',
			array(
				'development' => null !== $result ? $result->body : null,
				'units'       => self::items( $units ),
				'locale'      => $locale,
				'stale'       => null !== $result && $result->stale,
			)
		);
	}

	/**
	 * The `inmolink/map` block: the matching listings' coordinates. No map provider (and no key) by default: the
	 * template prints the points as data and as a list; a theme script can turn them into an interactive map.
	 *
	 * @param array<string,mixed> $attributes Block attributes.
	 */
	public function map( array $attributes ): string {
		$args    = self::filters( $attributes );
		$visitor = ! isset( $attributes['useQuery'] ) || false !== $attributes['useQuery'] ? self::visitor_query() : array();
		unset( $visitor['cursor'] );
		$args          = array_merge( $args, $visitor );
		$args['limit'] = ! empty( $attributes['limit'] ) ? max( 1, min( 100, (int) $attributes['limit'] ) ) : 50;
		$locale        = Locale::current();
		$args['lang']  = $locale;
		$points        = array();
		foreach ( self::items( $this->listings->search( $args, array() === $visitor ) ) as $item ) {
			if ( ! isset( $item['geo']['lat'], $item['geo']['lng'] ) || ! is_numeric( $item['geo']['lat'] ) || ! is_numeric( $item['geo']['lng'] ) ) {
				continue;
			}
			$exact    = 'EXACT' === ( $item['geo']['precision'] ?? '' );
			$points[] = array(
				'ref'    => (string) ( $item['ref'] ?? '' ),
				'title'  => (string) ( $item['title'] ?? '' ),
				'url'    => Urls::for_item( $item, $locale ),
				'price'  => self::price( $item['price'] ?? null ),
				// Approximate locations are blurred further (~1 km), never published to the metre.
				'lat'    => round( (float) $item['geo']['lat'], $exact ? 5 : 2 ),
				'lng'    => round( (float) $item['geo']['lng'], $exact ? 5 : 2 ),
				'approx' => ! $exact,
			);
		}
		return $this->template( 'map', array( 'points' => $points ) );
	}

	/**
	 * A full page for a routed listing or development (theme header and footer around the detail view).
	 *
	 * @param string $kind   `listing` or `development`.
	 * @param string $ref    Reference.
	 * @param string $locale API locale.
	 */
	public function page( string $kind, string $ref, string $locale ): string {
		$route   = Router::current();
		$content = 'development' === $kind
			? $this->development( $ref, $locale, null !== $route ? $route['result'] : null )
			: $this->detail_view( null !== $route ? $route['result'] : $this->listings->detail( $ref, $locale ), $locale, false );
		return $this->template( 'development' === $kind ? 'page-development' : 'page-listing', array( 'content' => $content ) );
	}

	/**
	 * A price as the site shows it ("Price on request", or the amount in its currency).
	 *
	 * @param mixed $price The API's `price` object.
	 */
	public static function price( $price ): string {
		if ( ! is_array( $price ) || ! empty( $price['onRequest'] ) || ! isset( $price['amountCents'] ) || ! is_numeric( $price['amountCents'] ) ) {
			return __( 'Price on request', 'inmolink' );
		}
		$currency = isset( $price['currency'] ) && is_string( $price['currency'] ) ? $price['currency'] : '';
		return trim( number_format_i18n( ( (int) $price['amountCents'] ) / 100 ) . ' ' . $currency );
	}

	/**
	 * A development's price range ("From 450,000 EUR").
	 *
	 * @param mixed $price The API's development `price` object.
	 */
	public static function price_range( $price ): string {
		if ( ! is_array( $price ) || ! isset( $price['fromCents'] ) || ! is_numeric( $price['fromCents'] ) ) {
			return __( 'Price on request', 'inmolink' );
		}
		$currency = isset( $price['currency'] ) && is_string( $price['currency'] ) ? $price['currency'] : '';
		/* translators: %s: lowest price with currency, e.g. "450,000 EUR". */
		return sprintf( __( 'From %s', 'inmolink' ), trim( number_format_i18n( ( (int) $price['fromCents'] ) / 100 ) . ' ' . $currency ) );
	}

	/**
	 * A results view.
	 *
	 * @param array<string,mixed> $args      Search arguments.
	 * @param bool                $jsonld    Print an ItemList JSON-LD.
	 * @param bool                $canonical No visitor filters (the answer may be kept as a stale fallback).
	 */
	private function results_view( array $args, bool $jsonld, bool $canonical ): string {
		$locale       = Settings::resolve_locale( isset( $args['lang'] ) && is_string( $args['lang'] ) ? $args['lang'] : Locale::current() );
		$args['lang'] = $locale;
		$result       = $this->listings->search( $args, $canonical );
		$items        = self::items( $result );
		$urls         = array();
		foreach ( $items as $i => $item ) {
			$urls[ $i ] = Urls::for_item( $item, $locale );
		}
		$next = null !== $result && isset( $result->body['nextCursor'] ) && is_string( $result->body['nextCursor'] ) ? $result->body['nextCursor'] : null;
		return $this->template(
			'results',
			array(
				'items'    => $items,
				'urls'     => $urls,
				'total'    => null !== $result && isset( $result->body['total'] ) ? (int) $result->body['total'] : 0,
				'stale'    => null !== $result && $result->stale,
				'cursor'   => $next,
				'next_url' => null !== $next ? add_query_arg( 'cursor', rawurlencode( $next ) ) : '',
				'jsonld'   => $jsonld && array() !== $urls ? JsonLd::script( JsonLd::item_list( array_values( $urls ) ) ) : '',
			)
		);
	}

	/**
	 * A detail view from a result.
	 *
	 * @param Result|null $result Detail.
	 * @param string      $locale API locale.
	 * @param bool        $jsonld Print JSON-LD inline.
	 */
	private function detail_view( ?Result $result, string $locale, bool $jsonld ): string {
		$listing = null !== $result ? $result->body : null;
		$url     = null !== $listing ? Urls::for_item( $listing, $locale ) : '';
		return $this->template(
			'detail',
			array(
				'listing' => $listing,
				'url'     => $url,
				'stale'   => null !== $result && $result->stale,
				'jsonld'  => $jsonld && null !== $listing ? JsonLd::script( JsonLd::listing( $listing, $url ) ) : '',
			)
		);
	}

	/**
	 * The property types for the search form (`/v2/taxonomy/types`), as id => label (groups and their types).
	 *
	 * @param string $locale API locale.
	 * @return array<string,string>
	 */
	private function property_types( string $locale ): array {
		$result = null !== $this->cache ? $this->cache->get( '/v2/taxonomy/types', array( 'lang' => $locale ) ) : null;
		$out    = array();
		if ( null === $result || ! isset( $result->body['propertyTypes'] ) || ! is_array( $result->body['propertyTypes'] ) ) {
			return $out;
		}
		foreach ( $result->body['propertyTypes'] as $group ) {
			if ( ! is_array( $group ) || ! isset( $group['id'], $group['name'] ) ) {
				continue;
			}
			$out[ (string) $group['id'] ] = (string) $group['name'];
			foreach ( (array) ( $group['types'] ?? array() ) as $type ) {
				if ( is_array( $type ) && isset( $type['id'], $type['name'] ) ) {
					$out[ (string) $type['id'] ] = '— ' . (string) $type['name'];
				}
			}
		}
		return $out;
	}

	/**
	 * The search filters set on a block (empty strings and zeros are "not set").
	 *
	 * @param array<string,mixed> $attributes Block attributes.
	 * @return array<string,mixed>
	 */
	private static function filters( array $attributes ): array {
		$out = array();
		foreach ( self::FILTER_ATTRS as $name ) {
			if ( isset( $attributes[ $name ] ) && '' !== $attributes[ $name ] && 0 !== $attributes[ $name ] && false !== $attributes[ $name ] ) {
				$out[ $name ] = $attributes[ $name ];
			}
		}
		return $out;
	}

	/**
	 * The visitor's search filters from the query string (raw; {@see Listings::search_query()} validates them).
	 *
	 * @return array<string,string>
	 */
	public static function visitor_query(): array {
		$out = array();
		foreach ( self::QUERY_ARGS as $name ) {
			// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- public, read-only search filters, validated by Listings::search_query().
			if ( isset( $_GET[ $name ] ) && is_string( $_GET[ $name ] ) && '' !== $_GET[ $name ] ) {
				// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- as above.
				$out[ $name ] = sanitize_text_field( wp_unslash( $_GET[ $name ] ) );
			}
		}
		return $out;
	}

	/**
	 * The items of a list result.
	 *
	 * @param Result|null $result List answer.
	 * @return list<array<string,mixed>>
	 */
	private static function items( ?Result $result ): array {
		if ( null === $result || ! isset( $result->body['items'] ) || ! is_array( $result->body['items'] ) ) {
			return array();
		}
		return array_values( array_filter( $result->body['items'], 'is_array' ) );
	}

	/**
	 * Includes a page part (`parts/page-open`, `parts/page-close`), the theme's `inmolink/parts/*.php` first.
	 *
	 * @param string $name Part name.
	 */
	public static function part( string $name ): void {
		if ( ! in_array( $name, array( 'page-open', 'page-close' ), true ) ) {
			return;
		}
		$file = locate_template( 'inmolink/parts/' . $name . '.php' );
		include '' !== $file ? $file : dirname( __DIR__ ) . '/templates/parts/' . $name . '.php';
	}

	/**
	 * Whether a filtered template path is a PHP file inside the plugin's templates or the (parent/child) theme.
	 *
	 * @param string $file Path.
	 */
	private static function allowed_template( string $file ): bool {
		$real = realpath( $file );
		if ( false === $real || ! str_ends_with( $real, '.php' ) ) {
			return false;
		}
		foreach ( array( dirname( __DIR__ ) . '/templates', get_stylesheet_directory(), get_template_directory() ) as $root ) {
			$root = realpath( $root );
			if ( false !== $root && str_starts_with( $real, $root . DIRECTORY_SEPARATOR ) ) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Renders a template with variables (the theme's `inmolink/{name}.php` first).
	 *
	 * @param string              $name Template name.
	 * @param array<string,mixed> $vars Variables.
	 */
	private function template( string $name, array $vars ): string {
		$file = locate_template( 'inmolink/' . $name . '.php' );
		if ( '' === $file ) {
			$file = dirname( __DIR__ ) . '/templates/' . $name . '.php';
		}
		$filtered = (string) apply_filters( 'inmolink_template', $file, $name, $vars );
		if ( $filtered !== $file && self::allowed_template( $filtered ) ) {
			$file = $filtered;
		}
		ob_start();
		( static function ( string $inmolink_file, array $inmolink_vars ): void {
			// phpcs:ignore WordPress.PHP.DontExtract.extract_extract -- template variables, keys set above.
			extract( $inmolink_vars, EXTR_SKIP );
			include $inmolink_file;
		} )( $file, $vars );
		return (string) ob_get_clean();
	}
}
