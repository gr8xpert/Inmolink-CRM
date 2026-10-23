<?php
/**
 * Hook wiring.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin;

use Inmolink\Plugin\Admin\SettingsPage;
use Inmolink\Plugin\Mirror\Mirror;
use Inmolink\Plugin\Sync\DeltaSync;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Registers the plugin's hooks once.
 */
final class Plugin {

	/**
	 * The instance.
	 *
	 * @var self|null
	 */
	private static ?self $instance = null;

	/**
	 * Whether {@see boot()} ran.
	 *
	 * @var bool
	 */
	private bool $booted = false;

	/**
	 * The instance.
	 */
	public static function instance(): self {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	/**
	 * Registers hooks.
	 */
	public function boot(): void {
		if ( $this->booted ) {
			return;
		}
		$this->booted = true;

		add_filter( 'cron_schedules', array( self::class, 'cron_schedules' ) ); // phpcs:ignore WordPress.WP.CronInterval.CronSchedulesInterval -- the change feed is polled every 5 minutes by design.
		add_action( DeltaSync::HOOK, array( self::class, 'run_sync' ) );
		add_action( 'init', array( self::class, 'init' ) );
		add_action( 'plugins_loaded', array( Mirror::class, 'maybe_upgrade' ) );

		if ( is_admin() ) {
			( new SettingsPage() )->register();
		}
		if ( defined( 'WP_CLI' ) && WP_CLI ) {
			\WP_CLI::add_command( 'inmolink', Cli::class );
		}
	}

	/**
	 * `init`: translations, and the cron event (re-created if something removed it).
	 */
	public static function init(): void {
		load_plugin_textdomain( 'inmolink', false, dirname( plugin_basename( PLUGIN_FILE ) ) . '/languages' );
		Installer::schedule();
	}

	/**
	 * Adds the five-minute schedule.
	 *
	 * @param array<string,array{interval:int,display:string}> $schedules Schedules.
	 * @return array<string,array{interval:int,display:string}>
	 */
	public static function cron_schedules( $schedules ): array {
		$schedules                        = is_array( $schedules ) ? $schedules : array();
		$schedules[ DeltaSync::SCHEDULE ] = array(
			'interval' => 5 * MINUTE_IN_SECONDS,
			'display'  => __( 'Every five minutes (Inmolink)', 'inmolink' ),
		);
		return $schedules;
	}

	/**
	 * The cron callback.
	 */
	public static function run_sync(): void {
		DeltaSync::from_settings()->run();
	}
}
