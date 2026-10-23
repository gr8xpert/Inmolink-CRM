<?php
/**
 * S8-F12 / F13 / F14 / F28: bounded cache misses, separate back-offs, previous-generation fallback, API probe.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\Tests\Integration;

use Inmolink\Plugin\Admin\SettingsPage;
use Inmolink\Plugin\Api\Client;
use Inmolink\Plugin\Cache\Cache;
use Inmolink\Plugin\Listings;
use Inmolink\Plugin\Settings;
use Inmolink\Plugin\Tests\FakeApi;
use Inmolink\Plugin\Tests\TestCase;

/**
 * How the plugin behaves when the API is slow, limiting or gone.
 */
final class ResilienceTest extends TestCase {

	/**
	 * [S8-F12] A crawl of random references makes at most CALL_LIMIT API calls per IP; unknown references are remembered.
	 */
	public function test_s8_f12_random_ref_crawl_is_bounded_per_ip(): void {
		add_filter( 'inmolink_api_caller_ip', static fn () => '203.0.113.50' );
		$listings = Listings::from_settings();
		for ( $i = 0; $i < Client::CALL_LIMIT * 3; $i++ ) {
			$this->assertNull( $listings->detail( 'RANDOM-' . $i ) );
		}
		$this->assertLessThanOrEqual( Client::CALL_LIMIT, count( $this->api->requests ), 'at most the limit reaches the API' );
		$this->assertGreaterThan( 0, count( $this->api->requests ) );

		// A reference that was answered 404 is not asked for again.
		$before = count( $this->api->requests );
		$listings->detail( 'RANDOM-0' );
		$this->assertSame( $before, count( $this->api->requests ) );
	}

	/**
	 * [S8-F13] Retry-After on a 429 pauses calls for that long; page views are untouched while sync backs off.
	 */
	public function test_s8_f13_retry_after_and_separate_backoffs(): void {
		$this->api->on(
			'/v2/changes',
			array(
				'status'  => 429,
				'headers' => array( 'retry-after' => '120' ),
			)
		);
		$this->api->on( '/v2/listings', array( 'fixture' => 'listings.search.json' ) );

		$sync = new Client( FakeApi::BASE, self::KEY, Client::SYNC_TIMEOUT, Client::SYNC );
		$this->assertSame( 'http_429', $sync->get( '/v2/changes', array( 'since' => 'x' ) )->error );
		$this->assertTrue( Client::in_backoff( Client::SYNC ) );
		$this->assertFalse( Client::in_backoff( Client::PAGE ), 'page views are not paused' );

		$ttl = (int) get_option( '_transient_timeout_' . Client::DOWN_TRANSIENT . '_' . Client::SYNC ) - time();
		$this->assertGreaterThan( 115, $ttl );
		$this->assertLessThanOrEqual( 120, $ttl, 'paused for the 120 s Retry-After, not the default minute' );

		$calls = count( $this->api->requests );
		$this->assertSame( 'backoff', $sync->get( '/v2/changes', array( 'since' => 'x' ) )->error );
		$this->assertSame( $calls, count( $this->api->requests ), 'no sync call during the pause' );

		$this->assertNotNull( Listings::from_settings()->search( array() ), 'page views still get listings' );
		$this->assertCount( 1, $this->api->requests_to( '/v2/listings' ) );
	}

	/**
	 * [S8-F13] Retry-After forms: seconds, an HTTP date, junk, and the cap; 503 honours it too.
	 */
	public function test_s8_f13_retry_after_parsing(): void {
		$this->assertSame( 120, Client::retry_after( '120' ) );
		$this->assertSame( Client::MAX_RETRY_AFTER, Client::retry_after( '99999999' ) );
		$this->assertSame( 0, Client::retry_after( 'soon' ) );
		$this->assertSame( 0, Client::retry_after( '' ) );
		$this->assertSame( 0, Client::retry_after( '-5' ) );
		$date = Client::retry_after( gmdate( 'D, d M Y H:i:s', time() + 300 ) . ' GMT' );
		$this->assertGreaterThan( 290, $date );
		$this->assertLessThanOrEqual( 300, $date );

		$this->api->on(
			'/v2/listings',
			array(
				'status'  => 503,
				'headers' => array( 'retry-after' => '240' ),
			)
		);
		Listings::from_settings()->search( array() );
		$ttl = (int) get_option( '_transient_timeout_' . Client::DOWN_TRANSIENT ) - time();
		$this->assertGreaterThan( 235, $ttl );
		$this->assertFalse( Client::in_backoff( Client::SYNC ), 'a page-view failure leaves sync alone' );
	}

	/**
	 * [S8-F14] After a cache flush with the API down, the last search page still renders (stale), and a later refresh
	 * replaces it.
	 */
	public function test_s8_f14_previous_generation_serves_after_flush(): void {
		$this->api->on( '/v2/listings', array( 'fixture' => 'listings.search.json' ) );
		$first = Listings::from_settings()->search( array() );
		$this->assertNotNull( $first );

		Cache::flush();
		$this->api->down();
		$after = Listings::from_settings()->search( array() );
		$this->assertNotNull( $after, 'flush then API down still renders the last page' );
		$this->assertTrue( $after->stale );
		$this->assertSame( $first->body, $after->body );

		$again = Listings::from_settings()->search( array() ); // Inside the 60 s back-off window.
		$this->assertNotNull( $again );
		$this->assertTrue( $again->stale, 'a fallback copy is never reported fresh' );
		$this->assertCount( 2, $this->api->requests_to( '/v2/listings' ), 'and the API was left alone meanwhile' );

		Cache::flush(); // The copy moved to the current generation, so it survives a second flush as well.
		$this->assertNotNull( Listings::from_settings()->search( array() ) );

		$this->api->down( false );
		Client::reset_backoff();
		delete_transient( Cache::key( '/v2/listings', Listings::search_query( array() ) ) );
		$fresh = Listings::from_settings()->search( array() );
		$this->assertNotNull( $fresh );
		$this->assertFalse( $fresh->stale, 'the first successful refresh replaces the fallback' );
	}

	/**
	 * [S8-F14] The previous generation is stale-only: a healthy API is asked without its ETag, so a 304 cannot
	 * revalidate what the flush invalidated.
	 */
	public function test_s8_f14_previous_generation_is_not_revalidated(): void {
		$this->api->on( '/v2/listings', array( 'fixture' => 'listings.search.json' ) );
		Listings::from_settings()->search( array() );
		Cache::flush();
		Listings::from_settings()->search( array() );
		$requests = $this->api->requests_to( '/v2/listings' );
		$this->assertCount( 2, $requests );
		$this->assertArrayNotHasKey( 'if-none-match', $requests[1]['headers'] );
	}

	/**
	 * [S8-F14] A new API key or URL never leaves the previous agency's answers readable, not even as the fallback.
	 */
	public function test_s8_f14_key_change_drops_the_fallback(): void {
		$this->api->on( '/v2/listings', array( 'fixture' => 'listings.search.json' ) );
		$this->assertNotNull( Listings::from_settings()->search( array() ) );

		( new SettingsPage() )->save(
			array(
				'api_base' => FakeApi::BASE,
				'locales'  => 'en',
				'api_key'  => 'inl_test_skzzzzzzzzzz_abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrst',
			)
		);
		$this->api->down();
		$this->assertNull( Listings::from_settings()->search( array() ), 'API down after the key change: nothing to show' );

		// The same agency rebuilding (a normal flush) still keeps the fallback.
		$this->api->down( false );
		Client::reset_backoff();
		$this->assertNotNull( Listings::from_settings()->search( array() ) );
		Cache::flush();
		$this->api->down();
		Client::reset_backoff();
		$this->assertNotNull( Listings::from_settings()->search( array() ) );
	}

	/**
	 * [S8-F12] Unknown-reference markers are written within a site-wide budget, whatever the number of visitors.
	 */
	public function test_s8_f12_missing_markers_are_bounded_site_wide(): void {
		$n = 0;
		add_filter(
			'inmolink_api_caller_ip',
			static function () use ( &$n ) {
				return '198.51.100.' . ( $n % 250 + 1 ); // A different visitor every call.
			}
		);
		$listings = Listings::from_settings();
		for ( $i = 0; $i < Cache::MISSING_BUDGET + 50; $i++ ) {
			++$n;
			$listings->detail( 'GONE-' . $i );
		}
		global $wpdb;
		$rows = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->options} WHERE option_name LIKE '\_transient\_inmolink\_nf\_%'" ); // phpcs:ignore WordPress.DB
		$this->assertLessThanOrEqual( Cache::MISSING_BUDGET, $rows );
		$this->assertGreaterThan( 0, $rows );
	}

	/**
	 * [S8-F13] While the API asked for quiet (Retry-After), the health probe makes no call; the call limit never
	 * applies to the probe; HTTP dates are parsed strictly.
	 */
	public function test_s8_f13_probe_respects_retry_after_and_skips_call_limit(): void {
		$this->api->on( '/v2/changes', array( 'fixture' => 'changes.empty.json' ) );
		set_transient( Client::DOWN_TRANSIENT . '_' . Client::SYNC, 'retry_after', 120 );
		$this->assertTrue( Client::paused_by_api() );
		$this->assertFalse( Client::reachable() );
		$this->assertCount( 0, $this->api->requests_to( '/v2/changes' ), 'no call during the pause' );

		Client::reset_backoff();
		add_filter( 'inmolink_api_caller_ip', static fn () => '203.0.113.99' );
		for ( $i = 0; $i < Client::CALL_LIMIT; $i++ ) {
			\Inmolink\Plugin\Net\Counter::hit( 'api', '203.0.113.99', MINUTE_IN_SECONDS );
		}
		$this->assertTrue( Client::reachable(), 'the probe is not subject to the per-IP limit' );

		$this->assertSame( 0, Client::retry_after( 'tomorrow' ) );
		$this->assertSame( 0, Client::retry_after( gmdate( 'Y-m-d H:i:s', time() + 300 ) ) );
		$this->assertSame( 0, Client::retry_after( 'Sunday, 06-Nov-94 08:49:37 GMT' ), 'obsolete formats are ignored' );
	}

	/**
	 * [S8-F28] The health page's "API reachable" is a cached probe: it follows an outage and a recovery within one
	 * probe interval, and does not call the API on every view.
	 */
	public function test_s8_f28_probe_follows_the_api_within_one_interval(): void {
		$this->api->on( '/v2/changes', array( 'fixture' => 'changes.empty.json' ) );
		$this->assertTrue( Client::reachable() );
		Client::reachable();
		Client::reachable();
		$this->assertCount( 1, $this->api->requests_to( '/v2/changes' ), 'cached within the interval' );

		$this->api->down();
		$this->assertTrue( Client::reachable(), 'still the cached answer inside the interval' );
		delete_transient( Client::PROBE_TRANSIENT ); // The interval ends.
		$this->assertFalse( Client::reachable() );
		$this->assertFalse( Client::reachable() );
		$this->assertCount( 2, $this->api->requests_to( '/v2/changes' ) );

		$this->api->down( false );
		delete_transient( Client::PROBE_TRANSIENT );
		$this->assertTrue( Client::reachable(), 'recovers at the next probe, not one back-off later' );
	}

	/**
	 * [S8-F28] A page-view back-off does not make the probe say "unreachable" without asking, and an unconfigured
	 * site is unreachable without a call.
	 */
	public function test_s8_f28_probe_ignores_page_backoff_and_unconfigured(): void {
		$this->api->on( '/v2/changes', array( 'fixture' => 'changes.empty.json' ) );
		set_transient( Client::DOWN_TRANSIENT, time(), 60 );
		$this->assertTrue( Client::reachable() );

		delete_transient( Client::PROBE_TRANSIENT );
		Settings::clear_api_key();
		$before = count( $this->api->requests );
		$this->assertFalse( Client::reachable() );
		$this->assertSame( $before, count( $this->api->requests ) );
	}
}
