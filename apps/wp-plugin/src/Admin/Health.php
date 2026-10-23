<?php
/**
 * Health report: API status, cache age, mirror counts, version, last sync.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\Admin;

use Inmolink\Plugin\Api\Client;
use Inmolink\Plugin\Forms\Turnstile;
use Inmolink\Plugin\Mirror\Mirror;
use Inmolink\Plugin\Settings;
use Inmolink\Plugin\Sync\DeltaSync;
use Inmolink\Plugin\Updates\Updater;
use const Inmolink\Plugin\VERSION;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Settings → Inmolink health, plus a WordPress Site Health test. Read-only; `manage_options` only. Shows no secret,
 * no visitor data and no listing content — only states, counts and ages.
 */
final class Health {

	public const SLUG = 'inmolink-health';
	/** A sync older than this is reported as stale. */
	public const SYNC_STALE = HOUR_IN_SECONDS;

	/**
	 * Registers the page and the Site Health test.
	 */
	public static function register(): void {
		add_action( 'admin_menu', array( self::class, 'menu' ) );
		add_filter( 'site_status_tests', array( self::class, 'site_status_tests' ) );
	}

	/**
	 * Adds the page under Settings.
	 */
	public static function menu(): void {
		add_options_page( __( 'Inmolink health', 'inmolink' ), __( 'Inmolink health', 'inmolink' ), SettingsPage::CAPABILITY, self::SLUG, array( self::class, 'render' ) );
	}

	/**
	 * The report: what an operator needs to tell whether the site is serving fresh data.
	 *
	 * @return array{version:string,configured:bool,api_reachable:bool,last_sync:int,last_run:int,last_error:string,sync_stale:bool,mirror:array<string,array{rows:int,oldest:int,newest:int}>,turnstile:string,update_key:bool,auto_update:bool,latest_version:string}
	 */
	public static function report(): array {
		$state  = DeltaSync::state();
		$latest = get_site_transient( Updater::INFO_TRANSIENT );
		return array(
			'version'        => VERSION,
			'configured'     => Settings::is_configured(),
			'api_reachable'  => ! Client::in_backoff() && (int) $state['last_success'] > 0,
			'last_sync'      => (int) $state['last_success'],
			'last_run'       => (int) $state['last_run'],
			'last_error'     => (string) $state['last_error'],
			'sync_stale'     => (int) $state['last_success'] < time() - self::SYNC_STALE,
			'mirror'         => ( new Mirror() )->stats(),
			'turnstile'      => Turnstile::test_mode() ? 'test' : Turnstile::mode(),
			'update_key'     => '' !== Updater::public_key(),
			'auto_update'    => in_array( plugin_basename( \Inmolink\Plugin\PLUGIN_FILE ), (array) get_site_option( 'auto_update_plugins', array() ), true ),
			'latest_version' => is_array( $latest ) && isset( $latest['version'] ) && is_string( $latest['version'] ) ? $latest['version'] : '',
		);
	}

	/**
	 * Renders the page.
	 */
	public static function render(): void {
		if ( ! current_user_can( SettingsPage::CAPABILITY ) ) {
			wp_die( esc_html__( 'You do not have permission to access this page.', 'inmolink' ), 403 );
		}
		$r    = self::report();
		$when = static fn ( int $t ): string => $t > 0
			/* translators: %s: human time difference, e.g. "5 mins". */
			? sprintf( __( '%s ago', 'inmolink' ), human_time_diff( $t ) )
			: '—';
		$rows = array(
			__( 'Plugin version', 'inmolink' )       => $r['version'],
			__( 'Configured', 'inmolink' )           => $r['configured'] ? __( 'Yes', 'inmolink' ) : __( 'No', 'inmolink' ),
			__( 'API reachable', 'inmolink' )        => $r['api_reachable'] ? __( 'Yes', 'inmolink' ) : ( $r['last_sync'] > 0 ? __( 'No — serving cached copies', 'inmolink' ) : __( 'Not yet confirmed (no successful sync)', 'inmolink' ) ),
			__( 'Last successful sync', 'inmolink' ) => $when( $r['last_sync'] ) . ( $r['sync_stale'] ? ' ' . __( '(stale)', 'inmolink' ) : '' ),
			__( 'Last sync run', 'inmolink' )        => $when( $r['last_run'] ),
			__( 'Last sync error', 'inmolink' )      => '' !== $r['last_error'] ? $r['last_error'] : '—',
			__( 'Enquiry forms', 'inmolink' )        => array(
				'own'     => __( 'On (site verifies Turnstile)', 'inmolink' ),
				'forward' => __( 'On (Inmolink verifies Turnstile)', 'inmolink' ),
				'none'    => __( 'Off — no Turnstile key', 'inmolink' ),
				'test'    => __( 'TEST MODE — Turnstile test keys (always pass)', 'inmolink' ),
			)[ $r['turnstile'] ],
			__( 'Signed updates', 'inmolink' )       => $r['update_key'] ? __( 'On', 'inmolink' ) : __( 'Off — no update key pinned', 'inmolink' ),
			__( 'Automatic updates', 'inmolink' )    => $r['auto_update'] ? __( 'On', 'inmolink' ) : __( 'Off (Plugins screen)', 'inmolink' ),
			__( 'Latest release', 'inmolink' )       => '' !== $r['latest_version'] ? $r['latest_version'] : '—',
		);
		?>
		<div class="wrap">
			<h1><?php esc_html_e( 'Inmolink health', 'inmolink' ); ?></h1>
			<table class="widefat striped" role="presentation">
				<tbody>
					<?php foreach ( $rows as $label => $value ) : ?>
						<tr><th scope="row"><?php echo esc_html( $label ); ?></th><td><?php echo esc_html( (string) $value ); ?></td></tr>
					<?php endforeach; ?>
				</tbody>
			</table>
			<h2><?php esc_html_e( 'Detail pages cached on this site', 'inmolink' ); ?></h2>
			<table class="widefat striped">
				<thead><tr><th scope="col"><?php esc_html_e( 'Locale', 'inmolink' ); ?></th><th scope="col"><?php esc_html_e( 'Pages', 'inmolink' ); ?></th><th scope="col"><?php esc_html_e( 'Oldest copy', 'inmolink' ); ?></th><th scope="col"><?php esc_html_e( 'Newest copy', 'inmolink' ); ?></th></tr></thead>
				<tbody>
					<?php foreach ( $r['mirror'] as $locale => $m ) : ?>
						<tr><td><?php echo esc_html( $locale ); ?></td><td><?php echo esc_html( number_format_i18n( $m['rows'] ) ); ?></td><td><?php echo esc_html( $when( $m['oldest'] ) ); ?></td><td><?php echo esc_html( $when( $m['newest'] ) ); ?></td></tr>
					<?php endforeach; ?>
					<?php if ( array() === $r['mirror'] ) : ?>
						<tr><td colspan="4"><?php esc_html_e( 'None yet.', 'inmolink' ); ?></td></tr>
					<?php endif; ?>
				</tbody>
			</table>
		</div>
		<?php
	}

	/**
	 * Adds the Site Health test.
	 *
	 * @param array<string,mixed> $tests Tests.
	 * @return array<string,mixed>
	 */
	public static function site_status_tests( $tests ): array {
		$tests                              = is_array( $tests ) ? $tests : array();
		$tests['direct']['inmolink_health'] = array(
			'label' => __( 'Inmolink listings', 'inmolink' ),
			'test'  => array( self::class, 'site_status' ),
		);
		return $tests;
	}

	/**
	 * The Site Health result.
	 *
	 * @return array<string,mixed>
	 */
	public static function site_status(): array {
		$r      = self::report();
		$status = 'good';
		$label  = __( 'Inmolink listings are up to date', 'inmolink' );
		if ( ! $r['configured'] ) {
			$status = 'critical';
			$label  = __( 'Inmolink is not configured', 'inmolink' );
		} elseif ( ! $r['api_reachable'] || $r['sync_stale'] ) {
			$status = 'recommended';
			$label  = __( 'Inmolink is serving cached listings (the API or the sync is behind)', 'inmolink' );
		}
		return array(
			'label'       => $label,
			'status'      => $status,
			'badge'       => array(
				'label' => __( 'Inmolink', 'inmolink' ),
				'color' => 'good' === $status ? 'blue' : 'orange',
			),
			'description' => '<p>' . esc_html__( 'See Settings → Inmolink health for the sync, cache and update status.', 'inmolink' ) . '</p>',
			'test'        => 'inmolink_health',
		);
	}
}
