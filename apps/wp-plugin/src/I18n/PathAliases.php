<?php
/**
 * Optional adapter capability: extra request paths a language's pages may be matched under.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\I18n;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * For a multilingual plugin that changes the path WordPress matches rewrite rules against. WordPress removes the path
 * of the (filtered) `home_url()` from the request before matching; a plugin that filters `home_url()` to the language
 * directory during the request (WPML in directory mode) therefore has `/es/propiedad/X/` matched as `propiedad/X/`.
 * A separate interface so adapters supplied through `inmolink_language_adapter` keep working unchanged.
 */
interface PathAliases {

	/**
	 * The URL path prefixes (`'es/'`, `''`) rewrite rules for a language are registered under, most specific first.
	 *
	 * @param string $lang   Language code.
	 * @param string $prefix The language's prefix from its home URL.
	 * @return string[]
	 */
	public function request_prefixes( string $lang, string $prefix ): array;
}
