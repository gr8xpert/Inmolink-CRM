<?php
/**
 * WP-CLI commands.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin;

use Inmolink\Plugin\Mirror\Mirror;
use Inmolink\Plugin\Sync\DeltaSync;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * `wp inmolink sync` (for a real cron) and `wp inmolink status`.
 */
final class Cli {

	/**
	 * Runs one delta sync now.
	 *
	 * ## EXAMPLES
	 *
	 *     wp inmolink sync
	 *
	 * @param string[]             $args       Positional arguments.
	 * @param array<string,string> $assoc_args Named arguments.
	 */
	public function sync( array $args, array $assoc_args ): void {
		unset( $args, $assoc_args );
		$result = DeltaSync::from_settings()->run();
		$line   = sprintf( 'status=%s pages=%d applied=%d', $result['status'], $result['pages'], $result['applied'] );
		if ( 'ok' === $result['status'] ) {
			\WP_CLI::success( $line );
		} else {
			\WP_CLI::warning( $line );
		}
	}

	/**
	 * Shows the sync state and mirror size.
	 *
	 * @param string[]             $args       Positional arguments.
	 * @param array<string,string> $assoc_args Named arguments.
	 */
	public function status( array $args, array $assoc_args ): void {
		unset( $args, $assoc_args );
		$state = DeltaSync::state();
		\WP_CLI::line( sprintf( 'configured: %s', Settings::is_configured() ? 'yes' : 'no' ) );
		\WP_CLI::line( sprintf( 'last run: %s', $state['last_run'] ? gmdate( 'c', $state['last_run'] ) : '-' ) );
		\WP_CLI::line( sprintf( 'last success: %s', $state['last_success'] ? gmdate( 'c', $state['last_success'] ) : '-' ) );
		\WP_CLI::line( sprintf( 'last error: %s', '' !== $state['last_error'] ? $state['last_error'] : '-' ) );
		\WP_CLI::line( sprintf( 'mirror rows: %d', ( new Mirror() )->count() ) );
	}
}
