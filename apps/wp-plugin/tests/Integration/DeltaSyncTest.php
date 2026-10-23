<?php
/**
 * Acceptance: delta sync applies changes idempotently.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\Tests\Integration;

use Inmolink\Plugin\Api\Client;
use Inmolink\Plugin\Cache\Cache;
use Inmolink\Plugin\Mirror\Mirror;
use Inmolink\Plugin\Settings;
use Inmolink\Plugin\Sync\DeltaSync;
use Inmolink\Plugin\Tests\FakeApi;
use Inmolink\Plugin\Tests\TestCase;

/**
 * `/v2/changes` → mirror table.
 */
final class DeltaSyncTest extends TestCase {

	/**
	 * The change feed: `since` → page 1 (more), `cur_p1` → page 2 (REMOVEs), `cur_p2` → nothing new.
	 */
	private function feed(): void {
		$this->api->on(
			'/v2/changes',
			static function ( array $query ): array {
				$cursor = $query['cursor'] ?? null;
				if ( null === $cursor ) {
					return array( 'fixture' => 'changes.page1.json' );
				}
				return array( 'fixture' => 'cur_p1' === $cursor ? 'changes.page2.json' : 'changes.empty.json' );
			}
		);
		foreach ( array( 'INM-1001', 'INM-1002', 'INM-1003' ) as $ref ) {
			$this->api->on( '/v2/listings/' . $ref, array( 'fixture' => 'listing.' . $ref . '.json' ) );
		}
	}

	/**
	 * A sync with a test-friendly budget.
	 */
	private function sync(): DeltaSync {
		return new DeltaSync( new Client( FakeApi::BASE, self::KEY, Client::SYNC_TIMEOUT ), new Mirror() );
	}

	/**
	 * Mirror state as (ref, lang) => title.
	 *
	 * @return array<string,string>
	 */
	private function titles(): array {
		$out = array();
		foreach ( ( new Mirror() )->snapshot() as $row ) {
			$found                                    = ( new Mirror() )->find( $row['ref'], $row['lang'] );
			$out[ $row['ref'] . '|' . $row['lang'] ] = (string) $found['payload']['title'];
		}
		return $out;
	}

	/**
	 * [S8-03] Delta sync applies changes idempotently: running it twice gives the same state.
	 */
	public function test_s8_03_delta_sync_applies_changes_idempotently(): void {
		$this->feed();

		$first = $this->sync()->run();
		$this->assertSame( 'ok', $first['status'] );
		$this->assertSame( 2, $first['pages'] );
		$state_after_first = ( new Mirror() )->snapshot();
		$this->assertSame(
			array(
				'INM-1001|en' => 'Villa Sol',
				'INM-1002|en' => 'Casa Luna',
			),
			$this->titles(),
			'UPSERTs mirrored, the later REMOVE of INM-1003 applied, the unknown REMOVE ignored'
		);
		$this->assertSame( 'cur_p2', DeltaSync::state()['cursor'] );

		$second = $this->sync()->run();
		$this->assertSame( 'ok', $second['status'] );
		$this->assertSame( $state_after_first, ( new Mirror() )->snapshot(), 'a second run changes nothing' );

		// Replaying the whole feed from the start (cursor lost) also lands in the same state.
		$state           = DeltaSync::state();
		$state['cursor'] = null;
		update_option( DeltaSync::STATE_OPTION, $state, false );
		$this->assertSame( 'ok', $this->sync()->run()['status'] );
		$this->assertSame( $state_after_first, ( new Mirror() )->snapshot(), 'a replay changes nothing' );
	}

	/**
	 * [S8-03] Each reference is fetched once per page (last change wins) and refetches are conditional.
	 */
	public function test_s8_03_dedupes_a_page_and_revalidates_with_etag(): void {
		$this->feed();
		$this->sync()->run();
		$this->assertCount( 1, $this->api->requests_to( '/v2/listings/INM-1001' ), 'INM-1001 appears twice on page 1' );

		$state           = DeltaSync::state();
		$state['cursor'] = null;
		update_option( DeltaSync::STATE_OPTION, $state, false );
		$this->sync()->run();

		$again = $this->api->requests_to( '/v2/listings/INM-1001' );
		$this->assertCount( 2, $again );
		$this->assertArrayHasKey( 'if-none-match', $again[1]['headers'], 'the replay asks with the stored ETag (304)' );
	}

	/**
	 * [S8-03] The first run starts with `since`; later runs continue from the persisted cursor.
	 */
	public function test_s8_03_cursor_persisted_between_runs(): void {
		$this->feed();
		$this->sync()->run();
		$this->sync()->run();

		$calls = $this->api->requests_to( '/v2/changes' );
		$this->assertArrayHasKey( 'since', $calls[0]['query'] );
		$this->assertArrayNotHasKey( 'cursor', $calls[0]['query'] );
		$this->assertSame( 'cur_p1', $calls[1]['query']['cursor'] );
		$this->assertSame( 'cur_p2', $calls[2]['query']['cursor'] );
		$this->assertArrayNotHasKey( 'since', $calls[2]['query'] );
	}

	/**
	 * [S8-03] An UPSERT refreshes the mirrored detail with the current version.
	 */
	public function test_s8_03_upsert_refreshes_content(): void {
		$this->feed();
		$this->sync()->run();
		$this->api->on( '/v2/listings/INM-1001', array( 'fixture' => 'listing.INM-1001.v2.json' ) );
		$this->api->on(
			'/v2/changes',
			static fn (): array => array(
				'body' => array(
					'items'      => array(
						array(
							'ref'       => 'INM-1001',
							'kind'      => 'LISTING',
							'change'    => 'UPSERT',
							'changedAt' => '2026-10-23T10:00:00.000Z',
						),
					),
					'nextCursor' => 'cur_p3',
					'hasMore'    => false,
					'scope'      => 'scope_a',
				),
			)
		);

		$this->sync()->run();
		$this->assertSame( 'Villa Sol Renovated', $this->titles()['INM-1001|en'] );
		$this->assertSame( 'cur_p3', DeltaSync::state()['cursor'] );
	}

	/**
	 * [S8-03] A page that fails midway keeps its cursor and is replayed next run, ending in the same state.
	 */
	public function test_s8_03_failed_page_is_replayed_not_skipped(): void {
		$this->feed();
		$this->api->on( '/v2/listings/INM-1002', array( 'status' => 500 ) );

		$failed = $this->sync()->run();
		$this->assertSame( 'failed', $failed['status'] );
		$this->assertNull( DeltaSync::state()['cursor'], 'page 1 not acknowledged' );
		$this->assertSame( 'page_incomplete', DeltaSync::state()['last_error'] );

		Client::reset_backoff();
		$this->api->on( '/v2/listings/INM-1002', array( 'fixture' => 'listing.INM-1002.json' ) );
		$this->assertSame( 'ok', $this->sync()->run()['status'] );
		$this->assertSame(
			array(
				'INM-1001|en' => 'Villa Sol',
				'INM-1002|en' => 'Casa Luna',
			),
			$this->titles()
		);
		$this->assertSame( 'cur_p2', DeltaSync::state()['cursor'] );
	}

	/**
	 * [S8-03] Every configured locale is mirrored.
	 */
	public function test_s8_03_mirrors_each_locale(): void {
		Settings::save(
			array(
				'api_base'       => FakeApi::BASE,
				'locales'        => 'en,es',
				'default_locale' => 'en',
			)
		);
		$this->feed();
		$this->sync()->run();

		$langs = array_map( static fn ( array $q ): string => $q['query']['lang'], $this->api->requests_to( '/v2/listings/INM-1002' ) );
		sort( $langs );
		$this->assertSame( array( 'en', 'es' ), $langs );
		$this->assertArrayHasKey( 'INM-1002|es', $this->titles() );
	}

	/**
	 * [S8-03] A scope change invalidates the search cache and prunes the mirror to the sitemap.
	 */
	public function test_s8_03_scope_change_rebuilds_from_sitemap(): void {
		$this->feed();
		$this->sync()->run();
		$generation = (int) get_option( Cache::GENERATION_OPTION, 1 );
		$this->age_mirror();

		$this->api->on( '/v2/changes', array( 'fixture' => 'changes.rescoped.json' ) );
		$this->api->on( '/v2/sitemap', array( 'fixture' => 'sitemap.page.json' ) );
		$result = $this->sync()->run();

		$this->assertSame( 'ok', $result['status'] );
		$this->assertSame( array( 'INM-1001|en' ), array_keys( $this->titles() ), 'INM-1002 is not in the sitemap any more' );
		$this->assertSame( $generation + 1, (int) get_option( Cache::GENERATION_OPTION, 1 ) );
		$this->assertSame( 'scope_b', DeltaSync::state()['scope'] );
		$this->assertNull( DeltaSync::state()['rebuild'] );
	}

	/**
	 * [S8-03] One run at a time; an expired lock is taken over.
	 */
	public function test_s8_03_runs_are_locked(): void {
		$this->feed();
		add_option( DeltaSync::LOCK_OPTION, time() + 300, '', false );
		$this->assertSame( 'locked', $this->sync()->run()['status'] );
		$this->assertSame( array(), $this->api->requests );

		update_option( DeltaSync::LOCK_OPTION, time() - 1, false );
		$this->assertSame( 'ok', $this->sync()->run()['status'] );
		$this->assertFalse( get_option( DeltaSync::LOCK_OPTION ), 'released after the run' );
	}

	/**
	 * [S8-03] The sync runs on WP-Cron every five minutes.
	 */
	public function test_s8_03_scheduled_on_wp_cron(): void {
		$this->assertNotFalse( wp_next_scheduled( DeltaSync::HOOK ) );
		$this->assertSame( DeltaSync::SCHEDULE, wp_get_schedule( DeltaSync::HOOK ) );
		$this->assertSame( 300, wp_get_schedules()[ DeltaSync::SCHEDULE ]['interval'] );
		$this->assertTrue( has_action( DeltaSync::HOOK ) > 0 );
	}

	/**
	 * [S8-03] An expired cursor (410 CHANGES_EXPIRED) restarts from `since` and rebuilds from the sitemap.
	 */
	public function test_s8_03_expired_cursor_restarts_and_rebuilds(): void {
		$this->feed();
		$this->sync()->run();
		$this->api->on(
			'/v2/changes',
			static fn ( array $query ): array => isset( $query['cursor'] )
				? array(
					'status' => 410,
					'body'   => array( 'code' => 'CHANGES_EXPIRED' ),
				)
				: array( 'fixture' => 'changes.empty.json' )
		);
		$this->api->on( '/v2/sitemap', array( 'fixture' => 'sitemap.page.json' ) );

		$result = $this->sync()->run();
		$calls  = $this->api->requests_to( '/v2/changes' );
		$last   = end( $calls );

		$this->assertSame( 'ok', $result['status'] );
		$this->assertArrayHasKey( 'since', $last['query'] );
		$this->assertSame( 'cur_p2', DeltaSync::state()['cursor'] );
		$this->assertSame( array( 'INM-1001|en' ), array_keys( $this->titles() ), 'rebuilt against the sitemap' );
		$this->assertLessThan( time() - DAY_IN_SECONDS, ( new Mirror() )->find( 'INM-1001', 'en' )['fetched_at'], 'kept rows are revalidated on view' );
	}

	/**
	 * [S8-03] A page that runs out of time is replayed with half the page size, so the feed keeps moving.
	 */
	public function test_s8_03_unfinished_page_is_retried_smaller(): void {
		$this->feed();
		$out_of_time = new DeltaSync( new Client( FakeApi::BASE, self::KEY, Client::SYNC_TIMEOUT ), new Mirror(), 20, 0 );
		$this->assertSame( 'failed', $out_of_time->run()['status'] );
		$this->assertSame( 2, DeltaSync::state()['limit'] );
		$this->assertNull( DeltaSync::state()['cursor'] );

		$this->sync()->run();
		$calls = $this->api->requests_to( '/v2/changes' );
		$this->assertSame( '2', $calls[1]['query']['limit'], 'the replay asks for the smaller page' );
		$this->assertSame( DeltaSync::PAGE_LIMIT, DeltaSync::state()['limit'], 'back to full pages after a success' );
	}

	/**
	 * [S8-03] A detail the API refuses with a 4xx is dropped instead of blocking the feed.
	 */
	public function test_s8_03_refused_detail_does_not_block_the_feed(): void {
		$this->feed();
		$this->api->on( '/v2/listings/INM-1002', array( 'status' => 400 ) );
		$this->assertSame( 'ok', $this->sync()->run()['status'] );
		$this->assertSame( array( 'INM-1001|en' ), array_keys( $this->titles() ) );
		$this->assertSame( 'cur_p2', DeltaSync::state()['cursor'] );
	}

	/**
	 * [S8-03] A REMOVE after an UPSERT of the same reference on one page wins.
	 */
	public function test_s8_03_last_change_on_a_page_wins(): void {
		$this->feed();
		$this->api->on(
			'/v2/changes',
			static fn (): array => array(
				'body' => array(
					'items'      => array(
						array(
							'ref'       => 'INM-1001',
							'kind'      => 'LISTING',
							'change'    => 'UPSERT',
							'changedAt' => '2026-10-23T10:00:00.000Z',
						),
						array(
							'ref'       => 'INM-1001',
							'kind'      => 'LISTING',
							'change'    => 'REMOVE',
							'changedAt' => '2026-10-23T10:00:01.000Z',
						),
					),
					'nextCursor' => 'cur_x',
					'hasMore'    => false,
					'scope'      => 'scope_a',
				),
			)
		);
		$this->sync()->run();
		$this->assertSame( array(), $this->titles() );
		$this->assertSame( array(), $this->api->requests_to( '/v2/listings/INM-1001' ), 'no fetch for a removed ref' );
	}

	/**
	 * [S8-03] Removing a locale in the settings prunes its mirrored rows.
	 */
	public function test_s8_03_removed_locale_is_pruned(): void {
		$mirror = new Mirror();
		$mirror->upsert( 'INM-1001', 'en', array( 'title' => 'Villa Sol' ), null );
		$mirror->upsert( 'INM-1001', 'de', array( 'title' => 'Villa Sol' ), null );
		( new \Inmolink\Plugin\Admin\SettingsPage() )->save(
			array(
				'api_base' => FakeApi::BASE,
				'locales'  => 'en',
			)
		);
		$this->assertSame( array( 'INM-1001|en' ), array_keys( $this->titles() ) );
	}
}
