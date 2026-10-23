<?php
/**
 * The site's listing pages from `/v2/sitemap`, chunked for WordPress sitemaps.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\Seo;

use Inmolink\Plugin\Api\Client;
use Inmolink\Plugin\Settings;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Walks `/v2/sitemap` (cursor pages of 500) per locale and stores the entries in chunks of one WordPress sitemap
 * page each (transients, kept for the stale window). Rebuilt when older than {@see REFRESH} — by the cron job, or
 * on the first sitemap request without a copy; if the API fails the previous copy stays in use.
 */
class SitemapIndex {

	public const REFRESH   = 6 * HOUR_IN_SECONDS;
	public const MAX_PAGES = 200;
	public const API_LIMIT = 500;
	public const LOCK_TTL  = 120;
	private const PREFIX   = 'inmolink_sm_';

	/**
	 * Creates the index.
	 *
	 * @param Client $client      API client (background timeout).
	 * @param int    $chunk       Entries per WordPress sitemap page.
	 * @param int    $time_budget Seconds per build.
	 */
	public function __construct(
		private readonly Client $client,
		private readonly int $chunk = 2000,
		private readonly int $time_budget = 20
	) {}

	/**
	 * The index wired from the settings.
	 */
	public static function from_settings(): self {
		$chunk = function_exists( 'wp_sitemaps_get_max_urls' ) ? (int) wp_sitemaps_get_max_urls( 'inmolink' ) : 2000;
		return new self( Client::from_settings( Client::SYNC_TIMEOUT, Client::PAGE ), max( 1, $chunk ) );
	}

	/**
	 * Number of sitemap pages for a locale (builds the index when there is none or it is due).
	 *
	 * @param string $locale API locale.
	 */
	public function pages( string $locale ): int {
		$meta = $this->meta( $locale );
		if ( null === $meta ) {
			// No copy yet: one request builds it (the others see an empty sitemap meanwhile); refreshes run on cron.
			$this->build( $locale );
			$meta = $this->meta( $locale );
		}
		return null === $meta ? 0 : $meta['pages'];
	}

	/**
	 * One sitemap page's entries.
	 *
	 * @param string $locale API locale.
	 * @param int    $page   1-based page number.
	 * @return list<array{ref:string,slug:string,kind:string,updatedAt:string}>
	 */
	public function entries( string $locale, int $page ): array {
		$meta = $this->meta( $locale );
		if ( null === $meta || $page < 1 || $page > $meta['pages'] ) {
			return array();
		}
		$chunk = get_transient( self::chunk_key( $locale, $meta['gen'], $page ) );
		return is_array( $chunk ) ? $chunk : array();
	}

	/**
	 * Rebuilds the index for a locale. Keeps the previous one when the walk fails.
	 *
	 * @param string $locale API locale.
	 * @return bool Whether a complete index was stored.
	 */
	public function build( string $locale ): bool {
		$lock = self::PREFIX . 'lock_' . $locale;
		if ( ! add_option( $lock, time() + self::LOCK_TTL, '', false ) ) {
			if ( (int) get_option( $lock, 0 ) > time() ) {
				return false;
			}
			update_option( $lock, time() + self::LOCK_TTL, false );
		}
		try {
			return $this->walk( $locale );
		} finally {
			delete_option( $lock );
		}
	}

	/**
	 * The walk behind {@see build()}, under its lock.
	 *
	 * @param string $locale API locale.
	 */
	private function walk( string $locale ): bool {
		$deadline = time() + $this->time_budget;
		$cursor   = null;
		$entries  = array();
		$complete = false;
		$pages    = 0;
		while ( $pages < self::MAX_PAGES && time() <= $deadline ) {
			++$pages;
			$query = array(
				'lang'  => $locale,
				'limit' => self::API_LIMIT,
			);
			if ( null !== $cursor ) {
				$query['cursor'] = $cursor;
			}
			$response = $this->client->get( '/v2/sitemap', $query );
			if ( ! $response->ok() || ! isset( $response->body['items'] ) || ! is_array( $response->body['items'] ) ) {
				break;
			}
			foreach ( $response->body['items'] as $item ) {
				if ( is_array( $item ) && isset( $item['ref'], $item['slug'], $item['updatedAt'] ) && is_string( $item['ref'] ) && is_string( $item['slug'] ) ) {
					$entries[] = array(
						'ref'       => $item['ref'],
						'slug'      => $item['slug'],
						'kind'      => isset( $item['kind'] ) && is_string( $item['kind'] ) ? $item['kind'] : 'LISTING',
						'updatedAt' => (string) $item['updatedAt'],
					);
				}
			}
			$cursor = isset( $response->body['nextCursor'] ) && is_string( $response->body['nextCursor'] ) ? $response->body['nextCursor'] : null;
			if ( null === $cursor || self::MAX_PAGES === $pages ) {
				// The end, or the cap (MAX_PAGES × API_LIMIT entries): either way a usable, complete-as-intended copy.
				$complete = true;
				break;
			}
		}

		$previous = $this->meta( $locale );
		$ttl      = (int) Settings::get( 'stale_days' ) * DAY_IN_SECONDS;
		if ( ! $complete && null !== $previous ) {
			// Keep serving the previous copy; try again in five minutes rather than on every run.
			$previous['built'] = time() - self::REFRESH + 5 * MINUTE_IN_SECONDS;
			set_transient( self::PREFIX . $locale, $previous, $ttl );
			return false;
		}
		$gen    = ( null !== $previous ? $previous['gen'] : 0 ) + 1;
		$chunks = array_chunk( $entries, $this->chunk );
		foreach ( $chunks as $n => $chunk ) {
			set_transient( self::chunk_key( $locale, $gen, $n + 1 ), $chunk, $ttl );
		}
		set_transient(
			self::PREFIX . $locale,
			array(
				'pages' => count( $chunks ),
				'count' => count( $entries ),
				// An incomplete first build is retried in five minutes.
				'built' => $complete ? time() : time() - self::REFRESH + 5 * MINUTE_IN_SECONDS,
				'gen'   => $gen,
			),
			$ttl
		);
		if ( null !== $previous ) {
			// One copy only: the previous generation's chunks go.
			for ( $n = 1; $n <= $previous['pages']; $n++ ) {
				delete_transient( self::chunk_key( $locale, $previous['gen'], $n ) );
			}
		}
		return $complete;
	}

	/**
	 * Rebuilds every configured locale whose index is due (cron).
	 */
	public function refresh_due(): void {
		foreach ( (array) Settings::get( 'locales' ) as $locale ) {
			$meta = $this->meta( (string) $locale );
			if ( null === $meta || $meta['built'] < time() - self::REFRESH ) {
				$this->build( (string) $locale );
			}
		}
	}

	/**
	 * The stored index metadata.
	 *
	 * @param string $locale API locale.
	 * @return array{pages:int,count:int,built:int,gen:int}|null
	 */
	private function meta( string $locale ): ?array {
		$meta = get_transient( self::PREFIX . $locale );
		if ( ! is_array( $meta ) || ! isset( $meta['pages'], $meta['built'], $meta['gen'] ) ) {
			return null;
		}
		return array(
			'pages' => (int) $meta['pages'],
			'count' => (int) ( $meta['count'] ?? 0 ),
			'built' => (int) $meta['built'],
			'gen'   => (int) $meta['gen'],
		);
	}

	/**
	 * A chunk's transient name.
	 *
	 * @param string $locale API locale.
	 * @param int    $gen    Index generation.
	 * @param int    $page   Page number.
	 */
	private static function chunk_key( string $locale, int $gen, int $page ): string {
		return self::PREFIX . $locale . '_' . $gen . '_' . $page;
	}
}
