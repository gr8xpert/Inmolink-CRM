<?php
/**
 * Listing points for a map. Override in the theme as `inmolink/map.php`.
 *
 * No map provider is loaded by default (no third-party key, no third-party request): the points are printed as
 * JSON in `data-points` for a theme or site script to draw, and as a list that works without JavaScript.
 *
 * @package Inmolink
 *
 * @var list<array{ref:string,title:string,url:string,price:string,lat:float,lng:float,approx:bool}> $points Points.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}
?>
<div class="inmolink-map" data-points="<?php echo esc_attr( (string) wp_json_encode( $points ) ); ?>">
	<?php if ( array() === $points ) : ?>
		<p class="inmolink-empty"><?php esc_html_e( 'No properties to show on the map.', 'inmolink' ); ?></p>
	<?php else : ?>
		<ul class="inmolink-map-points">
			<?php foreach ( $points as $inmolink_point ) : ?>
				<li data-lat="<?php echo esc_attr( (string) $inmolink_point['lat'] ); ?>" data-lng="<?php echo esc_attr( (string) $inmolink_point['lng'] ); ?>">
					<a href="<?php echo esc_url( $inmolink_point['url'] ); ?>"><?php echo esc_html( $inmolink_point['title'] ); ?></a>
					<span class="inmolink-map-price"><?php echo esc_html( $inmolink_point['price'] ); ?></span>
					<?php if ( $inmolink_point['approx'] ) : ?>
						<span class="inmolink-map-approx"><?php esc_html_e( 'Approximate location', 'inmolink' ); ?></span>
					<?php endif; ?>
				</li>
			<?php endforeach; ?>
		</ul>
	<?php endif; ?>
</div>
