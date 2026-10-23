<?php
/**
 * Search form. Override in the theme as `inmolink/search-form.php`.
 *
 * @package Inmolink
 *
 * @var string[]             $fields Fields to show (q, transaction, types, priceMin, priceMax, bedsMin).
 * @var string               $action Results page URL ('' = this page).
 * @var array<string,mixed>  $values The visitor's current filters (validated).
 * @var array<string,string> $types  Property type id => label (empty when unavailable).
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}
$inmolink_transactions   = array(
	'SALE'            => __( 'For sale', 'inmolink' ),
	'RENT_LONG_TERM'  => __( 'Long-term rental', 'inmolink' ),
	'RENT_SHORT_TERM' => __( 'Holiday rental', 'inmolink' ),
);
$inmolink_selected_types = isset( $values['types'] ) && is_array( $values['types'] ) ? $values['types'] : array();
?>
<form class="inmolink-search-form" method="get" action="<?php echo esc_url( $action ); ?>" role="search">
	<?php if ( in_array( 'q', $fields, true ) ) : ?>
		<label class="inmolink-field inmolink-field--q">
			<span><?php esc_html_e( 'Keywords', 'inmolink' ); ?></span>
			<input type="search" name="q" maxlength="100" value="<?php echo esc_attr( (string) ( $values['q'] ?? '' ) ); ?>" />
		</label>
	<?php endif; ?>
	<?php if ( in_array( 'transaction', $fields, true ) ) : ?>
		<label class="inmolink-field inmolink-field--transaction">
			<span><?php esc_html_e( 'Looking for', 'inmolink' ); ?></span>
			<select name="transaction">
				<option value=""><?php esc_html_e( 'Any', 'inmolink' ); ?></option>
				<?php foreach ( $inmolink_transactions as $inmolink_value => $inmolink_label ) : ?>
					<option value="<?php echo esc_attr( $inmolink_value ); ?>" <?php selected( $values['transaction'] ?? '', $inmolink_value ); ?>><?php echo esc_html( $inmolink_label ); ?></option>
				<?php endforeach; ?>
			</select>
		</label>
	<?php endif; ?>
	<?php if ( in_array( 'types', $fields, true ) && array() !== $types ) : ?>
		<label class="inmolink-field inmolink-field--types">
			<span><?php esc_html_e( 'Property type', 'inmolink' ); ?></span>
			<select name="types">
				<option value=""><?php esc_html_e( 'Any', 'inmolink' ); ?></option>
				<?php foreach ( $types as $inmolink_id => $inmolink_label ) : ?>
					<option value="<?php echo esc_attr( (string) $inmolink_id ); ?>" <?php selected( in_array( (string) $inmolink_id, $inmolink_selected_types, true ) ); ?>><?php echo esc_html( $inmolink_label ); ?></option>
				<?php endforeach; ?>
			</select>
		</label>
	<?php endif; ?>
	<?php
	foreach ( array(
		'priceMin' => __( 'Min price', 'inmolink' ),
		'priceMax' => __( 'Max price', 'inmolink' ),
		'bedsMin'  => __( 'Bedrooms', 'inmolink' ),
	) as $inmolink_name => $inmolink_label ) :
		?>
		<?php if ( in_array( $inmolink_name, $fields, true ) ) : ?>
			<label class="inmolink-field inmolink-field--<?php echo esc_attr( strtolower( $inmolink_name ) ); ?>">
				<span><?php echo esc_html( $inmolink_label ); ?></span>
				<input type="number" min="0" step="1" name="<?php echo esc_attr( $inmolink_name ); ?>" value="<?php echo esc_attr( isset( $values[ $inmolink_name ] ) ? (string) $values[ $inmolink_name ] : '' ); ?>" />
			</label>
		<?php endif; ?>
	<?php endforeach; ?>
	<button type="submit"><?php esc_html_e( 'Search', 'inmolink' ); ?></button>
</form>
