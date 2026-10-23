<?php
/**
 * Polylang adapter.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\I18n;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Polylang through its public functions (`pll_*`). Its rewrite rules carry `lang`, so ours do too.
 */
final class Polylang implements Languages {

	/**
	 * Whether Polylang is active.
	 */
	public static function available(): bool {
		return function_exists( 'pll_languages_list' ) && function_exists( 'pll_current_language' ) && function_exists( 'pll_home_url' );
	}

	/**
	 * Language slugs, default first.
	 *
	 * @return string[]
	 */
	public function languages(): array {
		$list    = array_values( array_map( 'strval', (array) pll_languages_list( array( 'fields' => 'slug' ) ) ) );
		$default = function_exists( 'pll_default_language' ) ? (string) pll_default_language( 'slug' ) : '';
		usort( $list, static fn ( string $a, string $b ): int => ( $b === $default ) <=> ( $a === $default ) );
		return $list;
	}

	/**
	 * The current language slug (the default before Polylang has detected one).
	 */
	public function current(): string {
		$current = pll_current_language( 'slug' );
		if ( is_string( $current ) && '' !== $current ) {
			return $current;
		}
		return function_exists( 'pll_default_language' ) ? (string) pll_default_language( 'slug' ) : '';
	}

	/**
	 * The language's home URL.
	 *
	 * @param string $lang Language slug.
	 */
	public function home_url( string $lang ): string {
		return trailingslashit( (string) pll_home_url( $lang ) );
	}

	/**
	 * Polylang reads the language from `lang`.
	 *
	 * @param string $lang Language slug.
	 * @return array<string,string>
	 */
	public function query_vars( string $lang ): array {
		return array( 'lang' => $lang );
	}
}
