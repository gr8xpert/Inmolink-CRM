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
 * Polylang through its public functions (`pll_*`, {@see PolylangApi}). Its rewrite rules carry `lang`, so ours do too.
 *
 * Documented behaviours handled (S8-F21):
 * - With a static front page and "The front page URL contains the language code instead of the page name" off,
 *   `pll_home_url()` is the translated front page (`/es/inicio/`), not the language root: the page path is removed,
 *   so URLs and rewrite prefixes stay `/es/…` instead of `/es/inicio/…`.
 * - In directory mode Polylang rewrites rules it filters (prefix `(en|es)/`, `lang=$matches[1]`, matches shifted).
 *   Ours are not in its `pll_rewrite_rules` list, and {@see \Inmolink\Plugin\Routing\Router::guard_rules()} restores
 *   them if anything prefixes them anyway (no double prefix, no shifted `$matches`).
 */
final class Polylang implements Languages {

	/**
	 * Polylang's functions.
	 *
	 * @var PolylangApi
	 */
	private PolylangApi $pll;

	/**
	 * Uses the real `pll_*` functions unless given another implementation (tests).
	 *
	 * @param PolylangApi|null $pll Polylang's functions.
	 */
	public function __construct( ?PolylangApi $pll = null ) {
		$this->pll = $pll ?? new PolylangApi();
	}

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
		$list    = $this->pll->languages_list();
		$default = $this->pll->default_language();
		usort( $list, static fn ( string $a, string $b ): int => ( $b === $default ) <=> ( $a === $default ) );
		return $list;
	}

	/**
	 * The current language slug (the default before Polylang has detected one).
	 */
	public function current(): string {
		$current = $this->pll->current_language();
		return '' !== $current ? $current : $this->pll->default_language();
	}

	/**
	 * The language's root URL (with trailing slash), without the translated front page's path.
	 *
	 * @param string $lang Language slug.
	 */
	public function home_url( string $lang ): string {
		$url   = Locale::slash_home( $this->pll->home_url( $lang ) );
		$front = (int) get_option( 'page_on_front' );
		if ( 'page' !== get_option( 'show_on_front' ) || $front <= 0 ) {
			return $url;
		}
		$page = $this->pll->get_post( $front, $lang );
		$uri  = $page > 0 ? (string) get_page_uri( $page ) : '';
		if ( '' === $uri ) {
			return $url;
		}
		$path = (string) wp_parse_url( $url, PHP_URL_PATH );
		$tail = '/' . trim( $uri, '/' ) . '/';
		$pos  = strpos( $url, $path, (int) strpos( $url, '//' ) + 2 );
		if ( false !== $pos && strlen( $path ) >= strlen( $tail ) && substr( $path, -strlen( $tail ) ) === $tail ) {
			$root = substr( $path, 0, strlen( $path ) - strlen( $tail ) + 1 );
			$url  = substr( $url, 0, $pos ) . $root . substr( $url, $pos + strlen( $path ) );
		}
		return $url;
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
