<?php
/**
 * Admin notice: WordPress salts stored in the database.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\Admin;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * The stored API key is encrypted under a key derived from the `auth` salts ({@see \Inmolink\Plugin\Crypto}). When
 * `AUTH_KEY` / `AUTH_SALT` are missing from wp-config.php WordPress keeps generated ones in the database, so a database
 * dump alone could decrypt the key. Tells administrators to define them (S8-F17).
 */
final class SaltNotice {

	/** WordPress treats this value as "not set". */
	private const PLACEHOLDER = 'put your unique phrase here';
	/** The eight constants `wp_salt()` reads. */
	private const CONSTANTS = array( 'AUTH_KEY', 'SECURE_AUTH_KEY', 'LOGGED_IN_KEY', 'NONCE_KEY', 'AUTH_SALT', 'SECURE_AUTH_SALT', 'LOGGED_IN_SALT', 'NONCE_SALT' );

	/**
	 * Registers the notice (site and network admin).
	 */
	public static function register(): void {
		add_action( 'admin_notices', array( self::class, 'render' ) );
		add_action( 'network_admin_notices', array( self::class, 'render' ) );
	}

	/**
	 * Whether the salts the key encryption uses are not set in wp-config.php (the same test `wp_salt()` applies).
	 * The `inmolink_wp_config_salts` filter replaces the constants' values (tests).
	 */
	public static function in_database(): bool {
		$values = array();
		foreach ( self::CONSTANTS as $name ) {
			$values[ $name ] = defined( $name ) ? constant( $name ) : null;
		}
		$values = apply_filters( 'inmolink_wp_config_salts', $values );
		$values = is_array( $values ) ? $values : array();

		// Like wp_salt(): a value used by more than one of the eight constants counts as unset.
		$seen = array();
		foreach ( self::CONSTANTS as $name ) {
			if ( isset( $values[ $name ] ) && is_string( $values[ $name ] ) ) {
				$seen[ $values[ $name ] ] = ( $seen[ $values[ $name ] ] ?? 0 ) + 1;
			}
		}
		foreach ( array( 'AUTH_KEY', 'AUTH_SALT' ) as $name ) {
			$value = $values[ $name ] ?? null;
			if ( ! is_string( $value ) || '' === $value || self::PLACEHOLDER === $value || $seen[ $value ] > 1 ) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Prints the notice to administrators.
	 */
	public static function render(): void {
		if ( ! current_user_can( SettingsPage::CAPABILITY ) || ! self::in_database() ) {
			return;
		}
		printf(
			'<div class="notice notice-warning"><p>%s</p></div>',
			esc_html__( 'Inmolink: your WordPress security keys and salts are stored in the database, not in wp-config.php. A copy of the database alone could then decrypt the stored API key. Add unique AUTH_KEY and AUTH_SALT values to wp-config.php (generate them at https://api.wordpress.org/secret-key/1.1/salt/), then enter the API key again.', 'inmolink' )
		);
	}
}
