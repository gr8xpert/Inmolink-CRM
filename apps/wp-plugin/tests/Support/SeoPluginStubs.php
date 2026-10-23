<?php
/**
 * A stub of the hooks Yoast SEO uses to print the head, for the coexistence tests (S8-F25).
 *
 * NOT the real plugin: it reproduces the documented extension points (the `wpseo_head` action in `wp_head`, the
 * `wpseo_frontend_presenters` list, the `wpseo_canonical` / `wpseo_title` / `wpseo_metadesc` filters, the removal of
 * core's `rel_canonical`) and, like Yoast, prints a canonical, a title and a description of its own. A check against
 * the real plugin is pending (STATUS decision for S8-F25).
 *
 * @package Inmolink
 */

namespace Yoast\WP\SEO\Presenters {

	/**
	 * Yoast's canonical presenter (same class name, so presenter filters can recognise it).
	 */
	class Canonical_Presenter { // phpcs:ignore Generic.Files.OneObjectStructurePerFile
		/**
		 * The tag.
		 */
		public function present(): string {
			$url = apply_filters( 'wpseo_canonical', home_url( '/' ) );
			return $url ? '<link rel="canonical" href="' . esc_url( (string) $url ) . '" />' . "\n" : '';
		}
	}

	/**
	 * Yoast's title presenter.
	 */
	class Title_Presenter { // phpcs:ignore Generic.Files.OneObjectStructurePerFile
		/**
		 * The tag.
		 */
		public function present(): string {
			$title = apply_filters( 'wpseo_title', 'Yoast default title' );
			return $title ? '<title>' . esc_html( (string) $title ) . "</title>\n" : '';
		}
	}

	/**
	 * Yoast's meta description presenter.
	 */
	class Meta_Description_Presenter { // phpcs:ignore Generic.Files.OneObjectStructurePerFile
		/**
		 * The tag.
		 */
		public function present(): string {
			$description = apply_filters( 'wpseo_metadesc', 'Yoast default description' );
			return $description ? '<meta name="description" content="' . esc_attr( (string) $description ) . '" />' . "\n" : '';
		}
	}
}

namespace Inmolink\Plugin\Tests {

	/**
	 * Activates and deactivates the Yoast stub.
	 */
	final class YoastStub { // phpcs:ignore Generic.Files.OneObjectStructurePerFile

		/**
		 * Yoast on: core's canonical removed, its head printed first in `wp_head`.
		 */
		public static function activate(): void {
			remove_action( 'wp_head', 'rel_canonical' );
			add_action( 'wp_head', array( self::class, 'wpseo_head' ), -9000 );
			add_action( 'wpseo_head', array( self::class, 'present' ) );
		}

		/**
		 * Yoast off (hooks of the stub only).
		 */
		public static function deactivate(): void {
			remove_action( 'wp_head', array( self::class, 'wpseo_head' ), -9000 );
			remove_action( 'wpseo_head', array( self::class, 'present' ) );
			add_action( 'wp_head', 'rel_canonical' );
		}

		/**
		 * `wp_head` → `wpseo_head`.
		 */
		public static function wpseo_head(): void {
			do_action( 'wpseo_head' );
		}

		/**
		 * Prints the presenters Yoast's filter leaves.
		 */
		public static function present(): void {
			$presenters = apply_filters(
				'wpseo_frontend_presenters',
				array(
					new \Yoast\WP\SEO\Presenters\Title_Presenter(),
					new \Yoast\WP\SEO\Presenters\Canonical_Presenter(),
					new \Yoast\WP\SEO\Presenters\Meta_Description_Presenter(),
				)
			);
			foreach ( $presenters as $presenter ) {
				echo $presenter->present(); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- escaped in the presenters.
			}
		}
	}
}
