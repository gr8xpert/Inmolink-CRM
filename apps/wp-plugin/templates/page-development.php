<?php
/**
 * A routed development page (`/{base}/{ref}/{slug}/`). Override in the theme as `inmolink/page-development.php`.
 *
 * @package Inmolink
 *
 * @var string $content The rendered development view (escaped by its template).
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}
\Inmolink\Plugin\Renderer::part( 'page-open' );
?>
<main id="primary" class="inmolink-page inmolink-page--development">
	<?php echo $content; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- rendered by templates/development.php, which escapes. ?>
</main>
<?php
\Inmolink\Plugin\Renderer::part( 'page-close' );
