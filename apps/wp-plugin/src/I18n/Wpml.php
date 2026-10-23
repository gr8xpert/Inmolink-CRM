<?php
/**
 * WPML adapter.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\I18n;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

// phpcs:disable WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- WPML's own filter API.

/**
 * WPML through its documented filter API (`wpml_active_languages`, `wpml_current_language`, `wpml_default_language`,
 * `wpml_permalink`).
 */
final class Wpml implements Languages {

	/**
	 * Whether WPML is active.
	 */
	public static function available(): bool {
		return defined( 'ICL_SITEPRESS_VERSION' ) && false !== has_filter( 'wpml_active_languages' );
	}

	/**
	 * Active language codes, default first.
	 *
	 * @return string[]
	 */
	public function languages(): array {
		$active  = apply_filters( 'wpml_active_languages', null, array( 'skip_missing' => 0 ) );
		$codes   = is_array( $active ) ? array_values( array_map( 'strval', array_keys( $active ) ) ) : array();
		$default = (string) apply_filters( 'wpml_default_language', null );
		usort( $codes, static fn ( string $a, string $b ): int => ( $b === $default ) <=> ( $a === $default ) );
		return $codes;
	}

	/**
	 * The current language code.
	 */
	public function current(): string {
		$current = apply_filters( 'wpml_current_language', null );
		return is_string( $current ) && '' !== $current ? $current : (string) apply_filters( 'wpml_default_language', null );
	}

	/**
	 * The language's home URL.
	 *
	 * @param string $lang Language code.
	 */
	public function home_url( string $lang ): string {
		return trailingslashit( (string) apply_filters( 'wpml_permalink', home_url( '/' ), $lang, true ) );
	}

	/**
	 * WPML detects the language from the URL itself.
	 *
	 * @param string $lang Language code.
	 * @return array<string,string>
	 */
	public function query_vars( string $lang ): array {
		unset( $lang );
		return array();
	}
}
