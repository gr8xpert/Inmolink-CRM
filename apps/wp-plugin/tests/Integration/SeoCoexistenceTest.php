<?php
/**
 * Yoast SEO / Rank Math on routed pages (S8-F25).
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\Tests\Integration;

use Inmolink\Plugin\Routing\Router;
use Inmolink\Plugin\Seo\Coexistence;
use Inmolink\Plugin\Tests\YoastStub;
use Inmolink\Plugin\Tests\TestCase;

require_once dirname( __DIR__ ) . '/Support/SeoPluginStubs.php';

/**
 * The routed page is rendered by `Router::template_redirect()` (which ends the request); the test stops it at
 * `wp_footer` and inspects what was printed, with a stub of Yoast's head hooks active. Core includes the theme's header.php and
 * footer.php with `require_once`, so only ONE test per process can render a whole page; the others read `wp_head`.
 */
final class SeoCoexistenceTest extends TestCase {

	/**
	 * A listing page and Yoast on.
	 */
	public function set_up(): void {
		parent::set_up();
		$this->set_permalink_structure( '/%postname%/' );
		Router::reset();
		Router::add_rules();
		flush_rewrite_rules( false );
		$this->api->on( '/v2/listings/INM-1001', array( 'fixture' => 'listing.INM-1001.json' ) );
		YoastStub::activate();
	}

	/**
	 * Yoast off again.
	 */
	public function tear_down(): void {
		YoastStub::deactivate();
		Router::reset();
		parent::tear_down();
	}

	/**
	 * Runs `template_redirect` for a URL and returns the page printed before the request would end.
	 *
	 * @param string $url URL.
	 */
	private function page( string $url ): string {
		Router::reset();
		// The suite has no theme with header.php / footer.php: core falls back to its compat templates.
		$this->setExpectedDeprecated( 'Theme without header.php' );
		$this->setExpectedDeprecated( 'Theme without footer.php' );
		$this->go_to( $url );
		$stop = static function (): void {
			throw new \RuntimeException( 'page-complete' );
		};
		add_action( 'wp_footer', $stop, PHP_INT_MAX );
		$level = ob_get_level();
		ob_start();
		try {
			Router::template_redirect();
			$this->fail( 'template_redirect() should have rendered the page and ended the request' );
		} catch ( \RuntimeException $e ) {
			$this->assertSame( 'page-complete', $e->getMessage() );
		} finally {
			remove_action( 'wp_footer', $stop, PHP_INT_MAX );
			$html = '';
			while ( ob_get_level() > $level ) {
				$html = (string) ob_get_clean() . $html;
			}
		}
		return $html;
	}

	/**
	 * [S8-F25] A routed listing page has one canonical (ours) with Yoast active, and one title and no foreign description.
	 */
	public function test_s8_f25_routed_listing_has_one_canonical_with_yoast(): void {
		$html = $this->page( home_url( '/property/INM-1001/villa-sol/' ) );
		$this->assertSame( 1, substr_count( $html, 'rel="canonical"' ), 'one canonical' );
		$this->assertStringContainsString( '<link rel="canonical" href="' . home_url( '/property/INM-1001/villa-sol/' ) . '" />', $html );
		$this->assertSame( 1, substr_count( $html, '<title>' ), 'one title' );
		$this->assertStringContainsString( 'Villa Sol', $html );
		$this->assertStringNotContainsString( 'Yoast default', $html );
		$this->assertStringContainsString( 'application/ld+json', $html, 'our JSON-LD is still there' );
	}

	/**
	 * What `wp_head` prints for a URL (the `<head>` the routed page's header template would print).
	 *
	 * @param string $url URL.
	 */
	private function head( string $url ): string {
		Router::reset();
		$this->go_to( $url );
		ob_start();
		do_action( 'wp_head' );
		return (string) ob_get_clean();
	}

	/**
	 * [S8-F25] The control: without the plugin's filters the Yoast stub duplicates the canonical and adds its own
	 * title and description, so the end-to-end test above fails if the coexistence code stops working.
	 */
	public function test_s8_f25_stub_duplicates_without_the_coexistence_filters(): void {
		$url = home_url( '/property/INM-1001/villa-sol/' );
		$this->assertStringNotContainsString( 'Yoast default', $this->head( $url ), 'silenced' );

		remove_filter( 'wpseo_canonical', array( Coexistence::class, 'silence' ), PHP_INT_MAX );
		remove_filter( 'wpseo_title', array( Coexistence::class, 'title' ), PHP_INT_MAX );
		remove_filter( 'wpseo_metadesc', array( Coexistence::class, 'silence' ), PHP_INT_MAX );
		remove_filter( 'wpseo_frontend_presenters', array( Coexistence::class, 'presenters' ), PHP_INT_MAX );
		try {
			$html = $this->head( $url );
			$this->assertSame( 2, substr_count( $html, 'rel="canonical"' ) );
			$this->assertStringContainsString( 'Yoast default title', $html );
			$this->assertStringContainsString( 'Yoast default description', $html );
		} finally {
			Coexistence::register();
		}
	}

	/**
	 * [S8-F25] Either mechanism alone is enough: the filters without the presenter list.
	 */
	public function test_s8_f25_filters_alone_silence_yoast(): void {
		remove_filter( 'wpseo_frontend_presenters', array( Coexistence::class, 'presenters' ), PHP_INT_MAX );
		try {
			$html = $this->head( home_url( '/property/INM-1001/villa-sol/' ) );
			$this->assertSame( 1, substr_count( $html, 'rel="canonical"' ) );
			$this->assertStringNotContainsString( 'Yoast default', $html );
		} finally {
			Coexistence::register();
		}
	}

	/**
	 * [S8-F25] ... and the presenter list without the filters.
	 */
	public function test_s8_f25_presenter_list_alone_silences_yoast(): void {
		foreach ( array( 'wpseo_canonical', 'wpseo_metadesc' ) as $hook ) {
			remove_filter( $hook, array( Coexistence::class, 'silence' ), PHP_INT_MAX );
		}
		remove_filter( 'wpseo_title', array( Coexistence::class, 'title' ), PHP_INT_MAX );
		try {
			$html = $this->head( home_url( '/property/INM-1001/villa-sol/' ) );
			$this->assertSame( 1, substr_count( $html, 'rel="canonical"' ) );
			$this->assertStringNotContainsString( 'Yoast default', $html );
		} finally {
			Coexistence::register();
		}
	}

	/**
	 * [S8-F25] Elsewhere the SEO plugins are untouched, and Rank Math's filters follow the same rule.
	 */
	public function test_s8_f25_other_pages_and_rank_math_filters(): void {
		$this->go_to( home_url( '/' ) );
		Router::reset();
		$this->assertSame( 'https://x.test/', apply_filters( 'wpseo_canonical', 'https://x.test/' ) );
		$this->assertSame( 'Home', apply_filters( 'wpseo_title', 'Home' ) );
		$this->assertSame( 'https://x.test/', apply_filters( 'rank_math/frontend/canonical', 'https://x.test/' ) );

		Router::reset();
		$this->go_to( home_url( '/property/INM-1001/villa-sol/' ) );
		$this->assertFalse( apply_filters( 'rank_math/frontend/canonical', 'https://x.test/' ) );
		$this->assertFalse( apply_filters( 'rank_math/frontend/description', 'desc' ) );
		$this->assertSame( 'Villa Sol', apply_filters( 'rank_math/frontend/title', 'Rank Math title' ) );
		$this->assertSame( home_url( '/property/INM-1001/villa-sol/' ), apply_filters( 'wpseo_opengraph_url', 'https://x.test/' ) );
	}
}
