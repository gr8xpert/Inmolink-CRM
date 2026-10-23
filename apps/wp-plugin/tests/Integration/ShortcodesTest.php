<?php
/**
 * Acceptance (automatable part): every mapped shortcode renders the same output as its block.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\Tests\Integration;

use Inmolink\Plugin\Shortcodes\Shortcodes;
use Inmolink\Plugin\Tests\TestCase;

/**
 * Shortcode ↔ block parity over the whole mapping table. The real legacy inventory (H15) is still missing: when it
 * arrives, its shortcodes go into src/Shortcodes/map.php and a row each into {@see self::CASES}.
 */
final class ShortcodesTest extends TestCase {

	/**
	 * Per shortcode: the shortcode as a site writes it, and the block markup the editor saves for the same content.
	 */
	private const CASES = array(
		'inmolink_search'       => array( '[inmolink_search results_url="/buscar/" fields="q,transaction,bedsMin"]', '<!-- wp:inmolink/search {"resultsUrl":"/buscar/","fields":"q,transaction,bedsMin"} /-->' ),
		'inmolink_results'      => array( '[inmolink_results transaction="SALE" limit="2" price_min="100000" beds_min="3" use_query="no" sort="price_asc"]', '<!-- wp:inmolink/results {"transaction":"SALE","limit":2,"priceMin":100000,"bedsMin":3,"useQuery":false,"sort":"price_asc"} /-->' ),
		'inmolink_listing'      => array( '[inmolink_listing ref="INM-1001"]', '<!-- wp:inmolink/detail {"ref":"INM-1001"} /-->' ),
		'inmolink_developments' => array( '[inmolink_developments limit="5"]', '<!-- wp:inmolink/developments {"limit":5} /-->' ),
		'inmolink_map'          => array( '[inmolink_map transaction="SALE" limit="10"]', '<!-- wp:inmolink/map {"transaction":"SALE","limit":10} /-->' ),
	);

	/**
	 * Fixtures for every block.
	 */
	public function set_up(): void {
		parent::set_up();
		Shortcodes::reset();
		$this->api->on( '/v2/listings', array( 'fixture' => 'listings.search.json' ) );
		$this->api->on( '/v2/listings/INM-1001', array( 'fixture' => 'listing.INM-1001.json' ) );
		$this->api->on( '/v2/developments', array( 'fixture' => 'developments.page.json' ) );
		$this->api->on( '/v2/taxonomy/types', array( 'fixture' => 'taxonomy.types.json' ) );
	}

	/**
	 * Drops a table built with a test filter.
	 */
	public function tear_down(): void {
		Shortcodes::reset();
		parent::tear_down();
	}

	/**
	 * [S8-04] Each mapped shortcode renders the same output as its block.
	 */
	public function test_s8_04_each_mapped_shortcode_renders_as_its_block(): void {
		$map = Shortcodes::map();
		$this->assertSame( array_keys( $map ), array_keys( self::CASES ), 'every mapping entry has a parity case (add one per H15 shortcode)' );

		foreach ( self::CASES as $tag => list( $shortcode, $block ) ) {
			$this->assertTrue( shortcode_exists( $tag ), $tag );
			$from_shortcode = do_shortcode( $shortcode );
			$from_block     = do_blocks( $block );
			$this->assertNotSame( '', trim( $from_block ), $tag . ' renders something' );
			$this->assertSame( trim( $from_block ), trim( $from_shortcode ), $tag );
		}

		// The mapped attributes really reach the API (not just render identically).
		$queries = array_column( $this->api->requests_to( '/v2/listings' ), 'query' );
		$this->assertContains(
			array(
				'bedsMin'     => '3',
				'lang'        => 'en',
				'limit'       => '2',
				'priceMin'    => '100000',
				'sort'        => 'price_asc',
				'transaction' => 'SALE',
			),
			$queries
		);
		$this->assertSame( 'en', $this->api->requests_to( '/v2/developments' )[0]['query']['lang'] );
		$this->assertSame( '5', $this->api->requests_to( '/v2/developments' )[0]['query']['limit'] );
	}

	/**
	 * [S8-04] Shortcode attributes are mapped by name, value map and the block attribute type; unknown ones are ignored.
	 */
	public function test_s8_04_attribute_mapping_rules(): void {
		add_filter(
			'inmolink_shortcode_map',
			static function ( array $map ): array {
				$map['legacy_list'] = array(
					'block'       => 'inmolink/results',
					'attributes'  => array(
						'type'  => array(
							'to'     => 'transaction',
							'values' => array(
								'venta'    => 'SALE',
								'alquiler' => 'RENT_LONG_TERM',
							),
						),
						'items' => 'limit',
					),
					'provisional' => false,
					'source'      => 'test',
				);
				return $map;
			}
		);
		Shortcodes::reset();
		$block = Shortcodes::block_for(
			'legacy_list',
			array(
				'type'    => 'Venta',
				'items'   => '7',
				'onclick' => 'alert(1)',
			)
		);
		$this->assertSame( 'inmolink/results', $block['blockName'] );
		$this->assertSame(
			array(
				'transaction' => 'SALE',
				'limit'       => 7,
			),
			$block['attrs']
		);
	}

	/**
	 * [S8-04] Until H15 arrives every entry is labelled provisional, with its source.
	 */
	public function test_s8_04_seeded_entries_are_provisional(): void {
		foreach ( Shortcodes::map() as $tag => $entry ) {
			$this->assertTrue( $entry['provisional'], $tag );
			$this->assertStringContainsString( 'H15', $entry['source'], $tag );
			$this->assertNotNull( \WP_Block_Type_Registry::get_instance()->get_registered( $entry['block'] ), $tag . ' maps to a registered block' );
		}
	}
}
