<?php
/**
 * Plugin settings: API endpoint, secret key, locales and cache lifetimes.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin;

use Inmolink\Plugin\Net\Ip;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Reads and writes the plugin's options. Everything is stored with autoload off; the API secret key is stored
 * encrypted ({@see Crypto}) in its own option and is never returned to a browser. `INMOLINK_API_KEY` /
 * `INMOLINK_API_BASE` in wp-config.php take precedence over the stored values.
 */
final class Settings {

	public const OPTION     = 'inmolink_settings';
	public const KEY_OPTION = 'inmolink_api_key';
	/**
	 * The production website API (feed-api, `infra/kamal/feed-api.production.yml`). Pinned on purpose: a key from
	 * `INMOLINK_API_KEY` without `INMOLINK_API_BASE` is only ever sent here.
	 */
	public const DEFAULT_API_BASE = 'https://feed.inmolink.es';
	public const DEFAULT_TTL      = 300;
	public const MIN_TTL          = 60;
	public const MAX_TTL          = DAY_IN_SECONDS;
	/** How long a cached answer stays usable as a stale fallback, in days. */
	public const DEFAULT_STALE_DAYS = 7;
	public const MAX_LOCALES        = 10;
	/** The website API's `lang` format. */
	public const LANG_PATTERN = '/^[a-z]{2}(-[A-Z]{2})?$/';

	/**
	 * Defaults for every setting except the key.
	 *
	 * @return array{api_base:string,locales:list<string>,default_locale:string,cache_ttl:int,stale_days:int,listing_base:string,development_base:string,turnstile_site_key:string}
	 */
	public static function defaults(): array {
		return array(
			'api_base'           => self::DEFAULT_API_BASE,
			'locales'            => array( 'en' ),
			'default_locale'     => 'en',
			'cache_ttl'          => self::DEFAULT_TTL,
			'stale_days'         => self::DEFAULT_STALE_DAYS,
			'listing_base'       => 'property',
			'development_base'   => 'development',
			'turnstile_site_key' => '',
		);
	}

	/**
	 * The current settings, sanitized and merged over the defaults.
	 *
	 * @return array{api_base:string,locales:list<string>,default_locale:string,cache_ttl:int,stale_days:int,listing_base:string,development_base:string,turnstile_site_key:string}
	 */
	public static function all(): array {
		static $memo_raw = null, $memo_values = null;
		$stored          = get_option( self::OPTION, array() );
		$stored          = is_array( $stored ) ? $stored : array();
		if ( $memo_raw === $stored && null !== $memo_values ) {
			return $memo_values;
		}
		$values = self::sanitize( $stored );
		if ( defined( 'INMOLINK_API_BASE' ) && is_string( INMOLINK_API_BASE ) ) {
			$values['api_base'] = self::sanitize_base( INMOLINK_API_BASE );
		}
		$memo_raw    = $stored;
		$memo_values = $values;
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
	 * @return array{api_base:string,locales:list<string>,default_locale:string,cache_ttl:int,stale_days:int,listing_base:string,development_base:string,turnstile_site_key:string}
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
		foreach ( array( 'listing_base', 'development_base' ) as $name ) {
			if ( isset( $input[ $name ] ) && is_string( $input[ $name ] ) ) {
				$value = self::sanitize_bases( $input[ $name ], $out['locales'] );
				if ( '' !== $value ) {
					$out[ $name ] = $value;
				}
			}
		}
		if ( isset( $input['turnstile_site_key'] ) && is_string( $input['turnstile_site_key'] ) ) {
			$key                       = trim( $input['turnstile_site_key'] );
			$out['turnstile_site_key'] = Forms\Turnstile::valid_site_key( $key ) ? $key : '';
		}
		if ( self::bases_overlap( $out['listing_base'], $out['development_base'], $out['locales'] ) ) {
			$out['development_base'] = self::defaults()['development_base'];
		}

		return $out;
	}

	/**
	 * Sanitizes a URL base setting: `property` (every locale) or `property, es:propiedad, de:immobilie` (a default plus
	 * per-locale slugs). Returns the canonical form, or '' when nothing valid remains.
	 *
	 * @param string   $raw     Raw value.
	 * @param string[] $locales Configured locales.
	 */
	public static function sanitize_bases( string $raw, array $locales ): string {
		$default = '';
		$per     = array();
		foreach ( explode( ',', $raw ) as $part ) {
			$part = trim( $part );
			if ( '' === $part ) {
				continue;
			}
			if ( str_contains( $part, ':' ) ) {
				list( $locale, $slug ) = array_map( 'trim', explode( ':', $part, 2 ) );
				$slug                  = sanitize_title( $slug );
				if ( '' !== $slug && in_array( $locale, $locales, true ) ) {
					$per[ $locale ] = $slug;
				}
			} elseif ( '' === $default ) {
				$default = sanitize_title( $part );
			}
		}
		if ( '' === $default ) {
			return '';
		}
		$out = array( $default );
		foreach ( $per as $locale => $slug ) {
			$out[] = $locale . ':' . $slug;
		}
		return implode( ',', $out );
	}

	/**
	 * The URL base for listings or developments in a locale.
	 *
	 * @param string      $kind   `listing` or `development`.
	 * @param string      $locale API locale.
	 * @param string|null $value The setting (defaults to the stored one).
	 */
	public static function base_for( string $kind, string $locale, ?string $value = null ): string {
		$value   = $value ?? (string) self::get( 'development' === $kind ? 'development_base' : 'listing_base' );
		$parts   = explode( ',', $value );
		$default = (string) array_shift( $parts );
		foreach ( $parts as $part ) {
			list( $l, $slug ) = array_pad( explode( ':', $part, 2 ), 2, '' );
			if ( $l === $locale && '' !== $slug ) {
				return $slug;
			}
		}
		return $default;
	}

	/**
	 * Whether the listing and development bases collide in any locale (their routes would shadow each other).
	 *
	 * @param string   $listing     Listing base setting.
	 * @param string   $development Development base setting.
	 * @param string[] $locales     Locales.
	 */
	private static function bases_overlap( string $listing, string $development, array $locales ): bool {
		foreach ( $locales as $locale ) {
			if ( self::base_for( 'listing', $locale, $listing ) === self::base_for( 'development', $locale, $development ) ) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Saves the settings (sanitized, autoload off).
	 *
	 * @param array<string,mixed> $input Raw values.
	 */
	public static function save( array $input ): void {
		$before = (string) self::get( 'api_base' );
		$old    = self::all();
		update_option( self::OPTION, self::sanitize( $input ), false );
		$new = self::all();
		foreach ( array( 'listing_base', 'development_base', 'locales', 'default_locale' ) as $name ) {
			if ( $old[ $name ] !== $new[ $name ] ) {
				Routing\Router::schedule_flush();
				break;
			}
		}
		if ( (string) self::get( 'api_base' ) !== $before ) {
			// The stored key belongs to the old endpoint: it must be entered again for the new one.
			self::clear_api_key();
		}
	}

	/**
	 * The API base URL ({@see sanitize_base_for()} with the wp-config opt-in for a local API).
	 *
	 * @param string $url Raw URL.
	 */
	public static function sanitize_base( string $url ): string {
		return self::sanitize_base_for( $url, self::allow_local_api() );
	}

	/**
	 * An API base URL: `https://host[:port]` with nothing else — no userinfo, path, query or fragment. A loopback
	 * host (and plain http, only there) is accepted only with the wp-config opt-in, never from the settings page alone.
	 *
	 * @param string $url         Raw URL.
	 * @param bool   $allow_local `INMOLINK_ALLOW_LOCAL_API` is set.
	 */
	public static function sanitize_base_for( string $url, bool $allow_local ): string {
		$url = trim( $url );
		if ( '' === $url || preg_match( '/[\s<>"\'\\\\]/', $url ) ) {
			return '';
		}
		$parts = wp_parse_url( $url );
		if ( ! is_array( $parts ) || empty( $parts['host'] ) || empty( $parts['scheme'] )
			|| isset( $parts['user'] ) || isset( $parts['pass'] ) || isset( $parts['query'] ) || isset( $parts['fragment'] )
			|| ( isset( $parts['path'] ) && '' !== $parts['path'] && '/' !== $parts['path'] )
			|| str_contains( $url, '#' ) || str_contains( $url, '?' ) || str_contains( $url, '@' ) ) {
			return '';
		}
		$scheme = strtolower( $parts['scheme'] );
		$host   = strtolower( $parts['host'] );
		$local  = self::is_local_host( $host );
		if ( $local && ! $allow_local ) {
			return '';
		}
		if ( 'https' !== $scheme && ! ( 'http' === $scheme && $local ) ) {
			return '';
		}
		if ( ! preg_match( '/^(\[[0-9a-f:]+\]|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)$/', $host ) ) {
			return '';
		}
		if ( ! $allow_local ) {
			// An address literal must be public (S8-F23); so-called numeric hosts such as `2130706433` or `0x7f.1` are
			// read as addresses by resolvers and never accepted. Names are checked after DNS resolution (ApiGuard).
			$bare = trim( $host, '[]' );
			if ( Ip::valid( $bare ) ? ! Ip::is_public( $bare ) : 1 === preg_match( '/(^|\.)(0x[0-9a-f]*|[0-9]+)$/', $host ) ) {
				return '';
			}
		}
		return $scheme . '://' . $host . ( isset( $parts['port'] ) ? ':' . (int) $parts['port'] : '' );
	}

	/**
	 * `INMOLINK_ALLOW_LOCAL_API` in wp-config.php: lets the API be on this machine (development). Site admins cannot
	 * set it, so the settings page can never relax WordPress's loopback / private-network protection.
	 */
	public static function allow_local_api(): bool {
		return defined( 'INMOLINK_ALLOW_LOCAL_API' ) && true === INMOLINK_ALLOW_LOCAL_API;
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
	 * The API secret key, or '' when none is set (or it can no longer be decrypted).
	 */
	public static function api_key(): string {
		$base = (string) self::get( 'api_base' );
		if ( self::key_from_constant() ) {
			$const_base = defined( 'INMOLINK_API_BASE' ) && is_string( INMOLINK_API_BASE ) ? INMOLINK_API_BASE : null;
			return self::constant_key_allowed( $base, $const_base ) ? INMOLINK_API_KEY : '';
		}
		$sealed = get_option( self::KEY_OPTION, '' );
		if ( ! is_string( $sealed ) || '' === $sealed ) {
			return '';
		}
		return self::stored_key_for( (string) ( Crypto::open( $sealed ) ?? '' ), $base );
	}

	/**
	 * Whether the wp-config key may be sent to a base: only to `INMOLINK_API_BASE` when that is defined, else only to
	 * the production API ({@see DEFAULT_API_BASE}). A settings-page URL never receives it.
	 *
	 * @param string      $base       The base the request goes to.
	 * @param string|null $const_base `INMOLINK_API_BASE`, if defined.
	 */
	public static function constant_key_allowed( string $base, ?string $const_base ): bool {
		if ( '' === $base ) {
			return false;
		}
		if ( null !== $const_base ) {
			return self::sanitize_base( $const_base ) === $base;
		}
		return self::DEFAULT_API_BASE === $base;
	}

	/**
	 * The stored key when it was entered for this base (it is sealed together with its base), else ''.
	 *
	 * @param string $opened The decrypted option (`{"base":…,"key":…}`).
	 * @param string $base   The current base.
	 */
	public static function stored_key_for( string $opened, string $base ): string {
		$data = json_decode( $opened, true );
		if ( ! is_array( $data ) || ! isset( $data['base'], $data['key'] ) || ! is_string( $data['key'] ) || '' === $base ) {
			return '';
		}
		return $data['base'] === $base ? $data['key'] : '';
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
		$base = (string) self::get( 'api_base' );
		if ( '' === $base ) {
			return false;
		}
		// Sealed with its endpoint: the key is only ever sent to the base it was entered for.
		update_option(
			self::KEY_OPTION,
			Crypto::seal(
				(string) wp_json_encode(
					array(
						'base' => $base,
						'key'  => $key,
					)
				)
			),
			false
		);
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
