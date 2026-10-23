<?php
/**
 * Enquiry / viewing-request form. Override in the theme as `inmolink/lead-form.php` (keep every hidden field, the
 * nonce, the honeypot and the Turnstile widget).
 *
 * @package Inmolink
 *
 * @var array{ref:string,kind:string,stamp:string,lang:string,page:string,site_key:string} $hidden Hidden fields.
 * @var string $action  admin-post.php URL.
 * @var string $result  Result code of the last submission ('' when none).
 * @var string $privacy Privacy policy URL ('' when none).
 */

use Inmolink\Plugin\Forms\LeadForm;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}
$inmolink_messages = array(
	'sent'        => __( 'Thank you — your message has been sent.', 'inmolink' ),
	'invalid'     => __( 'Please check the form and try again.', 'inmolink' ),
	'unavailable' => __( 'This form is not available right now.', 'inmolink' ),
	'busy'        => __( 'Too many messages from your connection. Please try again later.', 'inmolink' ),
	'error'       => __( 'Your message could not be sent. Please try again.', 'inmolink' ),
	'expired'     => __( 'The form expired. Please send it again.', 'inmolink' ),
);
$inmolink_viewing  = 'viewing' === $hidden['kind'];
?>
<div id="inmolink-form" class="inmolink-lead-form">
	<?php if ( isset( $inmolink_messages[ $result ] ) ) : ?>
		<p class="inmolink-form-result inmolink-form-result--<?php echo esc_attr( $result ); ?>" role="status"><?php echo esc_html( $inmolink_messages[ $result ] ); ?></p>
	<?php endif; ?>
	<form method="post" action="<?php echo esc_url( $action ); ?>">
		<input type="hidden" name="action" value="<?php echo esc_attr( LeadForm::ACTION ); ?>" />
		<?php wp_nonce_field( LeadForm::ACTION, '_wpnonce', false ); ?>
		<?php foreach ( array( 'ref', 'kind', 'stamp', 'lang', 'page' ) as $inmolink_name ) : ?>
			<input type="hidden" name="<?php echo esc_attr( $inmolink_name ); ?>" value="<?php echo esc_attr( $hidden[ $inmolink_name ] ); ?>" />
		<?php endforeach; ?>
		<p class="inmolink-hp" aria-hidden="true" style="position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden">
			<label><?php esc_html_e( 'Leave this field empty', 'inmolink' ); ?> <input type="text" name="<?php echo esc_attr( LeadForm::HONEYPOT ); ?>" value="" tabindex="-1" autocomplete="off" /></label>
		</p>
		<label><?php esc_html_e( 'Name', 'inmolink' ); ?> <input type="text" name="name" required maxlength="120" autocomplete="name" /></label>
		<label><?php esc_html_e( 'Email', 'inmolink' ); ?> <input type="email" name="email" required maxlength="254" autocomplete="email" /></label>
		<label><?php esc_html_e( 'Phone', 'inmolink' ); ?> <input type="tel" name="phone" maxlength="24" autocomplete="tel" /></label>
		<?php if ( $inmolink_viewing ) : ?>
			<label><?php esc_html_e( 'Preferred day', 'inmolink' ); ?> <input type="date" name="date" required min="<?php echo esc_attr( gmdate( 'Y-m-d' ) ); ?>" /></label>
			<label><?php esc_html_e( 'Time of day', 'inmolink' ); ?>
				<select name="time_of_day">
					<option value="ANY"><?php esc_html_e( 'Any time', 'inmolink' ); ?></option>
					<option value="MORNING"><?php esc_html_e( 'Morning', 'inmolink' ); ?></option>
					<option value="AFTERNOON"><?php esc_html_e( 'Afternoon', 'inmolink' ); ?></option>
					<option value="EVENING"><?php esc_html_e( 'Evening', 'inmolink' ); ?></option>
				</select>
			</label>
		<?php endif; ?>
		<label><?php esc_html_e( 'Message', 'inmolink' ); ?> <textarea name="message" maxlength="4000" rows="4"></textarea></label>
		<label class="inmolink-consent">
			<input type="checkbox" name="privacy" value="1" required />
			<?php if ( '' !== $privacy ) : ?>
				<?php
				printf(
					/* translators: %s: link to the privacy policy. */
					esc_html__( 'I accept the %s.', 'inmolink' ),
					'<a href="' . esc_url( $privacy ) . '" target="_blank" rel="noopener">' . esc_html__( 'privacy policy', 'inmolink' ) . '</a>'
				);
				?>
			<?php else : ?>
				<?php esc_html_e( 'I accept that my details are used to answer my request.', 'inmolink' ); ?>
			<?php endif; ?>
		</label>
		<label class="inmolink-consent"><input type="checkbox" name="marketing" value="1" /> <?php esc_html_e( 'Send me similar properties by email.', 'inmolink' ); ?></label>
		<div class="cf-turnstile" data-sitekey="<?php echo esc_attr( $hidden['site_key'] ); ?>" data-action="website-lead"></div>
		<button type="submit"><?php echo esc_html( $inmolink_viewing ? __( 'Request a viewing', 'inmolink' ) : __( 'Send', 'inmolink' ) ); ?></button>
	</form>
</div>
