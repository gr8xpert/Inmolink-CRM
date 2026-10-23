<?php
/**
 * Delta sync of the mirror table from `/v2/changes`.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\Sync;

use Inmolink\Plugin\Api\Client;
use Inmolink\Plugin\Api\Response;
use Inmolink\Plugin\Cache\Cache;
use Inmolink\Plugin\Mirror\Mirror;
use Inmolink\Plugin\Settings;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Follows the site's change feed and applies it to the mirror table (WP-Cron every five minutes, or `wp inmolink sync`
 * from a real cron).
 *
 * - The first run starts with `since` (now minus a small overlap); every later run continues from the persisted cursor,
 *   which the API guarantees yields every change exactly once, in commit order.
 * - A page's changes are applied, then its `nextCursor` is saved. If a page cannot be applied completely (the API fails
 *   mid-page, the run's time budget ends) the cursor stays put and the page is replayed next run.
 * - Every write is idempotent: REMOVE deletes the reference's rows; UPSERT re-fetches the detail in each configured
 *   locale (conditionally, with the row's ETag) and upserts it — or deletes it on 404. Replaying a page, or running
 *   twice, ends in the same state.
 * - When the page's `scope` differs from the last one the site's selection changed as a whole: the search cache is
 *   invalidated and the mirror is rebuilt against `/v2/sitemap` (mark the references still listed, sweep the rest),
 *   a few pages per run.
 * - One run at a time (an option-based lock with expiry).
 */
class DeltaSync {

	public const HOOK         = 'inmolink_delta_sync';
	public const SCHEDULE     = 'inmolink_five_minutes';
	public const STATE_OPTION = 'inmolink_sync_state';
	public const LOCK_OPTION  = 'inmolink_sync_lock';
	public const LOCK_TTL     = 600;
	/** Seconds the first run looks back (changes shortly before `since` may be included anyway). */
	public const FIRST_RUN_OVERLAP = 300;
	public const PAGE_LIMIT        = 100;
	public const SITEMAP_LIMIT     = 500;
	private const REF              = \Inmolink\Plugin\Listings::REF_PATTERN;

	/**
	 * Creates the sync.
	 *
	 * @param Client $client      API client (background timeout).
	 * @param Mirror $mirror      Mirror table.
	 * @param int    $max_pages   Change pages per run.
	 * @param int    $time_budget Seconds per run.
	 */
	public function __construct(
		private readonly Client $client,
		private readonly Mirror $mirror,
		private readonly int $max_pages = 20,
		private readonly int $time_budget = 50
	) {}

	/**
	 * The sync wired from the settings. The time budget stays 10 s under PHP's `max_execution_time`, so a run ends
	 * (and releases its lock) before PHP kills it.
	 */
	public static function from_settings(): self {
		$limit  = (int) ini_get( 'max_execution_time' );
		$budget = $limit > 0 ? max( 5, min( 50, $limit - 10 ) ) : 50;
		return new self( Client::from_settings( Client::SYNC_TIMEOUT ), new Mirror(), 20, $budget );
	}

	/**
	 * The persisted state.
	 *
	 * @return array{cursor:?string,scope:?string,last_run:int,last_success:int,last_error:string,applied:int,rebuild:?array{cursor:?string,sweep:int,started:int},limit:int}
	 */
	public static function state(): array {
		$stored   = get_option( self::STATE_OPTION, array() );
		$stored   = is_array( $stored ) ? $stored : array();
		$defaults = array(
			'cursor'       => null,
			'scope'        => null,
			'last_run'     => 0,
			'last_success' => 0,
			'last_error'   => '',
			'applied'      => 0,
			'rebuild'      => null,
			'limit'        => self::PAGE_LIMIT,
		);
		return array_merge( $defaults, array_intersect_key( $stored, $defaults ) );
	}

	/**
	 * Saves the state (autoload off).
	 *
	 * @param array<string,mixed> $state State.
	 */
	private static function save_state( array $state ): void {
		update_option( self::STATE_OPTION, $state, false );
	}

	/**
	 * Forgets the cursor and scope (a new API key or site): the next run starts over.
	 */
	public static function reset(): void {
		delete_option( self::STATE_OPTION );
	}

	/**
	 * One sync run.
	 *
	 * @return array{status:string,pages:int,applied:int} `status` is ok, locked, not_configured or failed.
	 */
	public function run(): array {
		if ( ! Settings::is_configured() ) {
			return array(
				'status'  => 'not_configured',
				'pages'   => 0,
				'applied' => 0,
			);
		}
		if ( ! $this->lock() ) {
			return array(
				'status'  => 'locked',
				'pages'   => 0,
				'applied' => 0,
			);
		}
		try {
			return $this->run_locked();
		} finally {
			delete_option( self::LOCK_OPTION );
		}
	}

	/**
	 * The run, under the lock.
	 *
	 * @return array{status:string,pages:int,applied:int}
	 */
	private function run_locked(): array {
		$state             = self::state();
		$state['last_run'] = time();
		$deadline          = time() + $this->time_budget;
		$locales           = (array) Settings::get( 'locales' );
		$pages             = 0;
		$applied           = 0;
		$error             = '';

		// No saved scope but rows already mirrored (state lost, plugin re-activated): changes since then are unknown.
		if ( null === $state['scope'] && null === $state['rebuild'] && $this->mirror->count() > 0 ) {
			$this->start_rebuild( $state, true );
		}

		while ( $pages < $this->max_pages ) {
			$query = null === $state['cursor']
				? array( 'since' => gmdate( 'Y-m-d\TH:i:s\Z', time() - self::FIRST_RUN_OVERLAP ) )
				: array( 'cursor' => $state['cursor'] );

			$query['limit'] = max( 1, min( self::PAGE_LIMIT, (int) $state['limit'] ) );
			$response       = $this->client->get( '/v2/changes', $query );

			if ( 410 === $response->status && null !== $state['cursor'] ) {
				// CHANGES_EXPIRED: the cursor is older than the change log. Start again from now and rebuild from the
				// sitemap (rows kept are revalidated on view).
				$state['cursor'] = null;
				$this->start_rebuild( $state, true );
				self::save_state( $state );
				continue;
			}

			$page = $response->ok() ? self::parse_page( $response->body ) : null;
			if ( null === $page ) {
				$error = $response->ok() ? 'invalid_page' : ( '' !== $response->error ? $response->error : 'http_' . $response->status );
				break;
			}

			if ( null !== $state['scope'] && $page['scope'] !== $state['scope'] ) {
				$this->start_rebuild( $state, false );
			}
			$state['scope'] = $page['scope'];

			$done = $this->apply( $page['items'], $locales, $deadline );
			if ( null === $done ) {
				// Replayed next run with half the page, so a slow host or a large page still moves forward.
				$error          = 'page_incomplete';
				$state['limit'] = max( 1, intdiv( count( $page['items'] ), 2 ) );
				self::save_state( $state );
				break;
			}
			$applied         += $done;
			$state['limit']   = self::PAGE_LIMIT;
			$state['cursor']  = $page['nextCursor'];
			$state['applied'] = (int) $state['applied'] + $done;
			self::save_state( $state );
			++$pages;

			if ( ! $page['hasMore'] || time() >= $deadline ) {
				break;
			}
		}

		if ( '' === $error && null !== $state['rebuild'] ) {
			$error = $this->rebuild_step( $state, $locales, $deadline );
		}

		$state['last_error'] = $error;
		if ( '' === $error ) {
			$state['last_success'] = time();
		}
		self::save_state( $state );

		return array(
			'status'  => '' === $error ? 'ok' : 'failed',
			'pages'   => $pages,
			'applied' => $applied,
		);
	}

	/**
	 * Starts a mirror rebuild against the sitemap and invalidates the search cache.
	 *
	 * @param array<string,mixed> $state      State (updated in place).
	 * @param bool                $revalidate Also mark every row for revalidation on view (changes were missed).
	 */
	private function start_rebuild( array &$state, bool $revalidate ): void {
		$state['rebuild'] = array(
			'cursor'  => null,
			'sweep'   => self::sweep_number( $state ),
			'started' => time(),
		);
		if ( $revalidate ) {
			$this->mirror->expire_all();
		}
		Cache::flush();
	}

	/**
	 * Applies one page of changes. The last change of each reference wins (the page is in commit order).
	 *
	 * @param list<array{ref:string,kind:string,change:string,changedAt:string}> $items    Changes.
	 * @param string[]                                                           $locales  Locales mirrored.
	 * @param int                                                                $deadline Unix time the run must end.
	 * @return int|null Changes applied, or null when the page could not be applied completely.
	 */
	private function apply( array $items, array $locales, int $deadline ): ?int {
		$last = array();
		foreach ( $items as $item ) {
			unset( $last[ $item['ref'] ] );
			$last[ $item['ref'] ] = $item;
		}

		foreach ( $last as $item ) {
			if ( time() >= $deadline ) {
				return null;
			}
			if ( 'REMOVE' === $item['change'] ) {
				$this->mirror->delete( $item['ref'] );
				continue;
			}
			foreach ( $locales as $lang ) {
				if ( ! $this->refresh( $item['ref'], $lang, $item['changedAt'] ) ) {
					return null;
				}
			}
		}
		return count( $last );
	}

	/**
	 * Re-fetches one detail into the mirror.
	 *
	 * @param string      $ref        Reference.
	 * @param string      $lang       Locale.
	 * @param string|null $changed_at The change's time.
	 * @return bool False when the API failed (the page must be replayed).
	 */
	private function refresh( string $ref, string $lang, ?string $changed_at ): bool {
		$row      = $this->mirror->find( $ref, $lang );
		$response = $this->client->get( '/v2/listings/' . rawurlencode( $ref ), array( 'lang' => $lang ), $row['etag'] ?? null );
		if ( $response->ok() ) {
			$this->mirror->upsert( $ref, $lang, $response->body, $response->etag, $changed_at );
			return true;
		}
		if ( Response::NOT_MODIFIED === $response->kind ) {
			if ( null !== $row ) {
				$this->mirror->touch( $ref, $lang );
			}
			return true;
		}
		if ( Response::NOT_FOUND === $response->kind ) {
			$this->mirror->delete( $ref, $lang );
			return true;
		}
		if ( $response->status >= 400 && $response->status < 500 && ! in_array( $response->status, array( 401, 403, 408, 429 ), true ) ) {
			// The API will not serve this reference (e.g. 400 on an odd ref): drop it rather than block the feed.
			$this->mirror->delete( $ref, $lang );
			return true;
		}
		return false;
	}

	/**
	 * A few sitemap pages of the scope rebuild: marks the references still on the site; at the end sweeps the rest.
	 *
	 * @param array<string,mixed> $state    State (updated in place).
	 * @param string[]            $locales  Locales mirrored.
	 * @param int                 $deadline Unix time the run must end.
	 * @return string Error, or ''.
	 */
	private function rebuild_step( array &$state, array $locales, int $deadline ): string {
		$rebuild = $state['rebuild'];
		$lang    = (string) ( $locales[0] ?? Settings::get( 'default_locale' ) );
		do {
			$query = array(
				'lang'  => $lang,
				'limit' => self::SITEMAP_LIMIT,
			);
			if ( null !== $rebuild['cursor'] ) {
				$query['cursor'] = $rebuild['cursor'];
			}
			$response = $this->client->get( '/v2/sitemap', $query );
			$body     = $response->ok() ? $response->body : null;
			if ( null === $body || ! isset( $body['items'] ) || ! is_array( $body['items'] ) ) {
				return 'rebuild_' . ( '' !== $response->error ? $response->error : 'invalid_page' );
			}
			$refs = array();
			foreach ( $body['items'] as $entry ) {
				if ( is_array( $entry ) && isset( $entry['ref'] ) && is_string( $entry['ref'] ) ) {
					$refs[] = $entry['ref'];
				}
			}
			$this->mirror->mark( $refs, (int) $rebuild['sweep'] );
			$next              = isset( $body['nextCursor'] ) && is_string( $body['nextCursor'] ) ? $body['nextCursor'] : null;
			$rebuild['cursor'] = $next;
			$state['rebuild']  = $rebuild;
			self::save_state( $state );
			if ( null === $next ) {
				$this->mirror->sweep( (int) $rebuild['sweep'], (int) ( $rebuild['started'] ?? time() ) );
				$state['rebuild'] = null;
				return '';
			}
		} while ( time() < $deadline );
		return '';
	}

	/**
	 * A sweep number different from the rows' current one.
	 *
	 * @param array<string,mixed> $state State.
	 */
	private static function sweep_number( array $state ): int {
		$previous = is_array( $state['rebuild'] ) ? (int) $state['rebuild']['sweep'] : 0;
		return max( $previous + 1, time() % 2000000000 );
	}

	/**
	 * Validates a `/v2/changes` page (contract `WebsiteChangesPage`); invalid entries are skipped.
	 *
	 * @param array<string,mixed>|null $body Body.
	 * @return array{items:list<array{ref:string,kind:string,change:string,changedAt:string}>,nextCursor:string,hasMore:bool,scope:string}|null
	 */
	public static function parse_page( ?array $body ): ?array {
		if ( null === $body || ! isset( $body['items'], $body['nextCursor'], $body['hasMore'], $body['scope'] )
			|| ! is_array( $body['items'] ) || ! is_string( $body['nextCursor'] ) || ! is_bool( $body['hasMore'] ) || ! is_string( $body['scope'] ) ) {
			return null;
		}
		$items = array();
		foreach ( $body['items'] as $item ) {
			if ( ! is_array( $item ) || ! isset( $item['ref'], $item['change'], $item['changedAt'] ) || ! is_string( $item['ref'] )
				|| ! preg_match( self::REF, $item['ref'] ) || ! in_array( $item['change'], array( 'UPSERT', 'REMOVE' ), true ) ) {
				continue;
			}
			$items[] = array(
				'ref'       => $item['ref'],
				'kind'      => isset( $item['kind'] ) && is_string( $item['kind'] ) ? $item['kind'] : 'LISTING',
				'change'    => $item['change'],
				'changedAt' => (string) $item['changedAt'],
			);
		}
		return array(
			'items'      => $items,
			'nextCursor' => $body['nextCursor'],
			'hasMore'    => $body['hasMore'],
			'scope'      => $body['scope'],
		);
	}

	/**
	 * Takes the run lock; an expired lock (a crashed run) is taken over.
	 */
	private function lock(): bool {
		if ( add_option( self::LOCK_OPTION, time() + self::LOCK_TTL, '', false ) ) {
			return true;
		}
		$until = (int) get_option( self::LOCK_OPTION, 0 );
		if ( $until > time() ) {
			return false;
		}
		delete_option( self::LOCK_OPTION );
		return add_option( self::LOCK_OPTION, time() + self::LOCK_TTL, '', false );
	}
}
