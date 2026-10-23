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
	 *
	 * @param bool $network_wide Activated for the whole network (WordPress passes it).
	 */
	public static function activate( bool $network_wide = false ): void {
		if ( $network_wide && is_multisite() ) {
			self::each_site( array( self::class, 'activate_site' ) );
		} else {
			self::activate_site();
		}
		Updates\Updater::for_plugin()->enable_auto_update_once();
	}

	/**
	 * Activation work of one site: its mirror table, cron event and rewrite rules.
	 */
	private static function activate_site(): void {
		Mirror::install();
		self::schedule();
		Routing\Router::schedule_flush();
	}

	/**
	 * A site created while the plugin is network-active gets its table and cron event (`wp_initialize_site`).
	 *
	 * @param \WP_Site $site The new site.
	 */
	public static function initialize_site( $site ): void {
		if ( ! $site instanceof \WP_Site ) {
			return;
		}
		if ( ! function_exists( 'is_plugin_active_for_network' ) ) {
			require_once ABSPATH . 'wp-admin/includes/plugin.php';
		}
		if ( ! is_plugin_active_for_network( plugin_basename( PLUGIN_FILE ) ) ) {
			return;
		}
		switch_to_blog( (int) $site->blog_id );
		try {
			self::activate_site();
		} finally {
			restore_current_blog();
		}
	}

	/**
	 * Plugin deactivation: stops the cron job (data is kept).
	 */
	public static function deactivate(): void {
		wp_clear_scheduled_hook( DeltaSync::HOOK );
		delete_option( DeltaSync::LOCK_OPTION );
		delete_option( 'rewrite_rules' ); // Rebuilt on the next request, without ours.
	}

	/**
	 * Uninstall: drops the table and deletes every option and transient the plugin wrote — on every site of a network,
	 * then the network-level options.
	 */
	public static function uninstall(): void {
		if ( is_multisite() ) {
			self::each_site( array( self::class, 'uninstall_site' ) );
		} else {
			self::uninstall_site();
		}
		delete_site_transient( Updates\Updater::INFO_TRANSIENT );
		foreach ( array( 'inmolink_auto_update_init', Updates\Updater::HIGHEST_OPTION, Updates\Updater::REPLAY_OPTION ) as $option ) {
			delete_site_option( $option );
		}
	}

	/**
	 * Runs a callback in each site of the network (in pages, so a large network is never loaded at once), then
	 * restores the current site.
	 *
	 * @param callable $callback Called with the site switched in.
	 */
	private static function each_site( callable $callback ): void {
		$offset = 0;
		$count  = 0;
		do {
			$ids   = get_sites(
				array(
					'fields'                 => 'ids',
					'number'                 => 100,
					'offset'                 => $offset,
					'network_id'             => get_current_network_id(),
					'update_site_meta_cache' => false,
				)
			);
			$count = count( $ids );
			foreach ( $ids as $id ) {
				switch_to_blog( (int) $id );
				try {
					$callback();
				} finally {
					restore_current_blog();
				}
			}
			$offset += 100;
		} while ( 100 === $count );
	}

	/**
	 * Uninstall work of the current site.
	 */
	private static function uninstall_site(): void {
		self::deactivate();
		Mirror::drop();
		$host = wp_parse_url( (string) Settings::get( 'api_base' ), PHP_URL_HOST );
		if ( is_string( $host ) ) {
			delete_transient( 'inmolink_dns_' . md5( strtolower( $host ) ) );
		}
		foreach ( array( Settings::OPTION, Settings::KEY_OPTION, DeltaSync::STATE_OPTION, Cache\Cache::GENERATION_OPTION, Forms\Turnstile::SECRET_OPTION, Net\Counter::OPTION ) as $option ) {
			delete_option( $option );
		}
		Client::reset_backoff();
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
