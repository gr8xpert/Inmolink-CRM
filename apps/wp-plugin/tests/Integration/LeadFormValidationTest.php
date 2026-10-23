<?php
/**
 * S9-F5: the form's field rules and the website API contract's give the same verdict.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\Tests\Integration;

use Inmolink\Plugin\Forms\LeadForm;
use Inmolink\Plugin\Forms\Turnstile;
use Inmolink\Plugin\Tests\TestCase;

/**
 * `tests/fixtures/leads/cases.json` is read by this test and by `packages/contracts/src/website-leads.test.ts`
 * (vitest); each case states whether a lead is valid, and both must agree.
 */
final class LeadFormValidationTest extends TestCase {

	/**
	 * Own Turnstile mode, so the form renders.
	 */
	public function set_up(): void {
		parent::set_up();
		\Inmolink\Plugin\Settings::save(
			array(
				'api_base'           => \Inmolink\Plugin\Tests\FakeApi::BASE,
				'locales'            => 'en',
				'turnstile_site_key' => '0x4AAAAAAAtestSiteKey',
			)
		);
		\Inmolink\Plugin\Settings::set_api_key( self::KEY );
		Turnstile::set_secret( '0x4AAAAAAAtestSecretValue' );
	}

	/**
	 * The fixture.
	 *
	 * @return array<string,mixed>
	 */
	private static function fixture(): array {
		$json = file_get_contents( dirname( __DIR__ ) . '/fixtures/leads/cases.json' );
		$data = json_decode( (string) $json, true );
		self::assertIsArray( $data );
		return $data;
	}

	/**
	 * A fixture value: a string, or `{"$repeat":"x","times":n}` (with an optional `$prefix`).
	 *
	 * @param mixed $value Value.
	 * @return mixed
	 */
	private static function text( $value ) {
		if ( is_array( $value ) && isset( $value['$repeat'], $value['times'] ) ) {
			return ( $value['$prefix'] ?? '' ) . str_repeat( (string) $value['$repeat'], (int) $value['times'] );
		}
		return $value;
	}

	/**
	 * The form post of a contract body.
	 *
	 * @param string              $kind `enquiry` or `viewing`.
	 * @param array<string,mixed> $body Contract body.
	 * @return array<string,string>
	 */
	private static function post( string $kind, array $body ): array {
		$post = array(
			'kind'      => $kind,
			'lang'      => 'en',
			'privacy'   => true === ( $body['privacyAccepted'] ?? null ) ? '1' : '',
			'marketing' => true === ( $body['marketingConsent'] ?? null ) ? '1' : '',
		);
		foreach ( array( 'name', 'email', 'phone', 'message', 'ref' ) as $field ) {
			if ( isset( $body[ $field ] ) ) {
				$post[ $field ] = (string) self::text( $body[ $field ] );
			}
		}
		if ( isset( $body['slots'][0] ) ) {
			$slot = $body['slots'][0];
			if ( isset( $slot['dayOffset'] ) ) {
				$slot['date'] = gmdate( 'Y-m-d', intdiv( time(), DAY_IN_SECONDS ) * DAY_IN_SECONDS + (int) $slot['dayOffset'] * DAY_IN_SECONDS );
			}
			$post['date']        = (string) ( $slot['date'] ?? '' );
			$post['time_of_day'] = (string) ( $slot['timeOfDay'] ?? '' );
		}
		return $post;
	}

	/**
	 * [S9-F5] Every fixture case gets the verdict the contract gives it.
	 */
	public function test_s9_f5_every_fixture_case_matches_the_contract(): void {
		$fixture = self::fixture();
		$this->assertGreaterThan( 40, count( $fixture['cases'] ) );
		$form  = LeadForm::from_settings();
		$wrong = array();
		foreach ( $fixture['cases'] as $case ) {
			$accepted = null !== $form->validate_post( self::post( $case['kind'], $case['body'] ) );
			if ( $accepted !== $case['valid'] ) {
				$wrong[] = $case['id'];
			}
		}
		$this->assertSame( array(), $wrong, 'cases where the plugin and the contract disagree' );
	}

	/**
	 * [S9-F5] The plugin's limits and Turnstile action are the contract's (the fixture states the contract's values).
	 */
	public function test_s9_f5_limits_and_action_follow_the_contract(): void {
		$fixture = self::fixture();
		$this->assertSame( $fixture['limits'], LeadForm::LIMITS );
		$this->assertSame( 25, LeadForm::LIMITS['phone'] );
		$this->assertSame( $fixture['turnstileAction'], Turnstile::ACTION );
	}

	/**
	 * [S9-F5] The form template renders the limits and the action, not copies of them.
	 */
	public function test_s9_f5_template_uses_the_limits_and_the_action(): void {
		$html = do_blocks( '<!-- wp:inmolink/lead-form {"ref":"INM-1001"} /-->' );
		$this->assertStringContainsString( 'name="name" required maxlength="' . LeadForm::LIMITS['name'] . '"', $html );
		$this->assertStringContainsString( 'name="phone" maxlength="' . LeadForm::LIMITS['phone'] . '"', $html );
		$this->assertStringContainsString( 'name="message" maxlength="' . LeadForm::LIMITS['message'] . '"', $html );
		$this->assertStringContainsString( 'data-action="' . Turnstile::ACTION . '"', $html );
	}

	/**
	 * [S9-F5] Invalid UTF-8 is refused outright, in any field.
	 */
	public function test_s9_f5_invalid_utf8_is_refused(): void {
		$form = LeadForm::from_settings();
		$ok   = self::post(
			'enquiry',
			array(
				'name'            => 'Ana Buyer',
				'email'           => 'ana@example.com',
				'privacyAccepted' => true,
			)
		);
		$this->assertNotNull( $form->validate_post( $ok ) );
		foreach ( array( 'name', 'phone', 'message', 'email' ) as $field ) {
			$bad           = $ok;
			$bad[ $field ] = ( 'email' === $field ? 'ana@example.com' : 'Ana ' ) . "\xC3\x28";
			$this->assertNull( $form->validate_post( $bad ), $field );
		}
	}
}
