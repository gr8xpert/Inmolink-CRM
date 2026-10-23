<?php
/**
 * Pretty URLs per locale, canonical redirects and the routed page's head.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\Tests\Integration;

use Inmolink\Plugin\I18n\Languages;
use Inmolink\Plugin\I18n\Locale;
use Inmolink\Plugin\Routing\Router;
use Inmolink\Plugin\Routing\Urls;
use Inmolink\Plugin\Seo\Head;
use Inmolink\Plugin\Settings;
use Inmolink\Plugin\Tests\FakeApi;
use Inmolink\Plugin\Tests\TestCase;

/**
 * A two-language site (English at /, Spanish at /es/) through a fake multilingual adapter — the same contract the
 * Polylang and WPML adapters implement.
 */
final class RoutingTest extends TestCase {

	/**
	 * Two languages, per-locale bases, pretty permalinks, fresh rules.
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
		add_filter( 'inmolink_language_adapter', array( $this, 'adapter' ) );
		Locale::reset();
		Router::reset();
		$this->set_permalink_structure( '/%postname%/' );
		Router::add_rules();
		flush_rewrite_rules( false );

		$this->api->on( '/v2/listings/INM-1001', array( 'fixture' => 'listing.INM-1001.json' ) );
		$this->api->on( '/v2/developments/DEV-77', array( 'fixture' => 'development.DEV-77.json' ) );
		$this->api->on( '/v2/developments/DEV-77/units', array( 'fixture' => 'units.DEV-77.json' ) );
	}

	/**
	 * Restores the default adapter.
	 */
	public function tear_down(): void {
		remove_filter( 'inmolink_language_adapter', array( $this, 'adapter' ) );
		Locale::reset();
		Router::reset();
		parent::tear_down();
	}

	/**
	 * The fake two-language adapter.
	 */
	public function adapter(): Languages {
		return new class() implements Languages {
			/**
			 * Languages.
			 *
			 * @return string[]
			 */
			public function languages(): array {
				return array( 'en', 'es' );
			}
			/**
			 * Current language.
			 */
			public function current(): string {
				return 'en';
			}
			/**
			 * Home per language.
			 *
			 * @param string $lang Language.
			 */
			public function home_url( string $lang ): string {
				return 'es' === $lang ? home_url( '/es/' ) : home_url( '/' );
			}
			/**
			 * Extra query vars.
			 *
			 * @param string $lang Language.
			 * @return array<string,string>
			 */
			public function query_vars( string $lang ): array {
				unset( $lang );
				return array();
			}
		};
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
	 * [S8-04] Pretty URLs route per locale (prefix and base per language) and are built the same way.
	 */
	public function test_s8_04_pretty_url_routing_per_locale(): void {
		$en = Urls::listing( 'INM-1001', 'villa-sol', 'en' );
		$es = Urls::listing( 'INM-1001', 'villa-sol', 'es' );
		$this->assertSame( home_url( '/property/INM-1001/villa-sol/' ), $en );
		$this->assertSame( home_url( '/es/propiedad/INM-1001/villa-sol/' ), $es );

		$this->visit( $en );
		$this->assertSame( 'INM-1001', get_query_var( 'inmolink_listing' ) );
		$this->assertSame( 'en', get_query_var( 'inmolink_lang' ) );
		$this->assertSame( 'en', Router::current()['locale'] );
		$this->assertNotNull( Router::current()['result'] );

		$this->visit( $es );
		$this->assertSame( 'INM-1001', get_query_var( 'inmolink_listing' ) );
		$this->assertSame( 'es', get_query_var( 'inmolink_lang' ) );
		$this->assertSame( 'es', Router::current()['locale'] );
		$this->assertSame( 'es', $this->api->requests_to( '/v2/listings/INM-1001' )[1]['query']['lang'], 'detail fetched in Spanish' );

		$this->visit( home_url( '/es/promocion/DEV-77/mar-azul-residences/' ) );
		$this->assertSame( 'DEV-77', get_query_var( 'inmolink_development' ) );
		$this->assertSame( 'development', Router::current()['kind'] );
		$this->assertSame( home_url( '/es/promocion/DEV-77/mar-azul-residences/' ), Router::canonical() );
	}

	/**
	 * [S8-04] A missing or outdated slug redirects to the canonical URL; the right one does not.
	 */
	public function test_s8_04_wrong_slug_redirects_to_canonical(): void {
		$this->visit( home_url( '/property/INM-1001/old-title/' ) );
		$this->assertSame( home_url( '/property/INM-1001/villa-sol/' ), Router::redirect_target() );

		$this->visit( home_url( '/property/INM-1001/' ) );
		$this->assertSame( home_url( '/property/INM-1001/villa-sol/' ), Router::redirect_target() );

		$this->visit( home_url( '/property/INM-1001/villa-sol/' ) );
		$this->assertNull( Router::redirect_target() );
	}

	/**
	 * [S8-04] A slug with capitals or accents is compared normalised: no redirect loop.
	 */
	public function test_s8_04_non_ascii_slug_has_no_redirect_loop(): void {
		$this->api->on(
			'/v2/listings/INM-1001',
			static function (): array {
				$body         = json_decode( (string) file_get_contents( dirname( __DIR__ ) . '/fixtures/listing.INM-1001.json' ), true );
				$body['slug'] = 'Villa-Señor';
				return array( 'body' => $body );
			}
		);
		$canonical = Urls::listing( 'INM-1001', 'Villa-Señor', 'en' );
		$this->assertSame( home_url( '/property/INM-1001/villa-senor/' ), $canonical );
		$this->visit( $canonical );
		$this->assertNull( Router::redirect_target(), 'the canonical URL does not redirect to itself' );
	}

	/**
	 * [S8-04] Languages sharing a path (domain modes) leave the language to the multilingual plugin.
	 */
	public function test_s8_04_shared_path_rules_carry_no_language(): void {
		add_filter(
			'inmolink_language_adapter',
			function () {
				$adapter = $this->adapter();
				return new class( $adapter ) implements Languages {
					/**
					 * Wraps the fake adapter.
					 *
					 * @param Languages $inner Adapter.
					 */
					public function __construct( private Languages $inner ) {}
					/**
					 * Languages.
					 *
					 * @return string[]
					 */
					public function languages(): array {
						return $this->inner->languages();
					}
					/**
					 * Current language.
					 */
					public function current(): string {
						return 'en';
					}
					/**
					 * Same home for both (domain mode).
					 *
					 * @param string $lang Language.
					 */
					public function home_url( string $lang ): string {
						unset( $lang );
						return home_url( '/' );
					}
					/**
					 * Extra query vars.
					 *
					 * @param string $lang Language.
					 * @return array<string,string>
					 */
					public function query_vars( string $lang ): array {
						return array( 'lang' => $lang );
					}
				};
			},
			20
		);
		Locale::reset();
		Settings::save(
			array(
				'api_base'     => FakeApi::BASE,
				'locales'      => 'en,es',
				'listing_base' => 'property',
			)
		);
		$rules = Router::rules();
		$query = $rules['^property/([^/]+)(?:/([^/]+))?/?$'];
		$this->assertStringNotContainsString( 'inmolink_lang=', $query );
		$this->assertStringNotContainsString( '&lang=', $query );
	}

	/**
	 * [S8-04] A routed page's head: title, description, canonical, hreflang per language and JSON-LD.
	 */
	public function test_s8_04_routed_head_tags(): void {
		$this->visit( home_url( '/property/INM-1001/villa-sol/' ) );
		$head = Head::render();

		$this->assertStringContainsString( '<link rel="canonical" href="' . home_url( '/property/INM-1001/villa-sol/' ) . '" />', $head );
		$this->assertStringNotContainsString( 'hreflang="es"', $head, 'no Spanish slug known yet: no alternate that would redirect' );
		$this->assertStringNotContainsString( 'hreflang="x-default"', $head, 'one alternate only: no hreflang set' );

		( new \Inmolink\Plugin\Mirror\Mirror() )->upsert( 'INM-1001', 'es', array( 'slug' => 'villa-sol-es' ), null );
		$head = Head::render();
		$this->assertStringContainsString( 'hreflang="en" href="' . home_url( '/property/INM-1001/villa-sol/' ) . '"', $head );
		$this->assertStringContainsString( 'hreflang="es" href="' . home_url( '/es/propiedad/INM-1001/villa-sol-es/' ) . '"', $head );
		$this->assertStringContainsString( 'hreflang="x-default" href="' . home_url( '/property/INM-1001/villa-sol/' ) . '"', $head );
		$this->assertStringContainsString( '<script type="application/ld+json">', $head );
		$this->assertSame( 'Villa Sol', Router::document_title( 'x' ) );
	}

	/**
	 * [S8-04] A hostile API title or description cannot inject markup into the head.
	 */
	public function test_s8_04_hostile_texts_are_escaped_in_head(): void {
		$this->api->on(
			'/v2/listings/INM-1001',
			static function (): array {
				$body                    = json_decode( (string) file_get_contents( dirname( __DIR__ ) . '/fixtures/listing.INM-1001.json' ), true );
				$body['metaTitle']       = '</title><script>alert(1)</script>Villa';
				$body['metaDescription'] = '"><script>alert(2)</script>';
				return array( 'body' => $body );
			}
		);
		$this->visit( home_url( '/property/INM-1001/villa-sol/' ) );

		$title = wp_get_document_title();
		$this->assertStringNotContainsString( '<', $title );
		$this->assertStringNotContainsString( '</title>', $title );
		$this->assertStringContainsString( 'Villa', $title );

		$head = Head::render();
		$this->assertStringNotContainsString( '<script>alert', $head );
		$this->assertStringNotContainsString( '"><', $head );
	}

	/**
	 * [S8-04] An unknown reference gets a 404 page, no index, no redirect and no API error.
	 */
	public function test_s8_04_unknown_reference_is_not_found(): void {
		$this->visit( home_url( '/property/NOPE-1/whatever/' ) );
		$this->assertSame( 'NOPE-1', get_query_var( 'inmolink_listing' ) );
		$this->assertNull( Router::current()['result'] );
		$this->assertNull( Router::redirect_target() );
		$this->assertSame( '<meta name="robots" content="noindex" />' . "\n", Head::render() );
		$this->assertFalse( is_404(), 'not a WordPress 404 template: the router renders its own page' );
	}

	/**
	 * [S8-04] Without a multilingual plugin there is one language and no prefix.
	 */
	public function test_s8_04_single_language_default(): void {
		remove_filter( 'inmolink_language_adapter', array( $this, 'adapter' ) );
		Locale::reset();
		$this->assertSame( array( 'en' => 'en' ), Locale::routable() );
		$this->assertSame( '', Urls::language_prefix( 'en' ) );
		$rules = Router::rules();
		$this->assertArrayHasKey( '^property/([^/]+)(?:/([^/]+))?/?$', $rules );
		$this->assertCount( 2, $rules, 'listing + development' );
	}
}
