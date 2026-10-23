<?php
/**
 * Developments list. Override in the theme as `inmolink/developments.php`.
 *
 * @package Inmolink
 *
 * @var list<array<string,mixed>> $items  Development cards (`/v2/developments` items).
 * @var string                    $locale API locale.
 * @var bool                      $stale  Served from the stale cache.
 */

use Inmolink\Plugin\Renderer;
use Inmolink\Plugin\Routing\Urls;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}
?>
<div class="inmolink-developments">
	<?php if ( array() === $items ) : ?>
		<p class="inmolink-empty"><?php esc_html_e( 'No developments found.', 'inmolink' ); ?></p>
	<?php else : ?>
		<ul class="inmolink-results">
			<?php foreach ( $items as $inmolink_item ) : ?>
				<?php $inmolink_url = Urls::for_item( $inmolink_item, $locale ); ?>
				<li class="inmolink-card inmolink-card--development" data-ref="<?php echo esc_attr( (string) ( $inmolink_item['ref'] ?? '' ) ); ?>">
					<h3 class="inmolink-card-title"><a href="<?php echo esc_url( $inmolink_url ); ?>"><?php echo esc_html( (string) ( $inmolink_item['title'] ?? $inmolink_item['name'] ?? '' ) ); ?></a></h3>
					<p class="inmolink-card-place"><?php echo esc_html( (string) ( $inmolink_item['place']['city']['name'] ?? '' ) ); ?></p>
					<p class="inmolink-card-price"><?php echo esc_html( Renderer::price_range( $inmolink_item['price'] ?? null ) ); ?></p>
					<?php if ( isset( $inmolink_item['units']['available'] ) ) : ?>
						<?php /* translators: %d: number of available units. */ ?>
						<p class="inmolink-card-units"><?php echo esc_html( sprintf( _n( '%d unit available', '%d units available', (int) $inmolink_item['units']['available'], 'inmolink' ), (int) $inmolink_item['units']['available'] ) ); ?></p>
					<?php endif; ?>
				</li>
			<?php endforeach; ?>
		</ul>
	<?php endif; ?>
</div>
