<?php
/**
 * Shortcodes, mapped onto the blocks.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\Shortcodes;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Registers every shortcode of the mapping table (`map.php` + the `inmolink_shortcode_map` filter). A shortcode
 * renders exactly as its block: its attributes are translated (names, value maps, types from the block's block.json)
 * and the block is rendered through `render_block()`. Unknown attributes are ignored.
 */
final class Shortcodes {

	/**
	 * The mapping table, built once per request.
	 *
	 * @var array<string,array{block:string,attributes:array<string,mixed>,provisional:bool,source:string}>|null
	 */
	private static ?array $memo = null;

	/**
	 * Forgets the table (after adding an `inmolink_shortcode_map` filter late, e.g. in tests).
	 */
	public static function reset(): void {
		self::$memo = null;
	}

	/**
	 * Registers the shortcodes on `init` (after the blocks).
	 */
	public static function register(): void {
		add_action( 'init', array( self::class, 'add' ), 20 );
	}

	/**
	 * The mapping table.
	 *
	 * @return array<string,array{block:string,attributes:array<string,mixed>,provisional:bool,source:string}>
	 */
	public static function map(): array {
		if ( null !== self::$memo ) {
			return self::$memo;
		}
		$table = require __DIR__ . '/map.php';
		$table = apply_filters( 'inmolink_shortcode_map', is_array( $table ) ? $table : array() );
		$out   = array();
		foreach ( (array) $table as $tag => $entry ) {
			if ( is_string( $tag ) && preg_match( '/^[a-z0-9_-]+$/', $tag ) && is_array( $entry ) && isset( $entry['block'] ) && is_string( $entry['block'] ) ) {
				$out[ $tag ] = array(
					'block'       => $entry['block'],
					'attributes'  => isset( $entry['attributes'] ) && is_array( $entry['attributes'] ) ? $entry['attributes'] : array(),
					'provisional' => ! empty( $entry['provisional'] ),
					'source'      => isset( $entry['source'] ) ? (string) $entry['source'] : '',
				);
			}
		}
		self::$memo = $out;
		return $out;
	}

	/**
	 * Adds the shortcodes.
	 */
	public static function add(): void {
		foreach ( array_keys( self::map() ) as $tag ) {
			add_shortcode( $tag, array( self::class, 'render' ) );
		}
	}

	/**
	 * The shortcode callback.
	 *
	 * @param array<string,string>|string $atts    Attributes.
	 * @param string|null                 $content Enclosed content (unused).
	 * @param string                      $tag     Shortcode tag.
	 */
	public static function render( $atts, $content = null, $tag = '' ): string {
		unset( $content );
		$map = self::map();
		if ( ! isset( $map[ $tag ] ) ) {
			return '';
		}
		return render_block( self::block_for( $tag, is_array( $atts ) ? $atts : array() ) );
	}

	/**
	 * The parsed block a shortcode stands for.
	 *
	 * @param string               $tag  Shortcode tag.
	 * @param array<string,string> $atts Shortcode attributes.
	 * @return array{blockName:string,attrs:array<string,mixed>,innerBlocks:array<int,mixed>,innerHTML:string,innerContent:array<int,mixed>}
	 */
	public static function block_for( string $tag, array $atts ): array {
		$entry = self::map()[ $tag ];
		return array(
			'blockName'    => $entry['block'],
			'attrs'        => self::attributes( $entry, $atts ),
			'innerBlocks'  => array(),
			'innerHTML'    => '',
			'innerContent' => array(),
		);
	}

	/**
	 * Translates shortcode attributes into block attributes.
	 *
	 * @param array{block:string,attributes:array<string,mixed>} $entry Mapping entry.
	 * @param array<string,string>                               $atts  Shortcode attributes.
	 * @return array<string,mixed>
	 */
	public static function attributes( array $entry, array $atts ): array {
		$type   = \WP_Block_Type_Registry::get_instance()->get_registered( $entry['block'] );
		$schema = null !== $type && is_array( $type->attributes ) ? $type->attributes : array();
		$out    = array();
		foreach ( $atts as $name => $value ) {
			$name = strtolower( (string) $name );
			if ( ! isset( $entry['attributes'][ $name ] ) || ! is_scalar( $value ) ) {
				continue;
			}
			$rule   = $entry['attributes'][ $name ];
			$target = is_array( $rule ) ? (string) ( $rule['to'] ?? '' ) : (string) $rule;
			$value  = (string) $value;
			if ( is_array( $rule ) && isset( $rule['values'] ) && is_array( $rule['values'] ) ) {
				$key   = strtolower( $value );
				$value = array_key_exists( $key, $rule['values'] ) ? (string) $rule['values'][ $key ] : $value;
			}
			if ( '' === $target || ! isset( $schema[ $target ] ) ) {
				continue;
			}
			$cast = self::cast( $value, (string) ( $schema[ $target ]['type'] ?? 'string' ) );
			if ( null !== $cast ) {
				$out[ $target ] = $cast;
			}
		}
		return $out;
	}

	/**
	 * Casts a shortcode string to the block attribute's type.
	 *
	 * @param string $value Value.
	 * @param string $type  block.json type.
	 * @return mixed Null when the value does not fit the type (the attribute is then left out).
	 */
	private static function cast( string $value, string $type ) {
		switch ( $type ) {
			case 'number':
				return is_numeric( $value ) ? $value + 0 : null;
			case 'integer':
				return is_numeric( $value ) ? (int) $value : null;
			case 'boolean':
				return in_array( strtolower( $value ), array( '1', 'true', 'yes', 'on' ), true );
			default:
				return sanitize_text_field( $value );
		}
	}
}
