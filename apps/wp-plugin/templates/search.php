<?php
/**
 * Search results. Override in the theme as `inmolink/search.php`.
 *
 * @package Inmolink
 *
 * @var list<array<string,mixed>> $items  Listing summaries (`/v2/listings` items).
 * @var int                       $total  Total matches.
 * @var bool                      $stale  Served from the stale cache.
 * @var string|null               $cursor Next page cursor.
 */

use Inmolink\Plugin\Renderer;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}
?>
<div class="inmolink-search" data-total="<?php echo esc_attr( (string) $total ); ?>">
	<?php if ( array() === $items ) : ?>
		<p class="inmolink-empty"><?php esc_html_e( 'No properties found.', 'inmolink' ); ?></p>
	<?php else : ?>
		<ul class="inmolink-results">
			<?php foreach ( $items as $inmolink_item ) : ?>
				<?php
				$inmolink_cover = isset( $inmolink_item['cover']['urls'] ) && is_array( $inmolink_item['cover']['urls'] ) ? $inmolink_item['cover']['urls'] : array();
				$inmolink_src   = $inmolink_cover['medium'] ?? $inmolink_cover['small'] ?? '';
				?>
				<li class="inmolink-card" data-ref="<?php echo esc_attr( (string) ( $inmolink_item['ref'] ?? '' ) ); ?>">
					<?php if ( '' !== $inmolink_src ) : ?>
						<img src="<?php echo esc_url( $inmolink_src ); ?>" alt="<?php echo esc_attr( (string) ( $inmolink_item['cover']['alt'] ?? '' ) ); ?>" loading="lazy" />
					<?php endif; ?>
					<h3 class="inmolink-card-title"><?php echo esc_html( (string) ( $inmolink_item['title'] ?? '' ) ); ?></h3>
					<p class="inmolink-card-place"><?php echo esc_html( (string) ( $inmolink_item['place']['city']['name'] ?? '' ) ); ?></p>
					<p class="inmolink-card-price"><?php echo esc_html( Renderer::price( $inmolink_item['price'] ?? null ) ); ?></p>
				</li>
			<?php endforeach; ?>
		</ul>
	<?php endif; ?>
</div>
