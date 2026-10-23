<?php
/**
 * A routed listing page (`/{base}/{ref}/{slug}/`). Override in the theme as `inmolink/page-listing.php`.
 *
 * @package Inmolink
 *
 * @var string $content The rendered detail view (escaped by its template).
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}
\Inmolink\Plugin\Renderer::part( 'page-open' );
?>
<main id="primary" class="inmolink-page inmolink-page--listing">
	<?php echo $content; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- rendered by templates/detail.php, which escapes. ?>
</main>
<?php
\Inmolink\Plugin\Renderer::part( 'page-close' );
