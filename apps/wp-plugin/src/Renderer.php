<?php
/**
 * Server-side rendering of search and detail views.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Renders the plugin templates (`templates/*.php`, overridable by the theme in `inmolink/*.php`). Blocks and the
 * legacy shortcodes (S8-04) call these. When neither the API nor a cached copy has the data, the visitor sees an
 * empty state — never an API error.
 */
class Renderer {

	/**
	 * Creates the renderer.
	 *
	 * @param Listings $listings Listing service.
	 */
	public function __construct( private readonly Listings $listings ) {}

	/**
	 * The renderer wired from the settings.
	 */
	public static function from_settings(): self {
		return new self( Listings::from_settings() );
	}

	/**
	 * A search results view.
	 *
	 * @param array<string,mixed> $args Search arguments ({@see Listings::search_query()}).
	 */
	public function search( array $args ): string {
		$result = $this->listings->search( $args );
		$items  = array();
		if ( null !== $result && isset( $result->body['items'] ) && is_array( $result->body['items'] ) ) {
			$items = array_values( array_filter( $result->body['items'], 'is_array' ) );
		}
		return $this->template(
			'search',
			array(
				'items'  => $items,
				'total'  => null !== $result && isset( $result->body['total'] ) ? (int) $result->body['total'] : 0,
				'stale'  => null !== $result && $result->stale,
				'cursor' => null !== $result && isset( $result->body['nextCursor'] ) && is_string( $result->body['nextCursor'] ) ? $result->body['nextCursor'] : null,
			)
		);
	}

	/**
	 * A listing detail view.
	 *
	 * @param string      $ref  Reference.
	 * @param string|null $lang Locale.
	 */
	public function detail( string $ref, ?string $lang = null ): string {
		$result = $this->listings->detail( $ref, $lang );
		return $this->template(
			'detail',
			array(
				'listing' => null !== $result ? $result->body : null,
				'stale'   => null !== $result && $result->stale,
			)
		);
	}

	/**
	 * A price as the site shows it ("Price on request", or the amount in its currency).
	 *
	 * @param mixed $price The API's `price` object.
	 */
	public static function price( $price ): string {
		if ( ! is_array( $price ) || ! empty( $price['onRequest'] ) || ! isset( $price['amountCents'] ) || ! is_numeric( $price['amountCents'] ) ) {
			return __( 'Price on request', 'inmolink' );
		}
		$currency = isset( $price['currency'] ) && is_string( $price['currency'] ) ? $price['currency'] : '';
		return trim( number_format_i18n( ( (int) $price['amountCents'] ) / 100 ) . ' ' . $currency );
	}

	/**
	 * Renders a template with variables.
	 *
	 * @param string              $name Template name.
	 * @param array<string,mixed> $vars Variables.
	 */
	private function template( string $name, array $vars ): string {
		$file = locate_template( 'inmolink/' . $name . '.php' );
		if ( '' === $file ) {
			$file = dirname( __DIR__ ) . '/templates/' . $name . '.php';
		}
		ob_start();
		( static function ( string $inmolink_file, array $inmolink_vars ): void {
			// phpcs:ignore WordPress.PHP.DontExtract.extract_extract -- template variables, keys set above.
			extract( $inmolink_vars, EXTR_SKIP );
			include $inmolink_file;
		} )( $file, $vars );
		return (string) ob_get_clean();
	}
}
