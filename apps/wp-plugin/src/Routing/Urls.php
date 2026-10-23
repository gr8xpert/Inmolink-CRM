<?php
/**
 * Pretty URLs for listings and developments.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\Routing;

use Inmolink\Plugin\I18n\Locale;
use Inmolink\Plugin\Settings;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * `{language home}{base}/{ref}/{slug}/` — e.g. `/property/INM-1001/villa-sol/`, `/es/propiedad/INM-1001/villa-sol/`.
 * The reference identifies the page (a slug alone is not unique across locales and changes with the title); the
 * slug is for people and search engines, and a wrong one redirects to the canonical URL. Without pretty permalinks
 * the query-string form is used.
 */
final class Urls {

	/**
	 * A listing (or unit) detail URL.
	 *
	 * @param string $ref    Reference.
	 * @param string $slug   Slug in that locale ('' when unknown).
	 * @param string $locale API locale.
	 */
	public static function listing( string $ref, string $slug, string $locale ): string {
		return self::build( 'listing', $ref, $slug, $locale );
	}

	/**
	 * A development detail URL.
	 *
	 * @param string $ref    Development reference.
	 * @param string $slug   Slug ('' when unknown).
	 * @param string $locale API locale.
	 */
	public static function development( string $ref, string $slug, string $locale ): string {
		return self::build( 'development', $ref, $slug, $locale );
	}

	/**
	 * The URL for an API item (card or detail): listings, units and developments.
	 *
	 * @param array<string,mixed> $item   API item with `ref`, `slug` and `kind`.
	 * @param string              $locale API locale.
	 */
	public static function for_item( array $item, string $locale ): string {
		$ref  = isset( $item['ref'] ) && is_string( $item['ref'] ) ? $item['ref'] : '';
		$slug = isset( $item['slug'] ) && is_string( $item['slug'] ) ? $item['slug'] : '';
		if ( '' === $ref ) {
			return '';
		}
		return 'DEVELOPMENT' === ( $item['kind'] ?? '' ) ? self::development( $ref, $slug, $locale ) : self::listing( $ref, $slug, $locale );
	}

	/**
	 * A slug as it appears in URLs (and as the router compares it): `sanitize_title()` — lower case, accents
	 * transliterated, anything else percent-encoded. The API's slug may be any string.
	 *
	 * @param string $slug API slug.
	 */
	public static function slug( string $slug ): string {
		return sanitize_title( $slug );
	}

	/**
	 * The URL path prefix of a site language relative to the site home (`''` or `es/`).
	 *
	 * @param string $lang Site language code.
	 */
	public static function language_prefix( string $lang ): string {
		// The unfiltered home: multilingual plugins filter home_url() per current language.
		$home   = trailingslashit( (string) wp_parse_url( (string) get_option( 'home' ), PHP_URL_PATH ) );
		$lhome  = (string) wp_parse_url( Locale::adapter()->home_url( $lang ), PHP_URL_PATH );
		$prefix = 0 === strpos( $lhome, $home ) ? substr( $lhome, strlen( $home ) ) : '';
		$prefix = trim( $prefix, '/' );
		return '' === $prefix ? '' : $prefix . '/';
	}

	/**
	 * Builds a URL.
	 *
	 * @param string $kind   `listing` or `development`.
	 * @param string $ref    Reference.
	 * @param string $slug   Slug.
	 * @param string $locale API locale.
	 */
	private static function build( string $kind, string $ref, string $slug, string $locale ): string {
		$lang = Locale::site_language( $locale );
		if ( '' === (string) get_option( 'permalink_structure' ) ) {
			return add_query_arg(
				array(
					'inmolink_' . $kind => rawurlencode( $ref ),
					'inmolink_lang'     => rawurlencode( $lang ),
				),
				home_url( '/' )
			);
		}
		$path = Settings::base_for( $kind, $locale ) . '/' . rawurlencode( $ref ) . '/';
		$slug = self::slug( $slug );
		if ( '' !== $slug ) {
			$path .= $slug . '/';
		}
		return Locale::adapter()->home_url( $lang ) . $path;
	}
}
