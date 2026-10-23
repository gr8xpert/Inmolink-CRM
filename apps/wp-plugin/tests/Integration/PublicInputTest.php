<?php
/**
 * Visitor-controlled input on public pages.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\Tests\Integration;

use Inmolink\Plugin\Cache\Cache;
use Inmolink\Plugin\Listings;
use Inmolink\Plugin\Renderer;
use Inmolink\Plugin\Tests\TestCase;

/**
 * References, search filters, form actions and template paths a visitor or contributor can influence.
 */
final class PublicInputTest extends TestCase {

	/**
	 * Clears the query string.
	 */
	public function tear_down(): void {
		$_GET = array();
		parent::tear_down();
	}

	/**
	 * [S8-04] `.`/`..` and other odd references never reach the API (no path traversal into other endpoints).
	 */
	public function test_s8_04_references_are_strict(): void {
		foreach ( array( '..', '.', '../units', '.hidden', 'a b', 'a/b', str_repeat( 'a', 65 ) ) as $ref ) {
			$this->assertNull( Listings::from_settings()->detail( $ref ), $ref );
		}
		$this->assertSame( array(), $this->api->requests );
		$this->assertSame( 1, preg_match( Listings::REF_PATTERN, 'INM-1001' ) );
		$this->assertSame( 1, preg_match( Listings::REF_PATTERN, 'ABC_12.3' ) );
	}

	/**
	 * [S8-04] An unknown reference is remembered for a few minutes: one API call, not one per request.
	 */
	public function test_s8_04_unknown_reference_is_cached(): void {
		$this->api->on( '/v2/listings/NOPE-1', array( 'status' => 404 ) );
		$this->assertNull( Listings::from_settings()->detail( 'NOPE-1' ) );
		$this->assertNull( Listings::from_settings()->detail( 'NOPE-1' ) );
		$this->assertCount( 1, $this->api->requests_to( '/v2/listings/NOPE-1' ) );

		$this->api->on( '/v2/developments/NOPE-2', array( 'status' => 404 ) );
		Renderer::from_settings()->development( 'NOPE-2', 'en' );
		Renderer::from_settings()->development( 'NOPE-2', 'en' );
		$this->assertCount( 1, $this->api->requests_to( '/v2/developments/NOPE-2' ) );
	}

	/**
	 * [S8-04] Searches shaped by the visitor's query string are cached for the TTL only, never as stale copies.
	 */
	public function test_s8_04_visitor_searches_are_not_kept_stale(): void {
		$this->api->on( '/v2/listings', array( 'fixture' => 'listings.search.json' ) );
		$_GET = array( 'priceMin' => '123456' );
		do_blocks( '<!-- wp:inmolink/results {"transaction":"SALE"} /-->' );

		$sent  = $this->api->requests_to( '/v2/listings' );
		$key   = Cache::key( '/v2/listings', Listings::search_query( $sent[0]['query'] ) );
		$entry = get_transient( $key );
		$this->assertIsArray( $entry );
		$this->assertFalse( $entry['keep_stale'] );

		$_GET = array();
		do_blocks( '<!-- wp:inmolink/results {"transaction":"SALE"} /-->' );
		$sent = $this->api->requests_to( '/v2/listings' );
		$own  = get_transient( Cache::key( '/v2/listings', Listings::search_query( $sent[1]['query'] ) ) );
		$this->assertTrue( $own['keep_stale'], 'the block\'s own search keeps its stale fallback' );
	}

	/**
	 * [S8-04] The search form only sends visitors to this site.
	 */
	public function test_s8_04_search_form_action_stays_on_site(): void {
		$this->api->on( '/v2/taxonomy/types', array( 'fixture' => 'taxonomy.types.json' ) );
		$external = do_blocks( '<!-- wp:inmolink/search {"resultsUrl":"https://phish.example/collect"} /-->' );
		$this->assertStringNotContainsString( 'phish.example', $external );
		$this->assertStringContainsString( 'action=""', $external );

		$local = do_blocks( '<!-- wp:inmolink/search {"resultsUrl":"' . home_url( '/buscar/' ) . '"} /-->' );
		$this->assertStringContainsString( 'action="' . home_url( '/buscar/' ) . '"', $local );
	}

	/**
	 * [S8-04] A filtered template path outside the plugin or theme is ignored.
	 */
	public function test_s8_04_template_filter_is_confined(): void {
		$this->api->on( '/v2/listings', array( 'fixture' => 'listings.search.json' ) );
		$outside = tempnam( sys_get_temp_dir(), 'tpl' ) . '.php';
		file_put_contents( $outside, '<?php echo "OUTSIDE";' );
		add_filter( 'inmolink_template', static fn () => $outside );

		$html = Renderer::from_settings()->search( array() );
		$this->assertStringNotContainsString( 'OUTSIDE', $html );
		$this->assertStringContainsString( 'Villa Sol', $html );
		unlink( $outside );
	}
}
