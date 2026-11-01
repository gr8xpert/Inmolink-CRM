<?php
/**
 * Polylang's public functions, behind one seam.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\I18n;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * The `pll_*` functions the {@see Polylang} adapter uses (Polylang's documented function reference). Tests replace this
 * class with a fake that reproduces Polylang's documented URL behaviours, because defining the global `pll_*` functions
 * would switch every later test in the process to Polylang.
 */
class PolylangApi {

	/**
	 * `pll_languages_list( array( 'fields' => 'slug' ) )`.
	 *
	 * @return string[]
	 */
	public function languages_list(): array {
		return array_values( array_map( 'strval', (array) pll_languages_list( array( 'fields' => 'slug' ) ) ) );
	}

	/**
	 * `pll_default_language( 'slug' )`, or '' when unknown.
	 */
	public function default_language(): string {
		return function_exists( 'pll_default_language' ) ? (string) pll_default_language( 'slug' ) : '';
	}

	/**
	 * `pll_current_language( 'slug' )`, or '' before Polylang has detected one.
	 */
	public function current_language(): string {
		$current = pll_current_language( 'slug' );
		return is_string( $current ) ? $current : '';
	}

	/**
	 * `pll_home_url( $slug )`: the language's home page URL — the translated static front page's URL when the site
	 * uses one and "The front page URL contains the language code instead of the page name" is off.
	 *
	 * @param string $slug Language slug.
	 */
	public function home_url( string $slug ): string {
		return (string) pll_home_url( $slug );
	}

	/**
	 * `pll_get_post( $post_id, $slug )`: the post's translation, or 0.
	 *
	 * @param int    $post_id Post ID.
	 * @param string $slug    Language slug.
	 */
	public function get_post( int $post_id, string $slug ): int {
		return function_exists( 'pll_get_post' ) ? (int) pll_get_post( $post_id, $slug ) : 0;
	}
}
