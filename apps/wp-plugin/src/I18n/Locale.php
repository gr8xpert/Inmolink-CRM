<?php
/**
 * The active language adapter.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\I18n;

use Inmolink\Plugin\Settings;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Picks the adapter (Polylang, WPML, or none; the `inmolink_language_adapter` filter can supply another) and maps
 * its language codes to API locales.
 */
final class Locale {

	/**
	 * The adapter for this request.
	 *
	 * @var Languages|null
	 */
	private static ?Languages $adapter = null;

	/**
	 * The adapter.
	 */
	public static function adapter(): Languages {
		if ( null === self::$adapter ) {
			$detected      = Polylang::available() ? new Polylang() : ( Wpml::available() ? new Wpml() : new NoMultilingual() );
			$filtered      = apply_filters( 'inmolink_language_adapter', $detected );
			self::$adapter = $filtered instanceof Languages ? $filtered : $detected;
		}
		return self::$adapter;
	}

	/**
	 * Forgets the adapter (tests, WP-CLI).
	 */
	public static function reset(): void {
		self::$adapter = null;
	}

	/**
	 * The API locale for a site language code (`es_ES`, `es-es`, `es` → the closest configured locale).
	 *
	 * @param string $lang Language code.
	 */
	public static function api_locale( string $lang ): string {
		$lang = str_replace( '_', '-', trim( $lang ) );
		if ( preg_match( '/^([a-zA-Z]{2})(?:-([a-zA-Z]{2}))?$/', $lang, $m ) ) {
			$lang = strtolower( $m[1] ) . ( isset( $m[2] ) ? '-' . strtoupper( $m[2] ) : '' );
		}
		return Settings::resolve_locale( $lang );
	}

	/**
	 * The current request's API locale (a routed page's language wins).
	 */
	public static function current(): string {
		$routed = get_query_var( 'inmolink_lang' );
		if ( is_string( $routed ) && '' !== $routed ) {
			return self::api_locale( $routed );
		}
		return self::api_locale( self::adapter()->current() );
	}

	/**
	 * The site language code for an API locale (the first that maps to it), for building URLs.
	 *
	 * @param string $locale API locale.
	 */
	public static function site_language( string $locale ): string {
		foreach ( self::adapter()->languages() as $lang ) {
			if ( self::api_locale( $lang ) === $locale ) {
				return $lang;
			}
		}
		return self::adapter()->current();
	}

	/**
	 * The site's languages as language code => API locale.
	 *
	 * @return array<string,string>
	 */
	public static function routable(): array {
		$out = array();
		foreach ( self::adapter()->languages() as $lang ) {
			$out[ $lang ] = self::api_locale( $lang );
		}
		return $out;
	}
}
