<?php
/**
 * Development detail with its units. Override in the theme as `inmolink/development.php`.
 *
 * @package Inmolink
 *
 * @var array<string,mixed>|null  $development The `/v2/developments/{ref}` body, or null when unavailable.
 * @var list<array<string,mixed>> $units       Unit cards.
 * @var string                    $locale      API locale.
 * @var bool                      $stale       Served from the stale cache.
 */

use Inmolink\Plugin\Renderer;
use Inmolink\Plugin\Routing\Urls;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}
?>
<?php if ( null === $development ) : ?>
	<div class="inmolink-development inmolink-development--missing">
		<p><?php esc_html_e( 'This development is no longer available.', 'inmolink' ); ?></p>
	</div>
<?php else : ?>
	<article class="inmolink-development" data-ref="<?php echo esc_attr( (string) ( $development['ref'] ?? '' ) ); ?>">
		<h1 class="inmolink-development-title"><?php echo esc_html( (string) ( $development['title'] ?? $development['name'] ?? '' ) ); ?></h1>
		<p class="inmolink-development-price"><?php echo esc_html( Renderer::price_range( $development['price'] ?? null ) ); ?></p>
		<p class="inmolink-development-place"><?php echo esc_html( (string) ( $development['place']['city']['name'] ?? '' ) ); ?></p>
		<?php if ( ! empty( $development['description'] ) && is_string( $development['description'] ) ) : ?>
			<div class="inmolink-development-description"><?php echo wp_kses_post( wpautop( esc_html( $development['description'] ) ) ); ?></div>
		<?php endif; ?>
		<?php if ( array() !== $units ) : ?>
			<table class="inmolink-units">
				<thead>
					<tr>
						<th scope="col"><?php esc_html_e( 'Unit', 'inmolink' ); ?></th>
						<th scope="col"><?php esc_html_e( 'Bedrooms', 'inmolink' ); ?></th>
						<th scope="col"><?php esc_html_e( 'Price', 'inmolink' ); ?></th>
					</tr>
				</thead>
				<tbody>
					<?php foreach ( $units as $inmolink_unit ) : ?>
						<tr data-ref="<?php echo esc_attr( (string) ( $inmolink_unit['ref'] ?? '' ) ); ?>">
							<td><a href="<?php echo esc_url( Urls::for_item( $inmolink_unit, $locale ) ); ?>"><?php echo esc_html( (string) ( $inmolink_unit['title'] ?? '' ) ); ?></a></td>
							<td><?php echo esc_html( isset( $inmolink_unit['bedrooms'] ) ? (string) $inmolink_unit['bedrooms'] : '—' ); ?></td>
							<td><?php echo esc_html( Renderer::price( $inmolink_unit['price'] ?? null ) ); ?></td>
						</tr>
					<?php endforeach; ?>
				</tbody>
			</table>
		<?php endif; ?>
	</article>
<?php endif; ?>
