<?php
/**
 * A single-language site.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\I18n;

use Inmolink\Plugin\Settings;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * No multilingual plugin: one language (the default locale), no URL prefix.
 */
final class NoMultilingual implements Languages {

	/**
	 * The default locale.
	 *
	 * @return string[]
	 */
	public function languages(): array {
		return array( (string) Settings::get( 'default_locale' ) );
	}

	/**
	 * The default locale.
	 */
	public function current(): string {
		return (string) Settings::get( 'default_locale' );
	}

	/**
	 * The site home.
	 *
	 * @param string $lang Language code (ignored).
	 */
	public function home_url( string $lang ): string {
		unset( $lang );
		return trailingslashit( home_url( '/' ) );
	}

	/**
	 * None.
	 *
	 * @param string $lang Language code.
	 * @return array<string,string>
	 */
	public function query_vars( string $lang ): array {
		unset( $lang );
		return array();
	}
}
