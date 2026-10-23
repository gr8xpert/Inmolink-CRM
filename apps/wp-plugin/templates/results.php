<?php
/**
 * Search results. Override in the theme as `inmolink/results.php`.
 *
 * @package Inmolink
 *
 * @var list<array<string,mixed>> $items    Listing summaries (`/v2/listings` items).
 * @var array<int,string>         $urls     Detail URL per item index.
 * @var int                       $total    Total matches.
 * @var bool                      $stale    Served from the stale cache.
 * @var string|null               $cursor   Next page cursor.
 * @var string                    $next_url Next page URL ('' on the last page).
 * @var string                    $jsonld   ItemList JSON-LD script ('' when not wanted).
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
			<?php foreach ( $items as $inmolink_i => $inmolink_item ) : ?>
				<?php
				$inmolink_cover = isset( $inmolink_item['cover']['urls'] ) && is_array( $inmolink_item['cover']['urls'] ) ? $inmolink_item['cover']['urls'] : array();
				$inmolink_src   = $inmolink_cover['medium'] ?? $inmolink_cover['small'] ?? '';
				$inmolink_url   = $urls[ $inmolink_i ] ?? '';
				?>
				<li class="inmolink-card" data-ref="<?php echo esc_attr( (string) ( $inmolink_item['ref'] ?? '' ) ); ?>">
					<?php if ( '' !== $inmolink_src ) : ?>
						<img src="<?php echo esc_url( $inmolink_src ); ?>" alt="<?php echo esc_attr( (string) ( $inmolink_item['cover']['alt'] ?? '' ) ); ?>" loading="lazy" />
					<?php endif; ?>
					<h3 class="inmolink-card-title">
						<?php if ( '' !== $inmolink_url ) : ?>
							<a href="<?php echo esc_url( $inmolink_url ); ?>"><?php echo esc_html( (string) ( $inmolink_item['title'] ?? '' ) ); ?></a>
						<?php else : ?>
							<?php echo esc_html( (string) ( $inmolink_item['title'] ?? '' ) ); ?>
						<?php endif; ?>
					</h3>
					<p class="inmolink-card-place"><?php echo esc_html( (string) ( $inmolink_item['place']['city']['name'] ?? '' ) ); ?></p>
					<p class="inmolink-card-price"><?php echo esc_html( Renderer::price( $inmolink_item['price'] ?? null ) ); ?></p>
				</li>
			<?php endforeach; ?>
		</ul>
		<?php if ( '' !== $next_url ) : ?>
			<p class="inmolink-pagination"><a rel="next" href="<?php echo esc_url( $next_url ); ?>"><?php esc_html_e( 'More properties', 'inmolink' ); ?></a></p>
		<?php endif; ?>
	<?php endif; ?>
	<?php echo $jsonld; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- JsonLd::script() output: JSON with <, >, & hex-escaped. ?>
</div>
