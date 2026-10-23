<?php
/**
 * Flushes the cached data when wp-config.php points the plugin at another agency.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin;

use Inmolink\Plugin\Api\Client;
use Inmolink\Plugin\Cache\Cache;
use Inmolink\Plugin\Mirror\Mirror;
use Inmolink\Plugin\Seo\SitemapIndex;
use Inmolink\Plugin\Sync\DeltaSync;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * `INMOLINK_API_KEY` / `INMOLINK_API_BASE` can change in wp-config.php without the settings page ever running, so the
 * settings save's flush never happens. On every boot the current {@see Settings::config_fingerprint()} is compared with
 * the one stored (an autoloaded option: no extra query); when it differs, the previous agency's data is dropped — the
 * transient cache without a stale fallback, the mirror table, the sitemap index, the sync cursor and the back-offs
 * (S10-F6). The new fingerprint is stored only once that succeeded, so a failed purge is retried on the next boot (a
 * repeated purge is harmless).
 *
 * The first boot after an install or upgrade has nothing to compare with: when the mirror already holds rows they
 * may belong to another agency, so it is purged once (safe default). Cached answers need no purge: the fingerprint is
 * part of their keys, so an upgrade drops every cached answer once anyway.
 */
final class ConfigGuard {

	public const OPTION = 'inmolink_config_fingerprint';

	/**
	 * Registers the boot check (after {@see Mirror::maybe_upgrade()}, so the table exists).
	 */
	public static function register(): void {
		add_action( 'plugins_loaded', array( self::class, 'check' ), 20 );
	}

	/**
	 * Compares the fingerprint with the stored one and forgets the previous agency's data when it changed.
	 *
	 * @return bool Whether the data was flushed.
	 */
	public static function check(): bool {
		$current = Settings::config_fingerprint();
		$stored  = get_option( self::OPTION, null );
		if ( $stored === $current ) {
			return false;
		}
		$purge = is_string( $stored ) || ( new Mirror() )->count() > 0;
		if ( $purge && ! self::forget_agency() ) {
			return false; // Retried on the next boot.
		}
		update_option( self::OPTION, $current, true ); // Autoloaded: read on every request.
		return $purge;
	}

	/**
	 * Records the current fingerprint (the settings save flushed already).
	 */
	public static function remember(): void {
		update_option( self::OPTION, Settings::config_fingerprint(), true );
	}

	/**
	 * Drops everything cached for the previous endpoint or key: another agency's listings must not keep rendering, not
	 * even as a stale fallback.
	 *
	 * @return bool Whether the mirror table was emptied (the rest cannot fail in a way the plugin can tell).
	 */
	public static function forget_agency(): bool {
		DeltaSync::reset();
		Cache::flush( false );
		SitemapIndex::clear( (array) Settings::get( 'locales' ) );
		Client::reset_backoff();
		return ( new Mirror() )->truncate();
	}
}
