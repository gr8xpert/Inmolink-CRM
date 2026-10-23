<?php
/**
 * Transient cache for API answers, with a stale fallback.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\Cache;

use Inmolink\Plugin\Api\Client;
use Inmolink\Plugin\Api\Response;
use Inmolink\Plugin\Net\Counter;
use Inmolink\Plugin\Settings;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Caches API answers (search pages, taxonomy …) in transients.
 *
 * One transient per request holds the body, its ETag and when it stops being fresh. The transient itself lives for
 * the stale window (days), so an expired copy is still there to serve when the API is unreachable:
 * - fresh copy → served, no call;
 * - expired copy → revalidated with `If-None-Match` (304 refreshes it, 200 replaces it); if the call fails the
 *   stale copy is served and marked fresh for a short back-off, so a down API is not called on every page view;
 * - no copy and the call fails → null (the template shows an empty state, never an error).
 *
 * Only canonical requests keep a stale copy (`$keep_stale`): free-text searches and deep pages live for the TTL only,
 * so a visitor scripting unique queries cannot fill `wp_options` with week-long entries.
 */
class Cache {

	public const PREFIX = 'inmolink_c_';
	/** Seconds a stale copy is served without asking the API again after a failed call. */
	public const BACKOFF           = 60;
	public const GENERATION_OPTION = 'inmolink_cache_generation';

	/**
	 * Creates a cache over an API client.
	 *
	 * @param Client $client API client.
	 */
	public function __construct( private readonly Client $client ) {}

	/** Unknown-reference markers (transients) one site may write per window, whoever asks. */
	public const MISSING_BUDGET = 200;
	public const MISSING_WINDOW = 300;
	/** A documentation address standing for the whole site ({@see Counter} keys its counters by IP bucket). */
	private const SITE_BUCKET = '192.0.2.1';

	/**
	 * Whether another "unknown reference" marker may be stored now: a site-wide budget, so a crawl from many addresses
	 * cannot grow `wp_options` (past it, unknown references simply cost an API call, which the per-IP limit bounds).
	 */
	public static function may_remember_missing(): bool {
		if ( Counter::count( 'nf', self::SITE_BUCKET ) >= self::MISSING_BUDGET ) {
			return false;
		}
		Counter::hit( 'nf', self::SITE_BUCKET, self::MISSING_WINDOW );
		return true;
	}

	/**
	 * A cached `GET`.
	 *
	 * @param string              $path       API path.
	 * @param array<string,mixed> $query      Query values.
	 * @param bool                $keep_stale Keep the answer for the stale window (canonical requests only).
	 * @return Result|null The body (fresh or stale), or null when there is none.
	 */
	public function get( string $path, array $query = array(), bool $keep_stale = true ): ?Result {
		$key = self::key( $path, $query );
		$raw = get_transient( $key );
		if ( is_array( $raw ) && ! empty( $raw['not_found'] ) ) {
			return null;
		}
		$entry  = $this->read( $key );
		$now    = time();
		$ttl    = (int) Settings::get( 'cache_ttl' );
		$stored = null !== $entry;

		if ( $stored && ! $entry['keep_stale'] && $entry['fresh_until'] <= $now ) {
			// A TTL-only entry (free text, deep page) past its TTL is never served as a stale copy.
			$entry  = null;
			$stored = false;
		}

		if ( $stored && $entry['fresh_until'] > $now ) {
			// Still stale when it is only "fresh" because of a failure back-off.
			return new Result( $entry['body'], $entry['fetched_at'], $entry['stale_only'] || $entry['fetched_at'] + $ttl < $now );
		}

		// After a flush the previous generation's copy stays readable as stale-only (never revalidated with its ETag:
		// the flush meant it may be wrong), until this key is refreshed successfully (S8-F14).
		$previous = $stored ? null : $this->read( self::key( $path, $query, -1 ) );
		if ( null !== $previous && ! $previous['keep_stale'] ) {
			$previous = null;
		}

		$response = $this->client->get( $path, $query, $stored ? $entry['etag'] : null );

		if ( $response->ok() ) {
			$this->write( $key, $response->body, $response->etag, $now, $now + $ttl, $keep_stale );
			return new Result( $response->body, $now, false );
		}
		if ( Response::NOT_MODIFIED === $response->kind && $stored ) {
			$keep_stale = $keep_stale && $entry['keep_stale'];
			$this->write( $key, $entry['body'], $response->etag ?? $entry['etag'], $now, $now + $ttl, $keep_stale );
			return new Result( $entry['body'], $now, false );
		}
		if ( Response::NOT_FOUND === $response->kind ) {
			// Remembered briefly, so unknown references cannot make an API call per request (within the site-wide
			// budget: a crawl must not grow wp_options).
			if ( self::may_remember_missing() ) {
				set_transient( $key, array( 'not_found' => true ), \Inmolink\Plugin\Listings::NOT_FOUND_TTL );
			}
			return null;
		}
		if ( null !== $previous ) {
			// Unreachable after a flush: serve the previous generation's copy under the current key (so it survives
			// another flush and the API is left alone for a minute).
			$this->write( $key, $previous['body'], null, $previous['fetched_at'], $now + self::BACKOFF, true, true );
			return new Result( $previous['body'], $previous['fetched_at'], true );
		}
		if ( $stored ) {
			// Unreachable: serve the stale copy, back off for a minute.
			$this->write( $key, $entry['body'], $entry['etag'], $entry['fetched_at'], $now + self::BACKOFF, $entry['keep_stale'], true );
			return new Result( $entry['body'], $entry['fetched_at'], true );
		}
		return null;
	}

	/**
	 * The transient name for a request. Includes the cache generation, so {@see flush()} needs no table scan and
	 * works with persistent object caches too, and the API base + wp-config key fingerprint, so answers cached for
	 * another agency are never read even before the boot check flushes them (S10-F6).
	 *
	 * @param string              $path  API path.
	 * @param array<string,mixed> $query Query values.
	 * @param int                 $offset Generations back from the current one (0, or -1 for the previous).
	 */
	public static function key( string $path, array $query, int $offset = 0 ): string {
		ksort( $query );
		$generation = (int) get_option( self::GENERATION_OPTION, 1 ) + $offset;
		return self::PREFIX . md5( Settings::config_fingerprint() . '|' . $generation . '|' . $path . '?' . wp_json_encode( $query ) );
	}

	/**
	 * Invalidates every cached answer; old entries expire by themselves.
	 *
	 * @param bool $keep_fallback Keep the previous generation readable as a stale-only fallback until each key is
	 *                            refreshed (a rebuild of the same agency's data). False when the API URL or key changed:
	 *                            the old answers belong to another agency and are skipped altogether (two generations).
	 */
	public static function flush( bool $keep_fallback = true ): void {
		update_option( self::GENERATION_OPTION, (int) get_option( self::GENERATION_OPTION, 1 ) + ( $keep_fallback ? 1 : 2 ), true ); // Autoloaded: part of every cache key.
	}

	/**
	 * Reads an entry.
	 *
	 * @param string $key Transient name.
	 * @return array{body:array<string,mixed>,etag:?string,fetched_at:int,fresh_until:int,keep_stale:bool,stale_only:bool}|null
	 */
	private function read( string $key ): ?array {
		$entry = get_transient( $key );
		if ( ! is_array( $entry ) || ! isset( $entry['body'], $entry['fresh_until'], $entry['fetched_at'] ) || ! is_array( $entry['body'] ) ) {
			return null;
		}
		return array(
			'body'        => $entry['body'],
			'etag'        => isset( $entry['etag'] ) && is_string( $entry['etag'] ) ? $entry['etag'] : null,
			'fetched_at'  => (int) $entry['fetched_at'],
			'fresh_until' => (int) $entry['fresh_until'],
			'keep_stale'  => isset( $entry['keep_stale'] ) && true === $entry['keep_stale'],
			'stale_only'  => isset( $entry['stale_only'] ) && true === $entry['stale_only'],
		);
	}

	/**
	 * Writes an entry that lives for the stale window (or just until it must be revalidated).
	 *
	 * @param string              $key         Transient name.
	 * @param array<string,mixed> $body        Body.
	 * @param string|null         $etag        ETag.
	 * @param int                 $fetched_at  When the body was last confirmed by the API.
	 * @param int                 $fresh_until When to revalidate.
	 * @param bool                $keep_stale  Keep it for the stale window.
	 * @param bool                $stale_only  A fallback copy: always reported stale, even while the back-off holds it.
	 */
	private function write( string $key, array $body, ?string $etag, int $fetched_at, int $fresh_until, bool $keep_stale, bool $stale_only = false ): void {
		set_transient(
			$key,
			array(
				'body'        => $body,
				'etag'        => $etag,
				'fetched_at'  => $fetched_at,
				'fresh_until' => $fresh_until,
				'keep_stale'  => $keep_stale,
				'stale_only'  => $stale_only,
			),
			$keep_stale ? (int) Settings::get( 'stale_days' ) * DAY_IN_SECONDS : max( 1, $fresh_until - time() )
		);
	}
}
