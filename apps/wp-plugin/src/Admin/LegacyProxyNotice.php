<?php
/**
 * Admin notice: the deprecated single trusted-header setting.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\Admin;

use Inmolink\Plugin\Net\Ip;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * `INMOLINK_TRUSTED_PROXY_HEADER` without `INMOLINK_TRUSTED_PROXIES` is the pre-S8-F29 setting: the header is read from
 * every request, so anyone reaching the site directly (not through the proxy) chooses the visitor address the per-IP
 * limits count. It still works (the rightmost value, see {@see Ip::client()}) but is deprecated: tells administrators
 * to name the proxy's address ranges (S10-F6).
 */
final class LegacyProxyNotice {

	/**
	 * Registers the notice (site and network admin).
	 */
	public static function register(): void {
		add_action( 'admin_notices', array( self::class, 'render' ) );
		add_action( 'network_admin_notices', array( self::class, 'render' ) );
	}

	/**
	 * Whether only the legacy header setting is used (a header named, no proxy ranges).
	 */
	public static function legacy_only(): bool {
		return null !== Ip::trusted_header() && array() === Ip::trusted_proxies();
	}

	/**
	 * Prints the notice to administrators.
	 */
	public static function render(): void {
		if ( ! current_user_can( SettingsPage::CAPABILITY ) || ! self::legacy_only() ) {
			return;
		}
		printf(
			'<div class="notice notice-warning"><p>%s</p></div>',
			esc_html__( 'Inmolink: INMOLINK_TRUSTED_PROXY_HEADER without INMOLINK_TRUSTED_PROXIES is deprecated and will stop being read in a future version. Add your proxy\'s address ranges to wp-config.php as INMOLINK_TRUSTED_PROXIES, so the visitor address is only read from requests your proxy forwarded.', 'inmolink' )
		);
	}
}
