<?php
/**
 * Listing and development pages on pretty URLs.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\Routing;

use Inmolink\Plugin\Cache\Result;
use Inmolink\Plugin\Developments;
use Inmolink\Plugin\I18n\Locale;
use Inmolink\Plugin\Listings;
use Inmolink\Plugin\Renderer;
use Inmolink\Plugin\Settings;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Registers one rewrite rule per site language and kind (`{language prefix}{base}/{ref}[/{slug}]/`), resolves the
 * routed listing or development once per request, redirects a wrong slug to the canonical URL, and renders the page
 * (`templates/page-listing.php` / `page-development.php`, overridable in the theme). Unknown references get a 404
 * page with a "no longer available" message.
 */
final class Router {

	public const VARS         = array( 'inmolink_listing', 'inmolink_development', 'inmolink_slug', 'inmolink_lang' );
	public const FLUSH_OPTION = 'inmolink_flush_rewrite';
	private const SEGMENT     = '([^/]+)';
	private const KINDS       = array( 'listing', 'development' );

	/**
	 * The resolved route of this request.
	 *
	 * @var array{kind:string,ref:string,slug:string,locale:string,result:?Result}|false|null
	 */
	private static $route = null;

	/**
	 * Hooks the router in.
	 */
	public static function register(): void {
		add_action( 'init', array( self::class, 'add_rules' ), 20 );
		add_filter( 'query_vars', array( self::class, 'query_vars' ) );
		add_filter( 'pre_handle_404', array( self::class, 'pre_handle_404' ), 10, 2 );
		add_action( 'template_redirect', array( self::class, 'template_redirect' ), 1 );
		add_filter( 'pre_get_document_title', array( self::class, 'document_title' ) );
		add_filter( 'posts_pre_query', array( self::class, 'posts_pre_query' ), 10, 2 );
		add_action( 'parse_query', array( self::class, 'parse_query' ) );
	}

	/**
	 * Adds the rewrite rules (and flushes them once after a settings change).
	 */
	public static function add_rules(): void {
		foreach ( self::rules() as $regex => $query ) {
			add_rewrite_rule( $regex, $query, 'top' );
		}
		if ( get_option( self::FLUSH_OPTION ) ) {
			delete_option( self::FLUSH_OPTION );
			flush_rewrite_rules( false );
		}
	}

	/**
	 * The rules: regex => query.
	 *
	 * @return array<string,string>
	 */
	public static function rules(): array {
		$rules = array();
		foreach ( Locale::routable() as $lang => $locale ) {
			$prefix = Urls::language_prefix( $lang );
			$extra  = '';
			foreach ( Locale::adapter()->query_vars( $lang ) as $name => $value ) {
				$extra .= '&' . rawurlencode( $name ) . '=' . rawurlencode( $value );
			}
			foreach ( self::KINDS as $kind ) {
				$base  = Settings::base_for( $kind, $locale );
				$regex = '^' . preg_quote( $prefix . $base, '#' ) . '/' . self::SEGMENT . '(?:/' . self::SEGMENT . ')?/?$';
				if ( isset( $rules[ $regex ] ) ) {
					// Two languages share this path (domain / subdomain language modes): the language is not in the
					// URL path, so the rule leaves it to the multilingual plugin's detection.
					$rules[ $regex ] = (string) preg_replace( '/&(inmolink_lang|lang)=[^&]*/', '', $rules[ $regex ] );
					continue;
				}
				$rules[ $regex ] = 'index.php?inmolink_' . $kind . '=$matches[1]&inmolink_slug=$matches[2]&inmolink_lang=' . rawurlencode( $lang ) . $extra;
			}
		}
		return $rules;
	}

	/**
	 * Asks for a rewrite flush on the next request (settings that change the rules were saved).
	 */
	public static function schedule_flush(): void {
		update_option( self::FLUSH_OPTION, 1, true );
	}

	/**
	 * Registers the query vars.
	 *
	 * @param string[] $vars Public query vars.
	 * @return string[]
	 */
	public static function query_vars( $vars ): array {
		return array_merge( is_array( $vars ) ? $vars : array(), self::VARS );
	}

	/**
	 * A routed request needs no posts: the main query is skipped.
	 *
	 * @param array|null $posts Posts so far.
	 * @param \WP_Query  $query Query.
	 * @return array|null
	 */
	public static function posts_pre_query( $posts, $query ) {
		if ( $query instanceof \WP_Query && $query->is_main_query() && null !== self::requested() ) {
			$query->found_posts   = 0;
			$query->max_num_pages = 0;
			return array();
		}
		return $posts;
	}

	/**
	 * A routed request is not the blog home (body classes, SEO plugins' canonicals).
	 *
	 * @param \WP_Query $query Query.
	 */
	public static function parse_query( $query ): void {
		if ( $query instanceof \WP_Query && $query->is_main_query() && null !== self::requested() ) {
			$query->is_home       = false;
			$query->is_front_page = false;
			$query->is_archive    = false;
		}
	}

	/**
	 * Our routes are never WordPress 404s (the router decides).
	 *
	 * @param bool      $preempt Whether to short-circuit.
	 * @param \WP_Query $query   Main query.
	 */
	public static function pre_handle_404( $preempt, $query ): bool {
		unset( $query );
		return null !== self::requested() ? true : (bool) $preempt;
	}

	/**
	 * The route requested by the query vars, before any API call.
	 *
	 * @return array{kind:string,ref:string,slug:string,locale:string}|null
	 */
	public static function requested(): ?array {
		foreach ( self::KINDS as $kind ) {
			$ref = get_query_var( 'inmolink_' . $kind );
			if ( is_string( $ref ) && '' !== $ref ) {
				$ref  = rawurldecode( $ref );
				$slug = rawurldecode( (string) get_query_var( 'inmolink_slug' ) );
				if ( ! preg_match( Listings::REF_PATTERN, $ref ) ) {
					return null;
				}
				return array(
					'kind'   => $kind,
					'ref'    => $ref,
					'slug'   => sanitize_title( $slug ),
					'locale' => Locale::current(),
				);
			}
		}
		return null;
	}

	/**
	 * The routed listing or development of this request, resolved once.
	 *
	 * @return array{kind:string,ref:string,slug:string,locale:string,result:?Result}|null
	 */
	public static function current(): ?array {
		if ( null === self::$route ) {
			$requested = self::requested();
			if ( null === $requested ) {
				self::$route = false;
			} else {
				$requested['result'] = 'development' === $requested['kind']
					? Developments::from_settings()->detail( $requested['ref'], $requested['locale'] )
					: Listings::from_settings()->detail( $requested['ref'], $requested['locale'] );
				self::$route         = $requested;
			}
		}
		return false === self::$route ? null : self::$route;
	}

	/**
	 * Forgets the resolved route (tests).
	 */
	public static function reset(): void {
		self::$route = null;
	}

	/**
	 * The canonical URL of the routed page, or null when there is none (not routed, not found).
	 */
	public static function canonical(): ?string {
		$route = self::current();
		if ( null === $route || null === $route['result'] ) {
			return null;
		}
		$slug = isset( $route['result']->body['slug'] ) && is_string( $route['result']->body['slug'] ) ? $route['result']->body['slug'] : '';
		return 'development' === $route['kind']
			? Urls::development( $route['ref'], $slug, $route['locale'] )
			: Urls::listing( $route['ref'], $slug, $route['locale'] );
	}

	/**
	 * `template_redirect`: redirect a wrong slug, else render the page and stop.
	 */
	public static function template_redirect(): void {
		$route = self::current();
		if ( null === $route ) {
			return;
		}
		$redirect = self::redirect_target();
		if ( null !== $redirect ) {
			wp_safe_redirect( $redirect, 301 );
			exit;
		}
		echo self::render_page(); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- templates escape their output.
		exit;
	}

	/**
	 * Where a routed request with a missing or outdated slug should go, or null.
	 */
	public static function redirect_target(): ?string {
		$route = self::current();
		if ( null === $route || null === $route['result'] || '' === (string) get_option( 'permalink_structure' ) ) {
			return null;
		}
		$slug = isset( $route['result']->body['slug'] ) && is_string( $route['result']->body['slug'] ) ? $route['result']->body['slug'] : '';
		$slug = Urls::slug( $slug );
		return ( '' !== $slug && $slug !== $route['slug'] ) ? self::canonical() : null;
	}

	/**
	 * Sends the status and renders the full page for the routed request.
	 */
	public static function render_page(): string {
		$route = self::current();
		if ( null === $route ) {
			return '';
		}
		if ( null === $route['result'] ) {
			status_header( 404 );
			nocache_headers();
		} else {
			status_header( 200 );
		}
		return Renderer::from_settings()->page( $route['kind'], $route['ref'], $route['locale'] );
	}

	/**
	 * The document title of a routed page: the API's meta title, else its title.
	 *
	 * @param string $title Title so far.
	 */
	public static function document_title( $title ) {
		$route = self::current();
		if ( null === $route || null === $route['result'] ) {
			return $title;
		}
		$body = $route['result']->body;
		foreach ( array( 'metaTitle', 'title', 'name' ) as $field ) {
			if ( ! empty( $body[ $field ] ) && is_string( $body[ $field ] ) ) {
				return $body[ $field ];
			}
		}
		return $title;
	}
}
