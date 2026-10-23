<?php
/**
 * Dynamic Gutenberg blocks.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\Blocks;

use Inmolink\Plugin\Renderer;
use const Inmolink\Plugin\PLUGIN_FILE;
use const Inmolink\Plugin\VERSION;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Registers `inmolink/search`, `results`, `detail`, `developments` and `map` from their block.json files. All are
 * server-rendered (no build step); the editor uses `assets/editor.js` (a server-side preview plus one control per
 * attribute). Shortcodes render through the same blocks ({@see \Inmolink\Plugin\Shortcodes\Shortcodes}).
 */
final class Blocks {

	public const NAMES = array( 'search', 'results', 'detail', 'developments', 'map' );

	/**
	 * Hooks registration into `init`.
	 */
	public static function register(): void {
		add_action( 'init', array( self::class, 'register_blocks' ) );
	}

	/**
	 * Registers the editor script and the blocks.
	 */
	public static function register_blocks(): void {
		wp_register_script(
			'inmolink-blocks-editor',
			plugins_url( 'assets/editor.js', PLUGIN_FILE ),
			array( 'wp-blocks', 'wp-element', 'wp-block-editor', 'wp-components', 'wp-server-side-render', 'wp-i18n' ),
			VERSION,
			true
		);
		foreach ( self::NAMES as $name ) {
			register_block_type(
				dirname( PLUGIN_FILE ) . '/blocks/' . $name,
				array( 'render_callback' => array( self::class, 'render_' . $name ) )
			);
		}
	}

	/**
	 * `inmolink/search`.
	 *
	 * @param array<string,mixed> $attributes Block attributes.
	 */
	public static function render_search( $attributes ): string {
		return self::wrap( 'search', Renderer::from_settings()->search_form( (array) $attributes ) );
	}

	/**
	 * `inmolink/results`.
	 *
	 * @param array<string,mixed> $attributes Block attributes.
	 */
	public static function render_results( $attributes ): string {
		return self::wrap( 'results', Renderer::from_settings()->results( (array) $attributes ) );
	}

	/**
	 * `inmolink/detail`.
	 *
	 * @param array<string,mixed> $attributes Block attributes.
	 */
	public static function render_detail( $attributes ): string {
		return self::wrap( 'detail', Renderer::from_settings()->detail_block( (array) $attributes ) );
	}

	/**
	 * `inmolink/developments`.
	 *
	 * @param array<string,mixed> $attributes Block attributes.
	 */
	public static function render_developments( $attributes ): string {
		return self::wrap( 'developments', Renderer::from_settings()->developments( (array) $attributes ) );
	}

	/**
	 * `inmolink/map`.
	 *
	 * @param array<string,mixed> $attributes Block attributes.
	 */
	public static function render_map( $attributes ): string {
		return self::wrap( 'map', Renderer::from_settings()->map( (array) $attributes ) );
	}

	/**
	 * The block wrapper with the block-supports classes (alignment, custom class name).
	 *
	 * @param string $name Block short name.
	 * @param string $html Inner HTML (escaped by the templates).
	 */
	private static function wrap( string $name, string $html ): string {
		$attributes = \WP_Block_Supports::$block_to_render ? get_block_wrapper_attributes( array( 'class' => 'inmolink-block inmolink-block--' . $name ) ) : 'class="inmolink-block inmolink-block--' . esc_attr( $name ) . '"';
		return '<div ' . $attributes . '>' . $html . '</div>';
	}
}
