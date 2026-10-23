<?php
/**
 * Activation, deactivation and uninstall.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin;

use Inmolink\Plugin\Api\Client;
use Inmolink\Plugin\Mirror\Mirror;
use Inmolink\Plugin\Sync\DeltaSync;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Creates the mirror table and schedules the delta sync; removes everything on uninstall.
 */
final class Installer {

	/**
	 * Plugin activation.
	 */
	public static function activate(): void {
		Mirror::install();
		self::schedule();
	}

	/**
	 * Plugin deactivation: stops the cron job (data is kept).
	 */
	public static function deactivate(): void {
		wp_clear_scheduled_hook( DeltaSync::HOOK );
		delete_option( DeltaSync::LOCK_OPTION );
	}

	/**
	 * Uninstall: drops the table and deletes every option and transient the plugin wrote.
	 */
	public static function uninstall(): void {
		self::deactivate();
		Mirror::drop();
		foreach ( array( Settings::OPTION, Settings::KEY_OPTION, DeltaSync::STATE_OPTION, Cache\Cache::GENERATION_OPTION ) as $option ) {
			delete_option( $option );
		}
		delete_transient( Client::DOWN_TRANSIENT );
		self::delete_cached_answers();
	}

	/**
	 * Deletes the cached API answers (`inmolink_c_*` transients) from the options table. With a persistent object
	 * cache they are not there and simply expire.
	 */
	private static function delete_cached_answers(): void {
		global $wpdb;
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching -- one-off uninstall purge.
		$wpdb->query(
			$wpdb->prepare(
				"DELETE FROM {$wpdb->options} WHERE option_name LIKE %s OR option_name LIKE %s",
				$wpdb->esc_like( '_transient_' . Cache\Cache::PREFIX ) . '%',
				$wpdb->esc_like( '_transient_timeout_' . Cache\Cache::PREFIX ) . '%'
			)
		);
	}

	/**
	 * Schedules the delta sync every five minutes (idempotent).
	 */
	public static function schedule(): void {
		if ( false === wp_next_scheduled( DeltaSync::HOOK ) ) {
			wp_schedule_event( time() + 60, DeltaSync::SCHEDULE, DeltaSync::HOOK );
		}
	}
}
