<?php
/**
 * The blocks: registration and what each renders.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\Tests\Integration;

use Inmolink\Plugin\Blocks\Blocks;
use Inmolink\Plugin\Tests\TestCase;

/**
 * Server-rendered blocks over the fake API.
 */
final class BlocksTest extends TestCase {

	/**
	 * Fixtures and pretty permalinks.
	 */
	public function set_up(): void {
		parent::set_up();
		$this->set_permalink_structure( '/%postname%/' );
		$this->api->on( '/v2/listings', array( 'fixture' => 'listings.search.json' ) );
		$this->api->on( '/v2/listings/INM-1001', array( 'fixture' => 'listing.INM-1001.json' ) );
		$this->api->on( '/v2/developments', array( 'fixture' => 'developments.page.json' ) );
		$this->api->on( '/v2/taxonomy/types', array( 'fixture' => 'taxonomy.types.json' ) );
	}

	/**
	 * Clears the query string.
	 */
	public function tear_down(): void {
		$_GET = array();
		parent::tear_down();
	}

	/**
	 * [S8-04] All five blocks are registered from block.json, dynamic, with the no-build editor script.
	 */
	public function test_s8_04_blocks_registered(): void {
		$registry = \WP_Block_Type_Registry::get_instance();
		foreach ( Blocks::NAMES as $name ) {
			$type = $registry->get_registered( 'inmolink/' . $name );
			$this->assertNotNull( $type, $name );
			$this->assertTrue( $type->is_dynamic(), $name );
			$this->assertContains( 'inmolink-blocks-editor', $type->editor_script_handles, $name );
		}
		$this->assertTrue( wp_script_is( 'inmolink-blocks-editor', 'registered' ) );
	}

	/**
	 * [S8-04] Results: links to the pretty URLs, the visitor's filters apply over the block's, JSON-LD ItemList.
	 */
	public function test_s8_04_results_block(): void {
		$_GET = array(
			'bedsMin' => '3',
			'q'       => 'sea view',
		);
		$html = do_blocks( '<!-- wp:inmolink/results {"transaction":"SALE","bedsMin":2} /-->' );

		$this->assertStringContainsString( 'href="' . home_url( '/property/INM-1001/villa-sol/' ) . '"', $html );
		$this->assertStringContainsString( '"@type":"ItemList"', $html );
		$query = $this->api->requests_to( '/v2/listings' )[0]['query'];
		$this->assertSame( 'SALE', $query['transaction'] );
		$this->assertSame( '3', $query['bedsMin'], 'the visitor overrides the block default' );
		$this->assertSame( 'sea view', $query['q'] );
	}

	/**
	 * [S8-04] Search form: types from the taxonomy, values kept and escaped, GET to the results page.
	 */
	public function test_s8_04_search_block(): void {
		$_GET = array( 'q' => '"><script>x</script>' );
		$html = do_blocks( '<!-- wp:inmolink/search {"resultsUrl":"/buscar/"} /-->' );

		$this->assertStringContainsString( 'method="get" action="/buscar/"', $html );
		$this->assertStringContainsString( '<option value="8d6f1a2b-4e9b-4c8d-9f0a-9b0c1d2e3f48"', $html );
		$this->assertStringNotContainsString( '<script>x', $html );
	}

	/**
	 * [S8-04] Map: points as data and a list, no third-party script or key.
	 */
	public function test_s8_04_map_block_uses_no_third_party(): void {
		$html = do_blocks( '<!-- wp:inmolink/map /-->' );
		$this->assertStringContainsString( 'data-points="', $html );
		$this->assertStringContainsString( 'data-lat="36.49"', $html, 'approximate points blurred to ~1 km' );
		$this->assertStringNotContainsString( '36.4935', $html );
		$this->assertStringContainsString( 'Approximate location', $html );
		$this->assertStringNotContainsString( '<script', $html );
		$this->assertDoesNotMatchRegularExpression( '/google|mapbox|openstreetmap|leaflet|api[_-]?key/i', $html );
	}

	/**
	 * [S8-04] Developments and detail blocks render from the API.
	 */
	public function test_s8_04_developments_and_detail_blocks(): void {
		$dev = do_blocks( '<!-- wp:inmolink/developments /-->' );
		$this->assertStringContainsString( 'href="' . home_url( '/development/DEV-77/mar-azul-residences/' ) . '"', $dev );
		$this->assertStringContainsString( '12 units available', $dev );

		$detail = do_blocks( '<!-- wp:inmolink/detail {"ref":"INM-1001"} /-->' );
		$this->assertStringContainsString( 'Villa Sol', $detail );
		$this->assertStringContainsString( '"@type":"RealEstateListing"', $detail );
		$this->assertStringContainsString( 'Private pool', $detail );
	}
}
