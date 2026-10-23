<?php
/**
 * Acceptance: with the API unreachable, cached search and detail pages still render.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\Tests\Integration;

use Inmolink\Plugin\Api\Client;
use Inmolink\Plugin\Cache\Cache;
use Inmolink\Plugin\Listings;
use Inmolink\Plugin\Mirror\Mirror;
use Inmolink\Plugin\Renderer;
use Inmolink\Plugin\Tests\TestCase;

/**
 * Search pages from the transient cache and detail pages from the mirror table, served stale when the API is down.
 */
final class StaleFallbackTest extends TestCase {

	/**
	 * Makes every cached search answer due for revalidation.
	 *
	 * @param array<string,mixed> $args Search arguments.
	 */
	private function expire_search( array $args ): void {
		$key   = Cache::key( '/v2/listings', Listings::search_query( $args ) );
		$entry = get_transient( $key );
		$this->assertIsArray( $entry, 'the search was cached' );
		$entry['fetched_at']  = time() - HOUR_IN_SECONDS;
		$entry['fresh_until'] = time() - 1;
		set_transient( $key, $entry, DAY_IN_SECONDS );
	}

	/**
	 * [S8-03] With the API unreachable, a cached search page still renders.
	 */
	public function test_s8_03_cached_search_page_renders_when_api_unreachable(): void {
		$this->api->on( '/v2/listings', array( 'fixture' => 'listings.search.json' ) );
		$args = array( 'transaction' => 'SALE' );

		$online = Renderer::from_settings()->search( $args );
		$this->assertStringContainsString( 'Villa Sol', $online );
		$this->assertStringContainsString( 'Casa Luna', $online );

		$this->expire_search( $args );
		$this->api->down();

		$offline = Renderer::from_settings()->search( $args );
		$this->assertSame( $online, $offline, 'the stale page renders exactly as the cached one' );
		$this->assertCount( 2, $this->api->requests_to( '/v2/listings' ), 'the expired copy was revalidated first' );

		$result = Listings::from_settings()->search( $args );
		$this->assertNotNull( $result );
		$this->assertTrue( $result->stale );
	}

	/**
	 * [S8-03] With the API unreachable, a mirrored detail page still renders.
	 */
	public function test_s8_03_mirrored_detail_page_renders_when_api_unreachable(): void {
		$this->api->on( '/v2/listings/INM-1001', array( 'fixture' => 'listing.INM-1001.json' ) );

		$online = Renderer::from_settings()->detail( 'INM-1001' );
		$this->assertStringContainsString( 'Villa Sol', $online );
		$this->assertStringContainsString( 'South-facing with sea views.', $online );
		$this->assertNotNull( ( new Mirror() )->find( 'INM-1001', 'en' ), 'the detail was mirrored' );

		$this->age_mirror();
		$this->api->down();

		$offline = Renderer::from_settings()->detail( 'INM-1001' );
		$this->assertSame( $online, $offline );
		$this->assertStringNotContainsString( 'no longer available', $offline );
	}

	/**
	 * [S8-03] A fresh mirror row renders without calling the API at all.
	 */
	public function test_s8_03_fresh_mirror_row_needs_no_api_call(): void {
		$this->api->on( '/v2/listings/INM-1002', array( 'fixture' => 'listing.INM-1002.json' ) );
		Renderer::from_settings()->detail( 'INM-1002' );
		$this->api->down();

		$html = Renderer::from_settings()->detail( 'INM-1002' );
		$this->assertStringContainsString( 'Casa Luna', $html );
		$this->assertCount( 1, $this->api->requests_to( '/v2/listings/INM-1002' ) );
	}

	/**
	 * [S8-03] Nothing cached and the API unreachable: an empty state, never an API error.
	 */
	public function test_s8_03_no_cache_and_api_down_shows_empty_state_not_error(): void {
		$this->api->down();
		$search = Renderer::from_settings()->search( array() );
		$detail = Renderer::from_settings()->detail( 'INM-1001' );

		$this->assertStringContainsString( 'No properties found.', $search );
		$this->assertStringContainsString( 'no longer available', $detail );
		foreach ( array( $search, $detail ) as $html ) {
			$this->assertStringNotContainsString( 'cURL', $html );
			$this->assertStringNotContainsString( 'api.inmolink.test', $html );
		}
	}

	/**
	 * [S8-03] Revalidation sends If-None-Match; a 304 keeps the cached copy and makes it fresh again.
	 */
	public function test_s8_03_revalidates_with_etag_and_304(): void {
		$this->api->on( '/v2/listings', array( 'fixture' => 'listings.search.json' ) );
		$args = array( 'sort' => 'price_asc' );
		Listings::from_settings()->search( $args );
		$this->expire_search( $args );

		$result   = Listings::from_settings()->search( $args );
		$requests = $this->api->requests_to( '/v2/listings' );

		$this->assertCount( 2, $requests );
		$this->assertArrayNotHasKey( 'if-none-match', $requests[0]['headers'] );
		$this->assertMatchesRegularExpression( '/^"[0-9a-f]{40}"$/', $requests[1]['headers']['if-none-match'] );
		$this->assertNotNull( $result );
		$this->assertFalse( $result->stale );
		$this->assertSame( 2, $result->body['total'] );

		Listings::from_settings()->search( $args );
		$this->assertCount( 2, $this->api->requests_to( '/v2/listings' ), 'fresh again after the 304' );
	}

	/**
	 * [S8-03] After a failure the API is left alone for a minute: visitors do not wait for timeouts.
	 */
	public function test_s8_03_backs_off_after_a_failure(): void {
		$this->api->on( '/v2/listings/INM-1001', array( 'status' => 503 ) );
		$this->assertNull( Listings::from_settings()->detail( 'INM-1001' ) );
		$this->assertTrue( Client::in_backoff() );

		Listings::from_settings()->detail( 'INM-1001' );
		Listings::from_settings()->search( array() );
		$this->assertCount( 1, $this->api->requests, 'no call during the back-off' );
	}

	/**
	 * [S8-03] A rejected key (401/403) also backs off, so feed-api is not hammered with it on every page view.
	 */
	public function test_s8_03_backs_off_after_a_rejected_key(): void {
		$this->api->on( '/v2/listings', array( 'status' => 401 ) );
		$this->assertNull( Listings::from_settings()->search( array() ) );
		$this->assertTrue( Client::in_backoff() );
	}

	/**
	 * [S8-03] Free-text searches are cached for the TTL only, not kept for the stale window.
	 */
	public function test_s8_03_free_text_search_not_kept_stale(): void {
		$this->api->on( '/v2/listings', array( 'fixture' => 'listings.search.json' ) );
		Listings::from_settings()->search( array( 'q' => 'villa' ) );
		Listings::from_settings()->search( array() );

		$free      = (int) get_option( '_transient_timeout_' . Cache::key( '/v2/listings', Listings::search_query( array( 'q' => 'villa' ) ) ) );
		$canonical = (int) get_option( '_transient_timeout_' . Cache::key( '/v2/listings', Listings::search_query( array() ) ) );
		$this->assertLessThanOrEqual( time() + 300, $free );
		$this->assertGreaterThan( time() + DAY_IN_SECONDS, $canonical );
	}

	/**
	 * [S8-03] A 404 removes the mirrored copy: a withdrawn listing is not served from cache.
	 */
	public function test_s8_03_not_found_removes_mirror_row(): void {
		$this->api->on( '/v2/listings/INM-1003', array( 'fixture' => 'listing.INM-1003.json' ) );
		Listings::from_settings()->detail( 'INM-1003' );
		$this->age_mirror();
		$this->api->on( '/v2/listings/INM-1003', array( 'status' => 404 ) );

		$this->assertNull( Listings::from_settings()->detail( 'INM-1003' ) );
		$this->assertNull( ( new Mirror() )->find( 'INM-1003', 'en' ) );
	}

	/**
	 * [S8-03] The secret key goes in the X-Api-Key header, never in the URL; search filters are sanitized.
	 */
	public function test_s8_03_key_in_header_and_query_sanitized(): void {
		$this->api->on( '/v2/listings', array( 'fixture' => 'listings.search.json' ) );
		Listings::from_settings()->search(
			array(
				'transaction' => 'SALE',
				'types'       => '4f2b7e96-0a5c-4d4e-9e5b-5d6c7b8a9f04,not-a-uuid',
				'bedsMin'     => '99',
				'sort'        => 'DROP TABLE',
				'q'           => '<script>x</script>villa',
				'evil'        => 'x',
			)
		);
		$request = $this->api->requests[0];

		$this->assertSame( self::KEY, $request['headers']['x-api-key'] );
		$this->assertStringNotContainsString( self::KEY, wp_json_encode( $request['query'] ) );
		$this->assertSame(
			array(
				'bedsMin'     => '50',
				'lang'        => 'en',
				'q'           => 'villa',
				'transaction' => 'SALE',
				'types'       => '4f2b7e96-0a5c-4d4e-9e5b-5d6c7b8a9f04',
			),
			$request['query']
		);
	}
}
