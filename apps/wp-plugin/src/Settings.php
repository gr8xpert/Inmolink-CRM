<?php
/**
 * Plugin settings: API endpoint, secret key, locales and cache lifetimes.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Reads and writes the plugin's options. Everything is stored with autoload off; the API secret key is stored
 * encrypted ({@see Crypto}) in its own option and is never returned to a browser. `INMOLINK_API_KEY` /
 * `INMOLINK_API_BASE` in wp-config.php take precedence over the stored values.
 */
final class Settings {

	public const OPTION      = 'inmolink_settings';
	public const KEY_OPTION  = 'inmolink_api_key';
	public const DEFAULT_TTL = 300;
	public const MIN_TTL     = 60;
	public const MAX_TTL     = DAY_IN_SECONDS;
	/** How long a cached answer stays usable as a stale fallback, in days. */
	public const DEFAULT_STALE_DAYS = 7;
	public const MAX_LOCALES        = 10;
	/** The website API's `lang` format. */
	public const LANG_PATTERN = '/^[a-z]{2}(-[A-Z]{2})?$/';

	/**
	 * Defaults for every setting except the key.
	 *
	 * @return array{api_base:string,locales:list<string>,default_locale:string,cache_ttl:int,stale_days:int}
	 */
	public static function defaults(): array {
		return array(
			'api_base'       => '',
			'locales'        => array( 'en' ),
			'default_locale' => 'en',
			'cache_ttl'      => self::DEFAULT_TTL,
			'stale_days'     => self::DEFAULT_STALE_DAYS,
		);
	}

	/**
	 * The current settings, sanitized and merged over the defaults.
	 *
	 * @return array{api_base:string,locales:list<string>,default_locale:string,cache_ttl:int,stale_days:int}
	 */
	public static function all(): array {
		$stored = get_option( self::OPTION, array() );
		$values = self::sanitize( is_array( $stored ) ? $stored : array() );
		if ( defined( 'INMOLINK_API_BASE' ) && is_string( INMOLINK_API_BASE ) ) {
			$values['api_base'] = self::sanitize_base( INMOLINK_API_BASE );
		}
		return $values;
	}

	/**
	 * One setting.
	 *
	 * @param string $name Setting name.
	 * @return mixed
	 */
	public static function get( string $name ) {
		$all = self::all();
		return $all[ $name ] ?? null;
	}

	/**
	 * Sanitizes raw settings input (the admin form, or the stored option).
	 *
	 * @param array<string,mixed> $input Raw values.
	 * @return array{api_base:string,locales:list<string>,default_locale:string,cache_ttl:int,stale_days:int}
	 */
	public static function sanitize( array $input ): array {
		$out = self::defaults();

		if ( isset( $input['api_base'] ) && is_string( $input['api_base'] ) ) {
			$out['api_base'] = self::sanitize_base( $input['api_base'] );
		}

		if ( isset( $input['locales'] ) ) {
			$raw     = is_array( $input['locales'] ) ? $input['locales'] : explode( ',', (string) $input['locales'] );
			$locales = array();
			foreach ( $raw as $locale ) {
				$locale = trim( sanitize_text_field( (string) $locale ) );
				if ( preg_match( self::LANG_PATTERN, $locale ) && ! in_array( $locale, $locales, true ) ) {
					$locales[] = $locale;
				}
			}
			if ( array() !== $locales ) {
				$out['locales'] = array_slice( $locales, 0, self::MAX_LOCALES );
			}
		}

		if ( isset( $input['default_locale'] ) ) {
			$default = trim( sanitize_text_field( (string) $input['default_locale'] ) );
			if ( preg_match( self::LANG_PATTERN, $default ) ) {
				$out['default_locale'] = $default;
			}
		}
		if ( ! in_array( $out['default_locale'], $out['locales'], true ) ) {
			$out['default_locale'] = $out['locales'][0];
		}

		if ( isset( $input['cache_ttl'] ) && is_numeric( $input['cache_ttl'] ) ) {
			$out['cache_ttl'] = max( self::MIN_TTL, min( self::MAX_TTL, (int) $input['cache_ttl'] ) );
		}
		if ( isset( $input['stale_days'] ) && is_numeric( $input['stale_days'] ) ) {
			$out['stale_days'] = max( 1, min( 90, (int) $input['stale_days'] ) );
		}

		return $out;
	}

	/**
	 * Saves the settings (sanitized, autoload off).
	 *
	 * @param array<string,mixed> $input Raw values.
	 */
	public static function save( array $input ): void {
		update_option( self::OPTION, self::sanitize( $input ), false );
	}

	/**
	 * The API base URL: https only (http for localhost, or anywhere with `INMOLINK_ALLOW_HTTP` — development only:
	 * the secret key travels in a header).
	 *
	 * @param string $url Raw URL.
	 */
	public static function sanitize_base( string $url ): string {
		$url = esc_url_raw( trim( $url ), array( 'https', 'http' ) );
		if ( '' === $url ) {
			return '';
		}
		$parts = wp_parse_url( $url );
		if ( ! is_array( $parts ) || empty( $parts['host'] ) || isset( $parts['query'] ) || isset( $parts['user'] ) ) {
			return '';
		}
		$scheme = strtolower( $parts['scheme'] ?? '' );
		$plain  = defined( 'INMOLINK_ALLOW_HTTP' ) && INMOLINK_ALLOW_HTTP;
		if ( 'https' !== $scheme && ! ( 'http' === $scheme && ( self::is_local_host( $parts['host'] ) || $plain ) ) ) {
			return '';
		}
		return untrailingslashit( $url );
	}

	/**
	 * Whether a host is this machine (a local development API).
	 *
	 * @param string $host Host name.
	 */
	public static function is_local_host( string $host ): bool {
		return in_array( strtolower( $host ), array( 'localhost', '127.0.0.1', '[::1]', '::1' ), true );
	}

	/**
	 * Whether an API base URL points at this machine.
	 *
	 * @param string $base Base URL.
	 */
	public static function is_local_base( string $base ): bool {
		$host = wp_parse_url( $base, PHP_URL_HOST );
		return is_string( $host ) && self::is_local_host( $host );
	}

	/**
	 * The API secret key, or '' when none is set (or it can no longer be decrypted).
	 */
	public static function api_key(): string {
		if ( defined( 'INMOLINK_API_KEY' ) && is_string( INMOLINK_API_KEY ) && '' !== INMOLINK_API_KEY ) {
			return INMOLINK_API_KEY;
		}
		$sealed = get_option( self::KEY_OPTION, '' );
		if ( ! is_string( $sealed ) || '' === $sealed ) {
			return '';
		}
		return Crypto::open( $sealed ) ?? '';
	}

	/**
	 * Whether a key is stored (without decrypting it for display).
	 */
	public static function has_api_key(): bool {
		return '' !== self::api_key();
	}

	/**
	 * Whether the key comes from wp-config.php (the settings page then cannot change it).
	 */
	public static function key_from_constant(): bool {
		return defined( 'INMOLINK_API_KEY' ) && is_string( INMOLINK_API_KEY ) && '' !== INMOLINK_API_KEY;
	}

	/**
	 * Stores a new secret key, encrypted, autoload off. An invalid key is ignored.
	 *
	 * @param string $key The key as entered.
	 * @return bool Whether it was stored.
	 */
	public static function set_api_key( string $key ): bool {
		$key = trim( $key );
		if ( ! self::is_valid_key( $key ) ) {
			return false;
		}
		update_option( self::KEY_OPTION, Crypto::seal( $key ), false );
		return true;
	}

	/**
	 * Removes the stored key.
	 */
	public static function clear_api_key(): void {
		delete_option( self::KEY_OPTION );
	}

	/**
	 * A secret key: `inl_<env>_sk<10 base32>_<52 base32>` (core identity `api-keys`). Publishable keys (`pk…`) are
	 * for browsers and are refused here.
	 *
	 * @param string $key Candidate key.
	 */
	public static function is_valid_key( string $key ): bool {
		return 1 === preg_match( '/^inl_(live|test)_sk[a-z2-7]{10}_[a-z2-7]{52}$/', $key );
	}

	/**
	 * The configured locale closest to a requested one (exact, then language part), else the default.
	 *
	 * @param string|null $lang Requested locale.
	 */
	public static function resolve_locale( ?string $lang ): string {
		$settings = self::all();
		if ( null !== $lang && '' !== $lang ) {
			if ( in_array( $lang, $settings['locales'], true ) ) {
				return $lang;
			}
			$short = substr( $lang, 0, 2 );
			if ( in_array( $short, $settings['locales'], true ) ) {
				return $short;
			}
		}
		return $settings['default_locale'];
	}

	/**
	 * Whether the plugin can call the API.
	 */
	public static function is_configured(): bool {
		return '' !== self::get( 'api_base' ) && self::has_api_key();
	}
}
