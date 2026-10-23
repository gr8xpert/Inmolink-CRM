<?php
/**
 * WordPress sitemaps from /v2/sitemap.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\Tests\Integration;

use Inmolink\Plugin\Api\Client;
use Inmolink\Plugin\Seo\SitemapIndex;
use Inmolink\Plugin\Seo\SitemapProvider;
use Inmolink\Plugin\Tests\FakeApi;
use Inmolink\Plugin\Tests\TestCase;

/**
 * The provider walks the API's cursor pages once, then serves its chunks — also while the API is down.
 */
final class SitemapTest extends TestCase {

	/**
	 * Two API pages (3 entries) and pretty permalinks.
	 */
	public function set_up(): void {
		parent::set_up();
		$this->set_permalink_structure( '/%postname%/' );
		$this->api->on(
			'/v2/sitemap',
			static fn ( array $query ): array => array( 'fixture' => 'sm_p2' === ( $query['cursor'] ?? null ) ? 'sitemap.page2.json' : 'sitemap.page1.json' )
		);
	}

	/**
	 * A provider with sitemap pages of two entries.
	 */
	private function provider(): SitemapProvider {
		return new SitemapProvider( new SitemapIndex( new Client( FakeApi::BASE, self::KEY, Client::SYNC_TIMEOUT ), 2 ) );
	}

	/**
	 * [S8-04] Sitemap entries: every listing and unit page of the site, with lastmod, in pages.
	 */
	public function test_s8_04_sitemap_entries(): void {
		$provider = $this->provider();
		$this->assertSame( 2, $provider->get_max_num_pages( 'en' ) );
		$this->assertSame(
			array(
				array(
					'loc'     => home_url( '/property/INM-1001/villa-sol/' ),
					'lastmod' => '2026-10-23T09:00:03Z',
				),
				array(
					'loc'     => home_url( '/property/INM-1002/casa-luna/' ),
					'lastmod' => '2026-10-22T08:00:00Z',
				),
			),
			$provider->get_url_list( 1, 'en' )
		);
		$this->assertSame( home_url( '/property/DEV-77-A1/mar-azul-a1/' ), $provider->get_url_list( 2, 'en' )[0]['loc'] );
		$this->assertSame( array(), $provider->get_url_list( 3, 'en' ) );

		$calls = $this->api->requests_to( '/v2/sitemap' );
		$this->assertCount( 2, $calls, 'one walk over the cursor pages' );
		$this->assertSame( 'en', $calls[0]['query']['lang'] );
		$this->assertSame( 'sm_p2', $calls[1]['query']['cursor'] );
	}

	/**
	 * [S8-F24] Development entries of the sitemap: the development URL with lastmod, beside the listings.
	 */
	public function test_s8_f24_sitemap_lists_developments_with_lastmod(): void {
		$this->api->on( '/v2/sitemap', array( 'fixture' => 'sitemap.developments.json' ) );
		$provider = new SitemapProvider( new SitemapIndex( new Client( FakeApi::BASE, self::KEY, Client::SYNC_TIMEOUT ), 10 ) );
		$this->assertSame( 1, $provider->get_max_num_pages( 'en' ) );
		$this->assertSame(
			array(
				array(
					'loc'     => home_url( '/property/INM-1001/villa-sol/' ),
					'lastmod' => '2026-10-23T09:00:03Z',
				),
				array(
					'loc'     => home_url( '/development/DEV-77/mar-azul-residences/' ),
					'lastmod' => '2026-10-22T07:30:00Z',
				),
			),
			$provider->get_url_list( 1, 'en' )
		);
	}

	/**
	 * [S8-04] Built once, then served from the index — also when the API is down; a failed rebuild keeps it.
	 */
	public function test_s8_04_sitemap_served_from_index_when_api_down(): void {
		$this->provider()->get_max_num_pages( 'en' );
		$this->api->down();
		$provider = $this->provider();
		$this->assertSame( 2, $provider->get_max_num_pages( 'en' ) );
		$this->assertCount( 2, $provider->get_url_list( 1, 'en' ) );

		$index = new SitemapIndex( new Client( FakeApi::BASE, self::KEY, Client::SYNC_TIMEOUT ), 2 );
		$this->assertFalse( $index->build( 'en' ) );
		$this->assertCount( 1, $index->entries( 'en', 2 ), 'previous index kept' );
	}

	/**
	 * [S8-04] A rebuild keeps one copy; subtypes are lower case for core's sitemap URLs.
	 */
	public function test_s8_04_rebuild_keeps_one_copy_and_lowercase_subtypes(): void {
		global $wpdb;
		$index = new SitemapIndex( new Client( FakeApi::BASE, self::KEY, Client::SYNC_TIMEOUT ), 2 );
		$this->assertTrue( $index->build( 'en' ) );
		$this->assertTrue( $index->build( 'en' ) );
		$chunks = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->options} WHERE option_name LIKE '\\_transient\\_inmolink\\_sm\\_en\\_%'" );
		$this->assertSame( 2, $chunks, 'two chunks of the current generation only' );

		$this->assertSame( 'es-es', SitemapProvider::subtype( 'es_ES' ) );
		$this->assertSame( 'es-es', SitemapProvider::subtype( 'es-ES' ) );
	}

	/**
	 * [S8-04] The provider is registered with WordPress core sitemaps.
	 */
	public function test_s8_04_provider_registered_with_core_sitemaps(): void {
		$provider = wp_sitemaps_get_server()->registry->get_provider( SitemapProvider::NAME );
		$this->assertInstanceOf( SitemapProvider::class, $provider );
		$this->assertArrayHasKey( 'en', $provider->get_object_subtypes() );
	}
}
