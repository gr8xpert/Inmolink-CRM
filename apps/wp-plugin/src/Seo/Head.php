<?php
/**
 * `<head>` tags for routed listing and development pages.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\Seo;

use Inmolink\Plugin\I18n\Locale;
use Inmolink\Plugin\Mirror\Mirror;
use Inmolink\Plugin\Routing\Router;
use Inmolink\Plugin\Routing\Urls;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Meta description, canonical, hreflang alternates (one per site language, slug from the mirror when known) and
 * JSON-LD; `noindex` on a reference that is not (or no longer) on the site.
 */
final class Head {

	/**
	 * Hooks into `wp_head`.
	 */
	public static function register(): void {
		add_action( 'wp_head', array( self::class, 'print' ), 1 );
	}

	/**
	 * Prints the tags.
	 */
	public static function print(): void {
		echo self::render(); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- escaped in render().
	}

	/**
	 * The tags for the routed page ('' when the request is not routed).
	 */
	public static function render(): string {
		$route = Router::current();
		if ( null === $route ) {
			return '';
		}
		if ( null === $route['result'] ) {
			return '<meta name="robots" content="noindex" />' . "\n";
		}
		$body      = $route['result']->body;
		$canonical = (string) Router::canonical();
		$out       = '';

		$description = $body['metaDescription'] ?? null;
		if ( is_string( $description ) && '' !== $description ) {
			$out .= '<meta name="description" content="' . esc_attr( wp_strip_all_tags( $description ) ) . '" />' . "\n";
		}
		$out .= '<link rel="canonical" href="' . esc_url( $canonical ) . '" />' . "\n";

		$alternates = self::alternates( $route['kind'], $route['ref'], $route['locale'], $canonical );
		if ( count( $alternates ) > 1 ) {
			$default                 = Locale::api_locale( (string) ( Locale::adapter()->languages()[0] ?? '' ) );
			$alternates['x-default'] = $alternates[ self::hreflang_for( $default ) ] ?? $canonical;
			foreach ( $alternates as $hreflang => $url ) {
				$out .= '<link rel="alternate" hreflang="' . esc_attr( $hreflang ) . '" href="' . esc_url( $url ) . '" />' . "\n";
			}
		}

		$data = 'development' === $route['kind'] ? JsonLd::development( $body, $canonical ) : JsonLd::listing( $body, $canonical );
		return $out . JsonLd::script( $data );
	}

	/**
	 * The hreflang code of the site language that maps to an API locale.
	 *
	 * @param string $locale API locale.
	 */
	private static function hreflang_for( string $locale ): string {
		return strtolower( str_replace( '_', '-', Locale::site_language( $locale ) ) );
	}

	/**
	 * Hreflang => URL for every site language.
	 *
	 * @param string $kind      `listing` or `development`.
	 * @param string $ref       Reference.
	 * @param string $locale    Current API locale.
	 * @param string $canonical Current canonical URL.
	 * @return array<string,string>
	 */
	private static function alternates( string $kind, string $ref, string $locale, string $canonical ): array {
		$mirror = new Mirror();
		$out    = array();
		foreach ( Locale::routable() as $lang => $api_locale ) {
			$hreflang = strtolower( str_replace( '_', '-', $lang ) );
			if ( $api_locale === $locale ) {
				$out[ $hreflang ] = $canonical;
				continue;
			}
			// Only alternates whose slug is known: a slugless URL would answer with a redirect.
			$row = 'listing' === $kind ? $mirror->find( $ref, $api_locale ) : null;
			if ( null !== $row && '' !== $row['slug'] ) {
				$out[ $hreflang ] = Urls::listing( $ref, $row['slug'], $api_locale );
			}
		}
		return $out;
	}
}
