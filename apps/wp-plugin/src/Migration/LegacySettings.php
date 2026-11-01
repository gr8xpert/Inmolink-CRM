<?php
/**
 * Settings migration from the legacy Inmolink plugin (S8-F11).
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\Migration;

use Inmolink\Plugin\Settings;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * On activation, copies the legacy plugin's options ({@see map()}, `legacy-map.php`) into the v2 settings and the
 * encrypted key, so a site that upgrades keeps syncing without the key being entered again.
 *
 * - Off unless enabled ({@see enabled()}): the legacy names are assumed until H15 confirms them.
 * - Read-only on the legacy options: they are never changed or deleted (a rollback to the legacy plugin still works).
 * - Never overwrites: v2 settings that already exist are kept; a key already stored (or set in wp-config.php) is kept.
 * - Runs once per site: the outcome is recorded in {@see MARKER_OPTION}, so re-activating after the admin cleared
 *   the key does not bring the legacy key back.
 */
final class LegacySettings {

	public const MARKER_OPTION = 'inmolink_legacy_migration';
	public const FLAG_CONSTANT = 'INMOLINK_MIGRATE_LEGACY_SETTINGS';

	/**
	 * The mapping table.
	 *
	 * @return array{status:string,fields:array<string,array{option:string,key?:string,unit?:string}>}
	 */
	public static function map(): array {
		return require __DIR__ . '/legacy-map.php';
	}

	/**
	 * Whether the migration runs: `INMOLINK_MIGRATE_LEGACY_SETTINGS` (true) in wp-config.php or the
	 * `inmolink_migrate_legacy_settings` filter. Default off while the mapping is ASSUMED (H15).
	 */
	public static function enabled(): bool {
		$default = defined( self::FLAG_CONSTANT ) && true === constant( self::FLAG_CONSTANT );
		return true === apply_filters( 'inmolink_migrate_legacy_settings', $default );
	}

	/**
	 * Runs the migration on the current site.
	 *
	 * @return array{status:string,settings:bool,key:string} `status`: disabled | already | no_legacy | migrated;
	 *         `key`: none | migrated | kept | invalid.
	 */
	public static function migrate(): array {
		$result = array(
			'status'   => 'disabled',
			'settings' => false,
			'key'      => 'none',
		);
		if ( ! self::enabled() ) {
			return $result;
		}
		if ( false !== get_option( self::MARKER_OPTION ) ) {
			$result['status'] = 'already';
			return $result;
		}
		$legacy = self::read();
		if ( array() === $legacy ) {
			$result['status'] = 'no_legacy';
			return $result;
		}
		$key = isset( $legacy['api_key'] ) ? trim( (string) $legacy['api_key'] ) : '';
		unset( $legacy['api_key'] );

		if ( array() !== $legacy && false === get_option( Settings::OPTION ) ) {
			Settings::save( $legacy );
			$result['settings'] = true;
		}
		if ( '' !== $key ) {
			$result['key'] = self::migrate_key( $key );
		}
		$result['status'] = 'migrated';
		update_option(
			self::MARKER_OPTION,
			array(
				'at'       => time(),
				'settings' => $result['settings'],
				'key'      => $result['key'],
				'map'      => self::map()['status'],
			),
			false
		);
		return $result;
	}

	/**
	 * Stores the legacy key unless one is already there.
	 *
	 * @param string $key Legacy key.
	 * @return string migrated | kept | invalid
	 */
	private static function migrate_key( string $key ): string {
		$stored = get_option( Settings::KEY_OPTION, '' );
		if ( Settings::key_from_constant() || ( is_string( $stored ) && '' !== $stored ) ) {
			return 'kept';
		}
		// Sealed with the current base (the pinned production API or INMOLINK_API_BASE), like a key typed in.
		return Settings::set_api_key( $key ) ? 'migrated' : 'invalid';
	}

	/**
	 * The legacy values that exist, as v2 setting => raw value (minutes converted to seconds).
	 *
	 * @return array<string,mixed>
	 */
	public static function read(): array {
		$own = array( Settings::OPTION, Settings::KEY_OPTION, self::MARKER_OPTION );
		$out = array();
		foreach ( self::map()['fields'] as $setting => $source ) {
			if ( in_array( $source['option'], $own, true ) ) {
				continue; // A mapping can never read the v2 plugin's own options.
			}
			$value = get_option( $source['option'], null );
			if ( isset( $source['key'] ) ) {
				$value = is_array( $value ) && array_key_exists( $source['key'], $value ) ? $value[ $source['key'] ] : null;
			}
			if ( null === $value || '' === $value || ( ! is_scalar( $value ) && ! is_array( $value ) ) ) {
				continue;
			}
			if ( 'minutes' === ( $source['unit'] ?? '' ) ) {
				if ( ! is_numeric( $value ) ) {
					continue;
				}
				$value = (int) $value * MINUTE_IN_SECONDS;
			}
			if ( 'locales' === $setting || 'default_locale' === $setting ) {
				$value = is_array( $value ) ? array_map( array( self::class, 'locale' ), $value ) : implode( ',', array_map( array( self::class, 'locale' ), explode( ',', (string) $value ) ) );
			}
			$out[ $setting ] = $value;
		}
		return $out;
	}

	/**
	 * A legacy language code as an API locale (`es_ES` → `es-ES`).
	 *
	 * @param mixed $code Code.
	 */
	private static function locale( $code ): string {
		return str_replace( '_', '-', trim( (string) $code ) );
	}
}
