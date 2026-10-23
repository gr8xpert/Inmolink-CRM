<?php
/**
 * Opens a routed page: the classic theme's header, or a minimal document with the block theme's header part.
 *
 * @package Inmolink
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}
if ( function_exists( 'wp_is_block_theme' ) && wp_is_block_theme() ) :
	// Rendered before wp_head() (as core's template canvas does) so its block styles are enqueued in time.
	ob_start();
	block_template_part( 'header' );
	$inmolink_header = (string) ob_get_clean();
	?>
<!DOCTYPE html>
<html <?php language_attributes(); ?>>
<head>
	<meta charset="<?php bloginfo( 'charset' ); ?>" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<?php wp_head(); ?>
</head>
<body <?php body_class( 'inmolink-routed' ); ?>>
	<?php wp_body_open(); ?>
	<div class="wp-site-blocks">
	<?php echo $inmolink_header; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- core block template part markup. ?>
	<?php
else :
	get_header();
endif;
