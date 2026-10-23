<?php
/**
 * Settings → Inmolink.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\Admin;

use Inmolink\Plugin\Api\Client;
use Inmolink\Plugin\Cache\Cache;
use Inmolink\Plugin\Mirror\Mirror;
use Inmolink\Plugin\Settings;
use Inmolink\Plugin\Sync\DeltaSync;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * The settings page: API endpoint, secret key (write-only — never printed back), locales, cache lifetimes, the sync
 * status, "test connection" and "sync now". Every action checks `manage_options` and its own nonce.
 */
final class SettingsPage {

	public const SLUG       = 'inmolink';
	public const CAPABILITY = 'manage_options';
	public const SAVE       = 'inmolink_save_settings';
	public const TEST       = 'inmolink_test_connection';
	public const SYNC       = 'inmolink_sync_now';

	/** Notice codes a redirect may carry, with their messages (nothing from the query string is printed). */
	private const NOTICES = array( 'saved', 'key_invalid', 'key_reentry', 'test_ok', 'test_failed', 'synced', 'sync_failed' );

	/**
	 * Registers the admin hooks.
	 */
	public function register(): void {
		add_action( 'admin_menu', array( $this, 'menu' ) );
		add_action( 'admin_post_' . self::SAVE, array( $this, 'on_save' ) );
		add_action( 'admin_post_' . self::TEST, array( $this, 'on_test' ) );
		add_action( 'admin_post_' . self::SYNC, array( $this, 'on_sync' ) );
	}

	/**
	 * Adds the page under Settings.
	 */
	public function menu(): void {
		add_options_page(
			__( 'Inmolink', 'inmolink' ),
			__( 'Inmolink', 'inmolink' ),
			self::CAPABILITY,
			self::SLUG,
			array( $this, 'render' )
		);
	}

	/**
	 * `admin-post.php?action=inmolink_save_settings`.
	 */
	public function on_save(): void {
		$this->guard( self::SAVE );
		// phpcs:ignore WordPress.Security.NonceVerification.Missing -- verified in guard().
		$input = isset( $_POST['inmolink'] ) && is_array( $_POST['inmolink'] ) ? map_deep( wp_unslash( $_POST['inmolink'] ), 'sanitize_text_field' ) : array();
		$this->finish( $this->save( $input ) );
	}

	/**
	 * `admin-post.php?action=inmolink_test_connection`.
	 */
	public function on_test(): void {
		$this->guard( self::TEST );
		$this->finish( $this->test_connection() ? 'test_ok' : 'test_failed' );
	}

	/**
	 * `admin-post.php?action=inmolink_sync_now`.
	 */
	public function on_sync(): void {
		$this->guard( self::SYNC );
		Client::reset_backoff();
		$result = DeltaSync::from_settings()->run();
		$this->finish( 'ok' === $result['status'] ? 'synced' : 'sync_failed' );
	}

	/**
	 * Applies a submitted settings form. The key field is write-only: empty keeps the stored key, `clear_key` removes
	 * it. A new endpoint or key resets the sync cursor, invalidates the cache and empties the mirror.
	 *
	 * @param array<string,mixed> $input The `inmolink[...]` fields, unslashed.
	 * @return string Notice code.
	 */
	public function save( array $input ): string {
		$before_base = (string) Settings::get( 'api_base' );
		$before_key  = Settings::api_key();
		$notice      = 'saved';

		Settings::save( $input );

		if ( ! Settings::key_from_constant() ) {
			$key = isset( $input['api_key'] ) && is_string( $input['api_key'] ) ? trim( $input['api_key'] ) : '';
			if ( ! empty( $input['clear_key'] ) ) {
				Settings::clear_api_key();
			} elseif ( '' !== $key && ! Settings::set_api_key( $key ) ) {
				$notice = 'key_invalid';
			} elseif ( '' === $key && '' !== $before_key && Settings::get( 'api_base' ) !== $before_base ) {
				$notice = 'key_reentry';
			}
		}

		if ( Settings::get( 'api_base' ) !== $before_base || Settings::api_key() !== $before_key ) {
			// Another site's (or agency's) data must not keep rendering here, not even as a stale fallback.
			DeltaSync::reset();
			Cache::flush();
			( new Mirror() )->truncate();
		} else {
			// Rows of a removed locale are never synced again; new locales fill in on view and with the next changes.
			( new Mirror() )->keep_locales( (array) Settings::get( 'locales' ) );
		}
		Client::reset_backoff();
		return $notice;
	}

	/**
	 * Calls the change feed once with the current settings.
	 */
	public function test_connection(): bool {
		Client::reset_backoff();
		$response = Client::from_settings( Client::SYNC_TIMEOUT )->get(
			'/v2/changes',
			array(
				'since' => gmdate( 'Y-m-d\TH:i:s\Z' ),
				'limit' => 1,
			)
		);
		return $response->ok() && null !== DeltaSync::parse_page( $response->body );
	}

	/**
	 * Renders the page.
	 */
	public function render(): void {
		if ( ! current_user_can( self::CAPABILITY ) ) {
			wp_die( esc_html__( 'You do not have permission to access this page.', 'inmolink' ), 403 );
		}
		$settings = Settings::all();
		$state    = DeltaSync::state();
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- display only; matched against a fixed list.
		$notice = isset( $_GET['inmolink_notice'] ) ? sanitize_key( wp_unslash( $_GET['inmolink_notice'] ) ) : '';
		$action = admin_url( 'admin-post.php' );
		?>
		<div class="wrap">
			<h1><?php esc_html_e( 'Inmolink', 'inmolink' ); ?></h1>
			<?php $this->notice( $notice ); ?>

			<form method="post" action="<?php echo esc_url( $action ); ?>">
				<input type="hidden" name="action" value="<?php echo esc_attr( self::SAVE ); ?>" />
				<?php wp_nonce_field( self::SAVE ); ?>
				<table class="form-table" role="presentation">
					<tr>
						<th scope="row"><label for="inmolink-api-base"><?php esc_html_e( 'API URL', 'inmolink' ); ?></label></th>
						<td>
							<input type="url" class="regular-text" id="inmolink-api-base" name="inmolink[api_base]" value="<?php echo esc_attr( $settings['api_base'] ); ?>" <?php disabled( defined( 'INMOLINK_API_BASE' ) ); ?> />
							<p class="description"><?php esc_html_e( 'The Inmolink website API address given with your API key (https).', 'inmolink' ); ?></p>
						</td>
					</tr>
					<tr>
						<th scope="row"><label for="inmolink-api-key"><?php esc_html_e( 'Secret API key', 'inmolink' ); ?></label></th>
						<td>
							<?php if ( Settings::key_from_constant() ) : ?>
								<p><?php esc_html_e( 'Set in wp-config.php (INMOLINK_API_KEY).', 'inmolink' ); ?></p>
							<?php else : ?>
								<input type="password" class="regular-text" id="inmolink-api-key" name="inmolink[api_key]" value="" autocomplete="new-password" placeholder="<?php echo esc_attr( Settings::has_api_key() ? __( 'Stored — leave empty to keep it', 'inmolink' ) : __( 'inl_live_sk…', 'inmolink' ) ); ?>" />
								<?php if ( Settings::has_api_key() ) : ?>
									<label><input type="checkbox" name="inmolink[clear_key]" value="1" /> <?php esc_html_e( 'Remove the stored key', 'inmolink' ); ?></label>
								<?php endif; ?>
								<p class="description"><?php esc_html_e( 'Stored encrypted and used by the server only; it is never shown again or sent to browsers.', 'inmolink' ); ?></p>
							<?php endif; ?>
						</td>
					</tr>
					<tr>
						<th scope="row"><label for="inmolink-locales"><?php esc_html_e( 'Locales', 'inmolink' ); ?></label></th>
						<td>
							<input type="text" class="regular-text" id="inmolink-locales" name="inmolink[locales]" value="<?php echo esc_attr( implode( ',', $settings['locales'] ) ); ?>" />
							<p class="description"><?php esc_html_e( 'Comma-separated, e.g. en,es,de. Detail pages are mirrored in each.', 'inmolink' ); ?></p>
						</td>
					</tr>
					<tr>
						<th scope="row"><label for="inmolink-default-locale"><?php esc_html_e( 'Default locale', 'inmolink' ); ?></label></th>
						<td><input type="text" class="small-text" id="inmolink-default-locale" name="inmolink[default_locale]" value="<?php echo esc_attr( $settings['default_locale'] ); ?>" /></td>
					</tr>
					<tr>
						<th scope="row"><label for="inmolink-listing-base"><?php esc_html_e( 'Property URL base', 'inmolink' ); ?></label></th>
						<td>
							<input type="text" class="regular-text" id="inmolink-listing-base" name="inmolink[listing_base]" value="<?php echo esc_attr( $settings['listing_base'] ); ?>" />
							<p class="description"><?php esc_html_e( 'e.g. property, or property, es:propiedad, de:immobilie for one per locale. Pages live at /{base}/{reference}/{slug}/.', 'inmolink' ); ?></p>
						</td>
					</tr>
					<tr>
						<th scope="row"><label for="inmolink-development-base"><?php esc_html_e( 'Development URL base', 'inmolink' ); ?></label></th>
						<td><input type="text" class="regular-text" id="inmolink-development-base" name="inmolink[development_base]" value="<?php echo esc_attr( $settings['development_base'] ); ?>" /></td>
					</tr>
					<tr>
						<th scope="row"><label for="inmolink-cache-ttl"><?php esc_html_e( 'Search cache (seconds)', 'inmolink' ); ?></label></th>
						<td><input type="number" class="small-text" id="inmolink-cache-ttl" name="inmolink[cache_ttl]" min="<?php echo esc_attr( (string) Settings::MIN_TTL ); ?>" max="<?php echo esc_attr( (string) Settings::MAX_TTL ); ?>" value="<?php echo esc_attr( (string) $settings['cache_ttl'] ); ?>" /></td>
					</tr>
					<tr>
						<th scope="row"><label for="inmolink-stale-days"><?php esc_html_e( 'Keep stale copies (days)', 'inmolink' ); ?></label></th>
						<td>
							<input type="number" class="small-text" id="inmolink-stale-days" name="inmolink[stale_days]" min="1" max="90" value="<?php echo esc_attr( (string) $settings['stale_days'] ); ?>" />
							<p class="description"><?php esc_html_e( 'Served when the API cannot be reached.', 'inmolink' ); ?></p>
						</td>
					</tr>
				</table>
				<?php submit_button(); ?>
			</form>

			<h2><?php esc_html_e( 'Status', 'inmolink' ); ?></h2>
			<table class="widefat striped" role="presentation">
				<tbody>
					<tr><th scope="row"><?php esc_html_e( 'Configured', 'inmolink' ); ?></th><td><?php echo esc_html( Settings::is_configured() ? __( 'Yes', 'inmolink' ) : __( 'No', 'inmolink' ) ); ?></td></tr>
					<tr><th scope="row"><?php esc_html_e( 'Last sync', 'inmolink' ); ?></th><td><?php echo esc_html( $this->when( (int) $state['last_success'] ) ); ?></td></tr>
					<tr><th scope="row"><?php esc_html_e( 'Last sync error', 'inmolink' ); ?></th><td><?php echo esc_html( '' !== $state['last_error'] ? (string) $state['last_error'] : '—' ); ?></td></tr>
					<tr><th scope="row"><?php esc_html_e( 'Mirrored detail pages', 'inmolink' ); ?></th><td><?php echo esc_html( number_format_i18n( ( new Mirror() )->count() ) ); ?></td></tr>
					<tr><th scope="row"><?php esc_html_e( 'API reachable', 'inmolink' ); ?></th><td><?php echo esc_html( Client::in_backoff() ? __( 'No — serving cached copies', 'inmolink' ) : __( 'Yes', 'inmolink' ) ); ?></td></tr>
				</tbody>
			</table>
			<p>
				<?php $this->button( self::TEST, __( 'Test connection', 'inmolink' ) ); ?>
				<?php $this->button( self::SYNC, __( 'Sync now', 'inmolink' ) ); ?>
			</p>
		</div>
		<?php
	}

	/**
	 * Capability and nonce check for an admin-post action.
	 *
	 * @param string $action Action (also the nonce action).
	 */
	private function guard( string $action ): void {
		if ( ! current_user_can( self::CAPABILITY ) ) {
			wp_die( esc_html__( 'You do not have permission to do this.', 'inmolink' ), 403 );
		}
		check_admin_referer( $action );
	}

	/**
	 * Redirects back to the page with a notice code.
	 *
	 * @param string $notice Notice code.
	 */
	private function finish( string $notice ): void {
		wp_safe_redirect(
			add_query_arg(
				array(
					'page'            => self::SLUG,
					'inmolink_notice' => $notice,
				),
				admin_url( 'options-general.php' )
			)
		);
		exit;
	}

	/**
	 * A one-button form posting an admin action.
	 *
	 * @param string $action Action.
	 * @param string $label  Label.
	 */
	private function button( string $action, string $label ): void {
		?>
		<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" style="display:inline-block;margin-right:8px">
			<input type="hidden" name="action" value="<?php echo esc_attr( $action ); ?>" />
			<?php wp_nonce_field( $action ); ?>
			<?php submit_button( $label, 'secondary', 'submit', false ); ?>
		</form>
		<?php
	}

	/**
	 * Prints a notice for a known code.
	 *
	 * @param string $code Notice code.
	 */
	private function notice( string $code ): void {
		if ( ! in_array( $code, self::NOTICES, true ) ) {
			return;
		}
		$messages               = array(
			'saved'       => array( 'success', __( 'Settings saved.', 'inmolink' ) ),
			'key_reentry' => array( 'warning', __( 'Settings saved. The API URL changed, so the stored key was removed: enter the key for the new URL.', 'inmolink' ) ),
			'key_invalid' => array( 'error', __( 'Settings saved, but the API key was not: enter a secret key (inl_live_sk… or inl_test_sk…).', 'inmolink' ) ),
			'test_ok'     => array( 'success', __( 'The API answered.', 'inmolink' ) ),
			'test_failed' => array( 'error', __( 'The API could not be reached with these settings.', 'inmolink' ) ),
			'synced'      => array( 'success', __( 'Sync finished.', 'inmolink' ) ),
			'sync_failed' => array( 'error', __( 'Sync did not finish; it will retry on the next run.', 'inmolink' ) ),
		);
		list( $type, $message ) = $messages[ $code ];
		printf( '<div class="notice notice-%1$s is-dismissible"><p>%2$s</p></div>', esc_attr( $type ), esc_html( $message ) );
	}

	/**
	 * "5 mins ago" or a dash.
	 *
	 * @param int $time Unix time.
	 */
	private function when( int $time ): string {
		if ( $time <= 0 ) {
			return '—';
		}
		/* translators: %s: human time difference, e.g. "5 mins". */
		return sprintf( __( '%s ago', 'inmolink' ), human_time_diff( $time ) );
	}
}
