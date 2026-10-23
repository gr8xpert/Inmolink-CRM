<?php
/**
 * Listing detail. Override in the theme as `inmolink/detail.php`.
 *
 * @package Inmolink
 *
 * @var array<string,mixed>|null $listing The `/v2/listings/{ref}` body, or null when unavailable.
 * @var string                   $url     Canonical URL ('' when unavailable).
 * @var bool                     $stale   Served from the stale mirror.
 * @var string                   $jsonld  JSON-LD script ('' on routed pages: the head prints it).
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
		<ul class="inmolink-detail-facts">
			<?php if ( isset( $listing['bedrooms'] ) && is_int( $listing['bedrooms'] ) ) : ?>
				<?php /* translators: %d: number of bedrooms. */ ?>
				<li><?php echo esc_html( sprintf( _n( '%d bedroom', '%d bedrooms', $listing['bedrooms'], 'inmolink' ), $listing['bedrooms'] ) ); ?></li>
			<?php endif; ?>
			<?php if ( isset( $listing['bathrooms'] ) && is_int( $listing['bathrooms'] ) ) : ?>
				<?php /* translators: %d: number of bathrooms. */ ?>
				<li><?php echo esc_html( sprintf( _n( '%d bathroom', '%d bathrooms', $listing['bathrooms'], 'inmolink' ), $listing['bathrooms'] ) ); ?></li>
			<?php endif; ?>
			<?php $inmolink_area = $listing['builtM2'] ?? $listing['internalM2'] ?? null; ?>
			<?php if ( is_int( $inmolink_area ) || is_float( $inmolink_area ) ) : ?>
				<?php /* translators: %s: built area in square metres. */ ?>
				<li><?php echo esc_html( sprintf( __( '%s m² built', 'inmolink' ), number_format_i18n( (float) $inmolink_area ) ) ); ?></li>
			<?php endif; ?>
		</ul>
		<?php if ( ! empty( $listing['description'] ) && is_string( $listing['description'] ) ) : ?>
			<div class="inmolink-detail-description"><?php echo wp_kses_post( wpautop( esc_html( $listing['description'] ) ) ); /* The API's texts are plain text: escaped, then paragraphs. */ ?></div>
		<?php endif; ?>
		<?php if ( ! empty( $listing['features'] ) && is_array( $listing['features'] ) ) : ?>
			<ul class="inmolink-detail-features">
				<?php foreach ( $listing['features'] as $inmolink_feature ) : ?>
					<?php if ( is_array( $inmolink_feature ) && isset( $inmolink_feature['name'] ) ) : ?>
						<li><?php echo esc_html( (string) $inmolink_feature['name'] ); ?></li>
					<?php endif; ?>
				<?php endforeach; ?>
			</ul>
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
		<?php echo $jsonld; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- JsonLd::script() output: JSON with <, >, & hex-escaped. ?>
	</article>
<?php endif; ?>
