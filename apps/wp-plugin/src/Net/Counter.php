<?php
/**
 * Per-visitor counters for the plugin's rate limits, with bounded storage.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\Net;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Fixed-window counters keyed by scope and visitor bucket ({@see Ip::bucket()}: an IPv4 address or an IPv6 /64).
 *
 * Storage is bounded whatever the traffic:
 * - With a persistent object cache the counters live there (`wp_cache_incr`, expire by themselves).
 * - Without one, ALL counters share one non-autoloaded option holding at most {@see MAX_BUCKETS} entries: expired
 *   ones are pruned on write and, when still full, the entries closest to expiry are dropped. A transient per visitor
 *   would add two `wp_options` rows per visitor and never be cleaned on a site without cron. Writes race (a lost
 *   update undercounts by one at worst) and an attacker with thousands of addresses can evict others' counters; both
 *   are accepted for a best-effort limit.
 *
 * An unknown IP ('' or not an address) is neither counted nor limited here: sharing one bucket would let one
 * unknown visitor lock out every other.
 */
final class Counter {

	public const OPTION      = 'inmolink_rate_counters';
	public const MAX_BUCKETS = 1000;
	private const GROUP      = 'inmolink_rate';

	/**
	 * The count of the visitor's current window.
	 *
	 * @param string $scope Limit name (`form`, `fail`, `api`).
	 * @param string $ip    Visitor IP.
	 */
	public static function count( string $scope, string $ip ): int {
		$key = self::key( $scope, $ip );
		if ( '' === $key ) {
			return 0;
		}
		if ( wp_using_ext_object_cache() ) {
			return (int) wp_cache_get( $key, self::GROUP );
		}
		$all = self::load();
		return isset( $all[ $key ] ) ? (int) $all[ $key ][0] : 0;
	}

	/**
	 * Counts one event and returns the window's count. The window starts at the first event.
	 *
	 * @param string $scope  Limit name.
	 * @param string $ip     Visitor IP.
	 * @param int    $window Window length in seconds.
	 */
	public static function hit( string $scope, string $ip, int $window ): int {
		$key = self::key( $scope, $ip );
		if ( '' === $key ) {
			return 0;
		}
		if ( wp_using_ext_object_cache() ) {
			wp_cache_add( $key, 0, self::GROUP, $window );
			$n = wp_cache_incr( $key, 1, self::GROUP );
			return false === $n ? 1 : (int) $n;
		}
		$all = self::load();
		$now = time();
		if ( isset( $all[ $key ] ) ) {
			++$all[ $key ][0];
		} else {
			$all[ $key ] = array( 1, $now + $window );
		}
		$entry = $all[ $key ];
		if ( count( $all ) > self::MAX_BUCKETS ) {
			// The current visitor's entry always stays: on equal expiries a stable sort would otherwise drop it last.
			unset( $all[ $key ] );
			uasort( $all, static fn ( array $a, array $b ): int => $b[1] <=> $a[1] );
			$all         = array_slice( $all, 0, self::MAX_BUCKETS - 1, true );
			$all[ $key ] = $entry;
		}
		update_option( self::OPTION, $all, false );
		return (int) $entry[0];
	}

	/**
	 * The live counters (expired ones dropped).
	 *
	 * @return array<string,array{0:int,1:int}>
	 */
	private static function load(): array {
		$raw = get_option( self::OPTION, array() );
		$now = time();
		$out = array();
		if ( is_array( $raw ) ) {
			foreach ( $raw as $key => $entry ) {
				if ( is_string( $key ) && is_array( $entry ) && isset( $entry[0], $entry[1] ) && (int) $entry[1] > $now ) {
					$out[ $key ] = array( (int) $entry[0], (int) $entry[1] );
				}
			}
		}
		return $out;
	}

	/**
	 * The storage key: scope plus a salted hash of the visitor bucket ('' for an unknown IP).
	 *
	 * @param string $scope Limit name.
	 * @param string $ip    Visitor IP.
	 */
	private static function key( string $scope, string $ip ): string {
		$bucket = Ip::bucket( $ip );
		return '' === $bucket ? '' : $scope . '_' . substr( md5( wp_salt( 'nonce' ) . '|' . $bucket ), 0, 20 );
	}
}
