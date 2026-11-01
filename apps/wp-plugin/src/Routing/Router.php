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
use Inmolink\Plugin\I18n\PathAliases;
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
	 * Whether this request's query string tried to override the language its path sets ({@see request()}).
	 *
	 * @var bool
	 */
	private static bool $overridden = false;

	/**
	 * Hooks the router in.
	 */
	public static function register(): void {
		add_action( 'init', array( self::class, 'add_rules' ), 20 );
		add_filter( 'query_vars', array( self::class, 'query_vars' ) );
		add_filter( 'pre_handle_404', array( self::class, 'pre_handle_404' ), 10, 2 );
		add_action( 'template_redirect', array( self::class, 'template_redirect' ), 1 );
		add_filter( 'document_title_parts', array( self::class, 'document_title_parts' ) );
		add_filter( 'posts_pre_query', array( self::class, 'posts_pre_query' ), 10, 2 );
		add_action( 'parse_query', array( self::class, 'parse_query' ) );
		add_filter( 'rewrite_rules_array', array( self::class, 'guard_rules' ), PHP_INT_MAX );
		add_filter( 'request', array( self::class, 'request' ), 99 );
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
		$rules   = array();
		$owner   = array();
		$adapter = Locale::adapter();
		foreach ( Locale::routable() as $lang => $locale ) {
			$prefix   = Urls::language_prefix( $lang );
			$prefixes = $adapter instanceof PathAliases ? $adapter->request_prefixes( $lang, $prefix ) : array( $prefix );
			$extra    = '';
			foreach ( $adapter->query_vars( $lang ) as $name => $value ) {
				$extra .= '&' . rawurlencode( $name ) . '=' . rawurlencode( $value );
			}
			foreach ( self::KINDS as $kind ) {
				$base = Settings::base_for( $kind, $locale );
				foreach ( array_unique( $prefixes ) as $path_prefix ) {
					$regex = '^' . preg_quote( $path_prefix . $base, '#' ) . '/' . self::SEGMENT . '(?:/' . self::SEGMENT . ')?/?$';
					if ( isset( $rules[ $regex ] ) ) {
						if ( $owner[ $regex ] !== $lang ) {
							// Two languages share this path (domain / subdomain / parameter language modes, or WPML's
							// stripped directory): the language is not in the URL path, so the rule leaves it to the
							// multilingual plugin's detection.
							$rules[ $regex ] = (string) preg_replace( '/&(inmolink_lang|lang)=[^&]*/', '', $rules[ $regex ] );
						}
						continue;
					}
					$owner[ $regex ] = $lang;
					$rules[ $regex ] = 'index.php?inmolink_' . $kind . '=$matches[1]&inmolink_slug=$matches[2]&inmolink_lang=' . rawurlencode( $lang ) . $extra;
				}
			}
		}
		return $rules;
	}

	/**
	 * `rewrite_rules_array` (last): our rules exactly as {@see rules()} built them, on top. A multilingual plugin that
	 * rewrites every rule (Polylang's directory mode prefixes `(en|es)/` and shifts `$matches[n]` to add
	 * `lang=$matches[1]`) would otherwise produce a double language prefix, or a rule whose `$matches[1]` is the
	 * language instead of the reference. Any other rule that sets our query vars is dropped.
	 *
	 * @param array<string,string> $rules All rules.
	 * @return array<string,string>
	 */
	public static function guard_rules( $rules ): array {
		$rules = is_array( $rules ) ? $rules : array();
		$ours  = self::rules();
		foreach ( $rules as $regex => $query ) {
			if ( ! isset( $ours[ $regex ] ) && is_string( $query ) && preg_match( '/[?&]inmolink_(listing|development)=/', $query ) ) {
				unset( $rules[ $regex ] );
			}
		}
		return array_merge( $ours, array_diff_key( $rules, $ours ) );
	}

	/**
	 * `request`: on a pretty URL the path decides the language. A query string can override public query vars in
	 * WordPress (`?inmolink_lang=fr`, or Polylang's `?lang=fr` on `/es/propiedad/…`); the path's values are put back and
	 * the request is redirected to the canonical URL ({@see redirect_target()}) so one URL never serves two languages.
	 *
	 * @param array<string,mixed> $vars Query vars.
	 * @return array<string,mixed>
	 */
	public static function request( $vars ): array {
		$vars             = is_array( $vars ) ? $vars : array();
		self::$overridden = false;
		global $wp;
		$matched = $wp instanceof \WP && is_string( $wp->matched_query ) ? $wp->matched_query : '';
		if ( '' === $matched || ! preg_match( '/(^|&)inmolink_(listing|development)=/', $matched ) ) {
			return $vars;
		}
		$from_path = array();
		wp_parse_str( $matched, $from_path );
		if ( ! isset( $from_path['inmolink_lang'] ) || '' === $from_path['inmolink_lang'] ) {
			return $vars; // A shared path: the multilingual plugin's detection decides.
		}
		$lang  = (string) $from_path['inmolink_lang'];
		$names = array_merge( array( 'inmolink_lang' ), array_keys( Locale::adapter()->query_vars( $lang ) ) );
		foreach ( $names as $name ) {
			if ( ! isset( $from_path[ $name ] ) ) {
				continue;
			}
			if ( isset( $vars[ $name ] ) && (string) $vars[ $name ] !== (string) $from_path[ $name ] ) {
				self::$overridden = true;
			}
			$vars[ $name ] = (string) $from_path[ $name ];
		}
		return $vars;
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
		self::$route      = null;
		self::$overridden = false;
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
		if ( self::$overridden ) {
			return self::canonical();
		}
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
	 * The document title of a routed page as plain text: the API's meta title, else its title.
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
				// Plain text: the API's texts are never markup.
				return trim( wp_strip_all_tags( $body[ $field ] ) );
			}
		}
		return $title;
	}

	/**
	 * `document_title_parts`: the routed page's title as the page part. WordPress escapes the parts when it builds
	 * the `<title>` (unlike `pre_get_document_title`, whose value is printed as is).
	 *
	 * @param array<string,string> $parts Title parts.
	 * @return array<string,string>
	 */
	public static function document_title_parts( $parts ): array {
		$parts = is_array( $parts ) ? $parts : array();
		$title = self::document_title( '' );
		if ( '' !== $title ) {
			$parts['title'] = $title;
		}
		return $parts;
	}
}
