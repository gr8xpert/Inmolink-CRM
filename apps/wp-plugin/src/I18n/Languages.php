<?php
/**
 * Multilingual plugin adapter contract.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\I18n;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * What the router, URL builder and SEO layer need from a multilingual setup: the site's languages, the current one,
 * and the home URL each one lives under. Language codes here are the multilingual plugin's (e.g. `es`); the API
 * locale is derived with {@see Locale::api_locale()}.
 */
interface Languages {

	/**
	 * The site's languages (codes), default first.
	 *
	 * @return string[]
	 */
	public function languages(): array;

	/**
	 * The language of the current request.
	 */
	public function current(): string;

	/**
	 * The language-specific home URL (with trailing slash), e.g. `https://example.com/es/`.
	 *
	 * @param string $lang Language code.
	 */
	public function home_url( string $lang ): string;

	/**
	 * Extra query vars a rewrite rule for this language sets (e.g. Polylang's `lang`).
	 *
	 * @param string $lang Language code.
	 * @return array<string,string>
	 */
	public function query_vars( string $lang ): array;
}
