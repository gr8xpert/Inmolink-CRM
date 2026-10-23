<?php
/**
 * Listing detail. Override in the theme as `inmolink/detail.php`.
 *
 * @package Inmolink
 *
 * @var array<string,mixed>|null $listing The `/v2/listings/{ref}` body, or null when unavailable.
 * @var bool                     $stale   Served from the stale mirror.
 */

use Inmolink\Plugin\Renderer;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}
?>
<?php if ( null === $listing ) : ?>
	<div class="inmolink-detail inmolink-detail--missing">
		<p><?php esc_html_e( 'This property is no longer available.', 'inmolink' ); ?></p>
	</div>
<?php else : ?>
	<article class="inmolink-detail" data-ref="<?php echo esc_attr( (string) ( $listing['ref'] ?? '' ) ); ?>">
		<h1 class="inmolink-detail-title"><?php echo esc_html( (string) ( $listing['title'] ?? '' ) ); ?></h1>
		<p class="inmolink-detail-price"><?php echo esc_html( Renderer::price( $listing['price'] ?? null ) ); ?></p>
		<p class="inmolink-detail-place">
			<?php
			echo esc_html(
				implode(
					', ',
					array_filter(
						array(
							(string) ( $listing['place']['area']['name'] ?? '' ),
							(string) ( $listing['place']['city']['name'] ?? '' ),
						)
					)
				)
			);
			?>
		</p>
		<?php if ( ! empty( $listing['description'] ) && is_string( $listing['description'] ) ) : ?>
			<div class="inmolink-detail-description"><?php echo wp_kses_post( wpautop( esc_html( $listing['description'] ) ) ); /* The API's texts are plain text: escaped, then paragraphs. */ ?></div>
		<?php endif; ?>
		<?php if ( ! empty( $listing['media'] ) && is_array( $listing['media'] ) ) : ?>
			<ul class="inmolink-detail-media">
				<?php foreach ( $listing['media'] as $inmolink_media ) : ?>
					<?php if ( is_array( $inmolink_media ) && isset( $inmolink_media['urls']['large'] ) ) : ?>
						<li><img src="<?php echo esc_url( (string) $inmolink_media['urls']['large'] ); ?>" alt="<?php echo esc_attr( (string) ( $inmolink_media['alt'] ?? '' ) ); ?>" loading="lazy" /></li>
					<?php endif; ?>
				<?php endforeach; ?>
			</ul>
		<?php endif; ?>
	</article>
<?php endif; ?>
