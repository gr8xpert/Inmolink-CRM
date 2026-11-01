<?php
/**
 * Polylang and WPML adapters against fakes of their documented URL behaviours (S8-F21).
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\Tests\Integration;

use Inmolink\Plugin\I18n\Locale;
use Inmolink\Plugin\I18n\Polylang;
use Inmolink\Plugin\I18n\PolylangApi;
use Inmolink\Plugin\I18n\Wpml;
use Inmolink\Plugin\Routing\Router;
use Inmolink\Plugin\Routing\Urls;
use Inmolink\Plugin\Settings;
use Inmolink\Plugin\Tests\FakeApi;
use Inmolink\Plugin\Tests\TestCase;

// phpcs:disable WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- WPML's own filter API, faked.

/**
 * These are fakes, not real installs: each reproduces a behaviour Polylang's or WPML's documentation describes. The
 * real-install pass is the manual checklist in docs/build/wp-plugin-real-install-check.md (H15).
 */
final class MultilingualAdaptersTest extends TestCase {

	/**
	 * The WPML fake's current language (WPML detects it from the URL; the test sets it before a visit).
	 *
	 * @var string
	 */
	private string $wpml_current = 'en';

	/**
	 * WPML fake mode: `dir` (directories) or `param` (`?lang=`).
	 *
	 * @var string
	 */
	private string $wpml_mode = 'dir';

	/**
	 * Two languages (English default, Spanish), per-locale bases, pretty permalinks.
	 */
	public function set_up(): void {
		parent::set_up();
		Settings::save(
			array(
				'api_base'         => FakeApi::BASE,
				'locales'          => 'en,es',
				'default_locale'   => 'en',
				'listing_base'     => 'property, es:propiedad',
				'development_base' => 'development, es:promocion',
			)
		);
		Settings::set_api_key( self::KEY );
		$this->set_permalink_structure( '/%postname%/' );
		$this->api->on( '/v2/listings/INM-1001', array( 'fixture' => 'listing.INM-1001.json' ) );
		$this->api->on( '/v2/developments/DEV-77', array( 'fixture' => 'development.DEV-77.json' ) );
		$this->api->on( '/v2/developments/DEV-77/units', array( 'fixture' => 'units.DEV-77.json' ) );
	}

	/**
	 * Removes every fake.
	 */
	public function tear_down(): void {
		foreach ( array( 'inmolink_language_adapter', 'wpml_active_languages', 'wpml_default_language', 'wpml_current_language', 'wpml_permalink' ) as $hook ) {
			remove_all_filters( $hook );
		}
		remove_filter( 'home_url', array( $this, 'wpml_home_url' ), 10 );
		remove_filter( 'rewrite_rules_array', array( $this, 'polylang_directory_rules' ), 10 );
		remove_filter( 'query_vars', array( $this, 'polylang_query_var' ) );
		Locale::reset();
		Router::reset();
		parent::tear_down();
	}

	/**
	 * Uses an adapter and rebuilds the rewrite rules with it.
	 *
	 * @param object $adapter Adapter.
	 */
	private function use_adapter( $adapter ): void {
		add_filter( 'inmolink_language_adapter', static fn () => $adapter );
		Locale::reset();
		Router::reset();
		Router::add_rules();
		flush_rewrite_rules( false );
	}

	/**
	 * Visits a URL and resolves the route afresh.
	 *
	 * @param string $url URL.
	 */
	private function visit( string $url ): void {
		Router::reset();
		$this->go_to( $url );
	}

	/**
	 * A fake of Polylang's functions: English default (no prefix, "hide URL language information for default
	 * language"), Spanish in `/es/`.
	 *
	 * @param array<string,string> $homes       Language => `pll_home_url()`.
	 * @param array<int,int>       $translations Post ID => Spanish translation ID (`pll_get_post`).
	 */
	private function polylang( array $homes = array(), array $translations = array() ): Polylang {
		$homes = $homes + array(
			'en' => home_url( '/' ),
			'es' => home_url( '/es/' ),
		);
		return new Polylang(
			new class( $homes, $translations ) extends PolylangApi {
				/**
				 * Fake state.
				 *
				 * @param array<string,string> $homes        Homes.
				 * @param array<int,int>       $translations Translations.
				 */
				public function __construct( private array $homes, private array $translations ) {}
				/**
				 * Languages.
				 *
				 * @return string[]
				 */
				public function languages_list(): array {
					return array( 'es', 'en' );
				}
				/**
				 * Default language.
				 */
				public function default_language(): string {
					return 'en';
				}
				/**
				 * Current language.
				 */
				public function current_language(): string {
					return '';
				}
				/**
				 * Home URL.
				 *
				 * @param string $slug Language.
				 */
				public function home_url( string $slug ): string {
					return $this->homes[ $slug ];
				}
				/**
				 * Translation.
				 *
				 * @param int    $post_id Post.
				 * @param string $slug    Language.
				 */
				public function get_post( int $post_id, string $slug ): int {
					return 'es' === $slug ? ( $this->translations[ $post_id ] ?? 0 ) : $post_id;
				}
			}
		);
	}

	/**
	 * Polylang's directory mode as documented for rules it filters: every rule prefixed with the language
	 * alternation, `lang=$matches[1]` added and the other matches shifted ("hide_default" off: originals removed).
	 * Applied here to every rule, ours included — the worst case.
	 *
	 * @param array<string,string> $rules Rules.
	 * @return array<string,string>
	 */
	public function polylang_directory_rules( $rules ): array {
		$out = array();
		foreach ( (array) $rules as $regex => $query ) {
			$out[ '(en|es)/' . ltrim( (string) $regex, '^' ) ] = str_replace(
				array( '[2]', '[1]', '?' ),
				array( '[3]', '[2]', '?lang=$matches[1]&' ),
				(string) $query
			);
		}
		return $out;
	}

	/**
	 * Polylang registers `lang` as a public query var.
	 *
	 * @param string[] $vars Vars.
	 * @return string[]
	 */
	public function polylang_query_var( $vars ): array {
		return array_merge( (array) $vars, array( 'lang' ) );
	}

	/**
	 * [S8-F21] Polylang directory mode: no double prefix and no shifted matches, even when Polylang rewrites our rules.
	 */
	public function test_s8_f21_polylang_directory_mode_no_double_prefix(): void {
		add_filter( 'query_vars', array( $this, 'polylang_query_var' ) );
		add_filter( 'rewrite_rules_array', array( $this, 'polylang_directory_rules' ) );
		$this->use_adapter( $this->polylang() );

		global $wp_rewrite;
		$rules = $wp_rewrite->wp_rewrite_rules();
		$es    = '^es/propiedad/([^/]+)(?:/([^/]+))?/?$';
		$this->assertArrayHasKey( $es, $rules );
		$this->assertSame( 'index.php?inmolink_listing=$matches[1]&inmolink_slug=$matches[2]&inmolink_lang=es&lang=es', $rules[ $es ] );
		$this->assertSame( '^property/([^/]+)(?:/([^/]+))?/?$', array_keys( $rules )[0], 'ours stay on top' );
		foreach ( $rules as $regex => $query ) {
			if ( str_contains( $query, 'inmolink_' ) ) {
				$this->assertStringNotContainsString( '(en|es)/', $regex, 'no rewritten (double-prefixed) copy of our rules' );
				$this->assertStringNotContainsString( '$matches[3]', $query );
			}
		}
		$this->assertArrayHasKey( '(en|es)/feed/(feed|rdf|rss|rss2|atom)/?$', $rules, 'other rules are left to Polylang' );

		$this->visit( home_url( '/es/propiedad/INM-1001/villa-sol/' ) );
		$this->assertSame( 'INM-1001', get_query_var( 'inmolink_listing' ) );
		$this->assertSame( 'es', get_query_var( 'lang' ) );
		$this->assertSame( 'es', Router::current()['locale'] );
		$this->assertNull( Router::redirect_target() );

		$this->visit( home_url( '/property/INM-1001/villa-sol/' ) );
		$this->assertSame( 'en', Router::current()['locale'] );
		$this->assertSame( home_url( '/es/propiedad/INM-1001/villa-sol/' ), Urls::listing( 'INM-1001', 'villa-sol', 'es' ) );
	}

	/**
	 * [S8-F21] Polylang with a static front page: `pll_home_url()` is the translated front page (`/es/inicio/`); URLs
	 * and rewrite prefixes use the language root.
	 */
	public function test_s8_f21_polylang_static_front_page_home(): void {
		$home   = self::factory()->post->create(
			array(
				'post_type' => 'page',
				'post_name' => 'home',
			)
		);
		$inicio = self::factory()->post->create(
			array(
				'post_type' => 'page',
				'post_name' => 'inicio',
			)
		);
		update_option( 'show_on_front', 'page' );
		update_option( 'page_on_front', $home );
		$adapter = $this->polylang(
			array(
				'en' => home_url( '/home/' ),
				'es' => home_url( '/es/inicio/' ),
			),
			array( $home => $inicio )
		);
		$this->use_adapter( $adapter );

		$this->assertSame( home_url( '/es/' ), $adapter->home_url( 'es' ) );
		$this->assertSame( home_url( '/' ), $adapter->home_url( 'en' ) );
		$this->assertSame( 'es/', Urls::language_prefix( 'es' ) );
		$this->assertSame( home_url( '/es/propiedad/INM-1001/villa-sol/' ), Urls::listing( 'INM-1001', 'villa-sol', 'es' ) );
		$this->assertArrayHasKey( '^es/propiedad/([^/]+)(?:/([^/]+))?/?$', Router::rules() );
		$this->assertArrayNotHasKey( '^es/inicio/propiedad/([^/]+)(?:/([^/]+))?/?$', Router::rules() );
	}

	/**
	 * [S8-F21] The extra `lang=` query var: a query string that contradicts the path's language (`?lang=en` or
	 * `?inmolink_lang=en` on `/es/…`) is overridden by the path and redirected to the canonical URL.
	 */
	public function test_s8_f21_conflicting_lang_query_var_redirects(): void {
		add_filter( 'query_vars', array( $this, 'polylang_query_var' ) );
		$this->use_adapter( $this->polylang() );
		$canonical = home_url( '/es/propiedad/INM-1001/villa-sol/' );

		foreach ( array( '?lang=en', '?inmolink_lang=en' ) as $query ) {
			$this->visit( $canonical . $query );
			$this->assertSame( 'INM-1001', get_query_var( 'inmolink_listing' ), $query );
			$this->assertSame( 'es', get_query_var( 'inmolink_lang' ), $query . ': the path decides' );
			$this->assertSame( 'es', get_query_var( 'lang' ), $query );
			$this->assertSame( 'es', Router::current()['locale'], $query );
			$this->assertSame( $canonical, Router::redirect_target(), $query . ' redirects to the canonical URL' );
		}

		$this->visit( $canonical . '?lang=es' );
		$this->assertNull( Router::redirect_target(), 'an agreeing lang= is not a conflict' );
	}

	/**
	 * A fake of WPML's documented filter API.
	 */
	private function wpml(): Wpml {
		add_filter(
			'wpml_active_languages',
			static fn () => array(
				'en' => array( 'code' => 'en' ),
				'es' => array( 'code' => 'es' ),
			)
		);
		add_filter( 'wpml_default_language', static fn () => 'en' );
		add_filter( 'wpml_current_language', fn () => $this->wpml_current );
		add_filter(
			'wpml_permalink',
			function ( $url, $lang ) {
				$root = untrailingslashit( (string) get_option( 'home' ) );
				$path = substr( strtok( (string) $url, '?' ), strlen( $root ) );
				$path = (string) preg_replace( '#^/(en|es)(/|$)#', '/', '' === $path ? '/' : $path );
				if ( 'param' === $this->wpml_mode ) {
					return $root . $path . ( 'en' === $lang ? '' : '?lang=' . $lang );
				}
				return $root . ( 'en' === $lang ? '' : '/' . $lang ) . $path;
			},
			10,
			2
		);
		return new Wpml();
	}

	/**
	 * WPML in directory mode filters `home_url()` to the current language's directory.
	 *
	 * @param string $url  URL.
	 * @param string $path Path.
	 */
	public function wpml_home_url( $url, $path ): string {
		unset( $path );
		if ( 'es' !== $this->wpml_current ) {
			return (string) $url;
		}
		$root = untrailingslashit( (string) get_option( 'home' ) );
		return 0 === strpos( (string) $url, $root . '/es' ) ? (string) $url : $root . '/es' . substr( (string) $url, strlen( $root ) );
	}

	/**
	 * [S8-F21] WPML directory mode: WordPress matches the request with WPML's filtered home stripped
	 * (`/es/propiedad/…` is matched as `propiedad/…`); listing and development URLs still route per locale.
	 */
	public function test_s8_f21_wpml_directory_mode_stripped_request_uri(): void {
		$this->use_adapter( $this->wpml() );
		$es = home_url( '/es/propiedad/INM-1001/villa-sol/' );
		$this->assertSame( $es, Urls::listing( 'INM-1001', 'villa-sol', 'es' ) );
		$rules = Router::rules();
		$this->assertArrayHasKey( '^es/propiedad/([^/]+)(?:/([^/]+))?/?$', $rules, 'the directory form' );
		$this->assertStringContainsString( 'inmolink_lang=es', $rules['^propiedad/([^/]+)(?:/([^/]+))?/?$'], 'the stripped form' );

		add_filter( 'home_url', array( $this, 'wpml_home_url' ), 10, 2 );
		$this->wpml_current = 'es';
		$this->visit( $es );
		$this->assertSame( 'INM-1001', get_query_var( 'inmolink_listing' ) );
		$this->assertSame( 'es', Router::current()['locale'] );
		$this->visit( home_url( '/es/promocion/DEV-77/mar-azul-residences/' ) );
		$this->assertSame( 'DEV-77', get_query_var( 'inmolink_development' ) );
		$this->assertSame( 'es', Router::current()['locale'] );

		// Same base in both languages: the stripped path is shared, so WPML's detected language decides.
		remove_filter( 'home_url', array( $this, 'wpml_home_url' ), 10 );
		$this->wpml_current = 'en';
		Settings::save(
			array(
				'api_base'         => FakeApi::BASE,
				'locales'          => 'en,es',
				'listing_base'     => 'property',
				'development_base' => 'development',
			)
		);
		Settings::set_api_key( self::KEY );
		Router::add_rules();
		flush_rewrite_rules( false );
		$this->assertStringNotContainsString( 'inmolink_lang=', Router::rules()['^property/([^/]+)(?:/([^/]+))?/?$'] );

		add_filter( 'home_url', array( $this, 'wpml_home_url' ), 10, 2 );
		$this->wpml_current = 'es';
		$this->visit( home_url( '/es/property/INM-1001/villa-sol/' ) );
		$this->assertSame( 'INM-1001', get_query_var( 'inmolink_listing' ) );
		$this->assertSame( 'es', Router::current()['locale'] );
	}

	/**
	 * [S8-F21] WPML "language name added as a parameter": the home URL keeps `?lang=es` after the path, listing URLs
	 * put the path before it, and they route per locale.
	 */
	public function test_s8_f21_wpml_language_parameter_mode(): void {
		$this->wpml_mode = 'param';
		$adapter         = $this->wpml();
		$this->use_adapter( $adapter );

		$this->assertSame( home_url( '/' ) . '?lang=es', $adapter->home_url( 'es' ) );
		$this->assertSame( '', Urls::language_prefix( 'es' ) );
		$url = Urls::listing( 'INM-1001', 'villa-sol', 'es' );
		$this->assertSame( home_url( '/propiedad/INM-1001/villa-sol/' ) . '?lang=es', $url );
		$this->assertSame( home_url( '/development/DEV-77/mar-azul-residences/' ), Urls::development( 'DEV-77', 'mar-azul-residences', 'en' ) );

		$this->wpml_current = 'es';
		$this->visit( $url );
		$this->assertSame( 'INM-1001', get_query_var( 'inmolink_listing' ) );
		$this->assertSame( 'es', Router::current()['locale'] );
		$this->assertSame( $url, Router::canonical() );
		$this->assertNull( Router::redirect_target() );
	}
}
