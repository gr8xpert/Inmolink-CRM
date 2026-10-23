<?php
/**
 * Yoast SEO and Rank Math on routed pages.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\Seo;

use Inmolink\Plugin\Routing\Router;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * A routed listing or development page is not a WordPress post: {@see Head} prints its canonical, description,
 * hreflang and JSON-LD, and {@see Router} sets its title. Yoast SEO and Rank Math would add a second canonical (of
 * the home page or the 404 they see), their own title and description. On routed pages only, their canonical and
 * description are switched off and their title is replaced by ours (S8-F25). Their filters are documented, and they
 * are no-ops when the plugin is not active.
 */
final class Coexistence {

	/** Yoast presenter classes (short names) that would duplicate {@see Head}'s tags. */
	private const YOAST_PRESENTERS = array( 'Canonical_Presenter', 'Title_Presenter', 'Meta_Description_Presenter' );

	/**
	 * Hooks the filters.
	 */
	public static function register(): void {
		// Yoast SEO.
		add_filter( 'wpseo_canonical', array( self::class, 'silence' ), PHP_INT_MAX );
		add_filter( 'wpseo_metadesc', array( self::class, 'silence' ), PHP_INT_MAX );
		add_filter( 'wpseo_title', array( self::class, 'title' ), PHP_INT_MAX );
		add_filter( 'wpseo_opengraph_url', array( self::class, 'canonical' ), PHP_INT_MAX );
		add_filter( 'wpseo_frontend_presenters', array( self::class, 'presenters' ), PHP_INT_MAX );
		// Rank Math.
		add_filter( 'rank_math/frontend/canonical', array( self::class, 'silence' ), PHP_INT_MAX );
		add_filter( 'rank_math/frontend/description', array( self::class, 'silence' ), PHP_INT_MAX );
		add_filter( 'rank_math/frontend/title', array( self::class, 'title' ), PHP_INT_MAX );
	}

	/**
	 * Whether this request is a routed Inmolink page.
	 */
	private static function routed(): bool {
		return null !== Router::current();
	}

	/**
	 * Switches a value off (false) on routed pages.
	 *
	 * @param mixed $value Value so far.
	 * @return mixed
	 */
	public static function silence( $value ) {
		return self::routed() ? false : $value;
	}

	/**
	 * The routed page's own title.
	 *
	 * @param mixed $title Title so far.
	 * @return mixed
	 */
	public static function title( $title ) {
		return self::routed() ? Router::document_title( is_string( $title ) ? $title : '' ) : $title;
	}

	/**
	 * Our canonical for Open Graph's `og:url` (else the SEO plugin's own URL would disagree with it).
	 *
	 * @param mixed $url URL so far.
	 * @return mixed
	 */
	public static function canonical( $url ) {
		$canonical = self::routed() ? Router::canonical() : null;
		return null !== $canonical ? $canonical : $url;
	}

	/**
	 * Drops Yoast's canonical, title and description presenters on routed pages.
	 *
	 * @param mixed $presenters Presenter objects.
	 * @return mixed
	 */
	public static function presenters( $presenters ) {
		if ( ! self::routed() || ! is_array( $presenters ) ) {
			return $presenters;
		}
		return array_values(
			array_filter(
				$presenters,
				static function ( $presenter ): bool {
					if ( ! is_object( $presenter ) ) {
						return true;
					}
					$parts = explode( '\\', get_class( $presenter ) );
					return ! in_array( end( $parts ), self::YOAST_PRESENTERS, true );
				}
			)
		);
	}
}
