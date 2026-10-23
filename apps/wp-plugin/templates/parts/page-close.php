<?php
/**
 * Closes a routed page (counterpart of page-open.php).
 *
 * @package Inmolink
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}
if ( function_exists( 'wp_is_block_theme' ) && wp_is_block_theme() ) :
	block_template_part( 'footer' );
	?>
	</div>
	<?php wp_footer(); ?>
</body>
</html>
	<?php
else :
	get_footer();
endif;
