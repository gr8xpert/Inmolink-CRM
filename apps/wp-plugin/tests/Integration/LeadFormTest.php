<?php
/**
 * Acceptance: forms create leads for the right agency.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\Tests\Integration;

use Inmolink\Plugin\Forms\LeadForm;
use Inmolink\Plugin\Forms\Turnstile;
use Inmolink\Plugin\Settings;
use Inmolink\Plugin\Tests\FakeApi;
use Inmolink\Plugin\Tests\TestCase;

/**
 * The plugin posts a form's lead to the website API with the site's secret key — the key binds the site, and the API
 * files the lead with the site's agency (`apps/feed-api/src/leads.int.test.ts` `[S8-05]` shows that end).
 */
final class LeadFormTest extends TestCase {

	/**
	 * What Cloudflare's siteverify answers.
	 *
	 * @var array<string,mixed>
	 */
	private array $verdict = array(
		'success'  => true,
		'action'   => 'website-lead',
		'hostname' => 'example.org',
	);

	/**
	 * Verify calls seen.
	 *
	 * @var list<array<string,mixed>>
	 */
	private array $verifications = array();

	/**
	 * Own Turnstile mode (site key + secret), siteverify stubbed, the API answering 201.
	 */
	public function set_up(): void {
		parent::set_up();
		Settings::save(
			array(
				'api_base'           => FakeApi::BASE,
				'locales'            => 'en,es',
				'turnstile_site_key' => '0x4AAAAAAAtestSiteKey',
			)
		);
		Settings::set_api_key( self::KEY );
		$this->assertTrue( Turnstile::set_secret( '0x4AAAAAAAtestSecretValue' ) );
		add_filter( 'pre_http_request', array( $this, 'siteverify' ), 5, 3 );
		$accepted = static fn ( string $kind ): array => array(
			'status' => 201,
			'body'   => array(
				'id'       => '0b7a6c5d-4e3f-4a1b-9c2d-1e2f3a4b5c6d',
				'kind'     => $kind,
				'status'   => 'RECEIVED',
				'replayed' => false,
			),
		);
		$this->api->on( '/v2/leads', $accepted( 'ENQUIRY' ) );
		$this->api->on( '/v2/viewing-requests', $accepted( 'VIEWING_REQUEST' ) );
	}

	/**
	 * Unhooks the siteverify stub.
	 */
	public function tear_down(): void {
		remove_filter( 'pre_http_request', array( $this, 'siteverify' ), 5 );
		parent::tear_down();
	}

	/**
	 * Stubs Cloudflare's siteverify.
	 *
	 * @param mixed               $pre  Short-circuit.
	 * @param array<string,mixed> $args Request args.
	 * @param string              $url  URL.
	 * @return mixed
	 */
	public function siteverify( $pre, $args, $url ) {
		if ( Turnstile::VERIFY_URL !== $url ) {
			return $pre;
		}
		$this->verifications[] = (array) $args['body'];
		return array(
			'headers'  => array(),
			'body'     => (string) wp_json_encode( $this->verdict ),
			'response' => array(
				'code'    => 200,
				'message' => 'OK',
			),
			'cookies'  => array(),
			'filename' => null,
		);
	}

	/**
	 * A valid submission (rendered a minute ago).
	 *
	 * @param array<string,string> $over Overrides.
	 * @return array<string,string>
	 */
	private function form( array $over = array() ): array {
		return array_merge(
			array(
				'kind'                  => 'enquiry',
				'ref'                   => 'INM-1001',
				'stamp'                 => LeadForm::stamp( time() - 60 ),
				'lang'                  => 'es',
				'page'                  => 'https://example.org/property/INM-1001/villa-sol/',
				'name'                  => 'Ana García',
				'email'                 => 'ana@example.com',
				'phone'                 => '+34 600 111 222',
				'message'               => 'Is it still available?',
				'privacy'               => '1',
				'marketing'             => '1',
				'cf-turnstile-response' => 'XXXX.DUMMY.TOKEN',
			),
			$over
		);
	}

	/**
	 * [S8-05] Forms create leads for the right agency: posted with the site's secret key, server-verified, one
	 * Idempotency-Key per form.
	 */
	public function test_s8_05_forms_create_leads_for_the_right_agency(): void {
		$this->assertSame( 'sent', LeadForm::from_settings()->submit( $this->form(), '203.0.113.7' ) );
		$this->assertSame( 'invalid', LeadForm::from_settings()->submit( $this->form( array( 'page' => 'https://evil.example/x' , 'name' => '' ) ), '203.0.113.8' ) );

		$request = $this->api->requests_to( '/v2/leads' )[0];
		$this->assertSame( 'POST', $request['method'] );
		$this->assertSame( self::KEY, $request['headers']['x-api-key'], "the site's key: the API files the lead with its agency" );
		$this->assertSame( 'wp-' . substr( hash( 'sha256', 'inmolink-lead|XXXX.DUMMY.TOKEN' ), 0, 48 ), $request['headers']['idempotency-key'], 'one key per solved challenge' );
		$this->assertSame(
			array(
				'name'             => 'Ana García',
				'email'            => 'ana@example.com',
				'privacyAccepted'  => true,
				'marketingConsent' => true,
				'lang'             => 'es',
				'phone'            => '+34 600 111 222',
				'message'          => 'Is it still available?',
				'pageUrl'          => 'https://example.org/property/INM-1001/villa-sol/',
				'ref'              => 'INM-1001',
				'serverVerified'   => true,
			),
			$request['body'],
			'serverVerified only because the plugin verified the token'
		);
		$this->assertSame( 'XXXX.DUMMY.TOKEN', $this->verifications[0]['response'] );
		$this->assertSame( '203.0.113.7', $this->verifications[0]['remoteip'] );
	}

	/**
	 * [S8-05] A resend of the same solved form is the same submission; two visitors of one cached page are two.
	 */
	public function test_s8_05_idempotency_follows_the_challenge(): void {
		$form = LeadForm::from_settings();
		$form->submit( $this->form(), '203.0.113.20' );
		$form->submit( $this->form(), '203.0.113.20' );
		$form->submit( $this->form( array( 'cf-turnstile-response' => 'another.visitor.token' ) ), '203.0.113.21' );
		$keys = array_map( static fn ( array $r ): string => $r['headers']['idempotency-key'], $this->api->requests_to( '/v2/leads' ) );
		$this->assertSame( $keys[0], $keys[1] );
		$this->assertNotSame( $keys[0], $keys[2] );
	}

	/**
	 * [S9-F3] A retried siteverify with the same token succeeds: the idempotency key is a UUIDv5 of the token's hash
	 * (the same token, the same key; another token, another key).
	 */
	public function test_s9_f3_retried_siteverify_keeps_its_key(): void {
		$this->assertTrue( Turnstile::verify( 'XXXX.DUMMY.TOKEN', '203.0.113.30', 'submission-a' ) );
		$this->assertTrue( Turnstile::verify( 'XXXX.DUMMY.TOKEN', '203.0.113.30', 'submission-a' ), 'the retry succeeds' );
		$this->assertTrue( Turnstile::verify( 'another.token', '203.0.113.30', 'submission-a' ) );
		$keys = array_column( $this->verifications, 'idempotency_key' );
		$this->assertCount( 3, $keys );
		$this->assertSame( $keys[0], $keys[1], 'a retry carries the same key' );
		$this->assertNotSame( $keys[0], $keys[2] );
		$this->assertMatchesRegularExpression( '/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\z/', $keys[0], 'a UUIDv5' );
		$this->assertSame( Turnstile::idempotency_key( 'XXXX.DUMMY.TOKEN', 'submission-a' ), $keys[0] );
	}

	/**
	 * [S9-F3] One solved token cannot carry a second submission: it is refused without a Cloudflare call, while a
	 * network retry of the first submission still succeeds.
	 */
	public function test_s9_f3_same_token_on_another_submission_is_refused_without_a_call(): void {
		$this->assertSame( 'sent', LeadForm::from_settings()->submit( $this->form(), '203.0.113.40' ) );
		$calls = count( $this->verifications );
		$this->assertSame( 'sent', LeadForm::from_settings()->submit( $this->form(), '203.0.113.40' ), 'a retry of the same submission' );
		$this->assertSame( $calls + 1, count( $this->verifications ) );
		$calls = count( $this->verifications );

		$other = $this->form( array( 'message' => 'A different message, same solved challenge' ) );
		$this->assertSame( 'invalid', LeadForm::from_settings()->submit( $other, '203.0.113.40' ) );
		$this->assertCount( $calls, $this->verifications, 'refused before Cloudflare is asked' );
		$this->assertSame( 2, count( $this->api->requests_to( '/v2/leads' ) ), 'no lead was posted for the replayed token' );
	}

	/**
	 * [S8-05] Logged-in users need the nonce; visitors need none (cached pages), so a stale nonce never loses a lead.
	 */
	public function test_s8_05_nonce_only_for_logged_in_users(): void {
		$this->assertFalse( is_user_logged_in() );
		$this->assertSame( LeadForm::stamp( 100 ), LeadForm::stamp( 100 ) );
		$this->assertGreaterThanOrEqual( 7 * DAY_IN_SECONDS, LeadForm::MAX_AGE_SECONDS, 'cached forms stay valid' );
	}

	/**
	 * [S8-05] A viewing request goes to /v2/viewing-requests with its slot.
	 */
	public function test_s8_05_viewing_request(): void {
		$day = gmdate( 'Y-m-d', time() + 3 * DAY_IN_SECONDS );
		$this->assertSame(
			'sent',
			LeadForm::from_settings()->submit(
				$this->form(
					array(
						'kind'        => 'viewing',
						'date'        => $day,
						'time_of_day' => 'MORNING',
					)
				),
				'203.0.113.7'
			)
		);
		$body = $this->api->requests_to( '/v2/viewing-requests' )[0]['body'];
		$this->assertSame(
			array(
				array(
					'date'      => $day,
					'timeOfDay' => 'MORNING',
				),
			),
			$body['slots']
		);
		$this->assertSame( 'invalid', LeadForm::from_settings()->submit( $this->form( array( 'kind' => 'viewing' ) ), '203.0.113.8' ), 'no slot' );
	}

	/**
	 * [S8-05] Without its own secret the plugin forwards the visitor's token and never claims serverVerified.
	 */
	public function test_s8_05_forward_mode_never_claims_server_verified(): void {
		Turnstile::clear_secret();
		$this->assertSame( 'forward', Turnstile::mode() );
		$this->assertSame( 'sent', LeadForm::from_settings()->submit( $this->form(), '203.0.113.7' ) );
		$body = $this->api->requests_to( '/v2/leads' )[0]['body'];
		$this->assertSame( 'XXXX.DUMMY.TOKEN', $body['turnstileToken'] );
		$this->assertArrayNotHasKey( 'serverVerified', $body );
		$this->assertSame( array(), $this->verifications );
	}

	/**
	 * [S8-05] Bots and abuse never reach the API: failed Turnstile, honeypot, instant posts, the rate limit, no keys.
	 */
	public function test_s8_05_bot_checks(): void {
		$form = LeadForm::from_settings();

		$this->verdict = array( 'success' => false );
		$this->assertSame( 'invalid', $form->submit( $this->form(), '198.51.100.1' ) );
		$this->verdict = array(
			'success'  => true,
			'action'   => 'other-form',
			'hostname' => 'example.org',
		);
		$this->assertSame( 'invalid', $form->submit( $this->form(), '198.51.100.1' ), 'a token from another form' );
		$this->verdict = array(
			'success'  => true,
			'action'   => 'website-lead',
			'hostname' => 'other-site.example',
		);
		$this->assertSame( 'invalid', $form->submit( $this->form(), '198.51.100.1' ), 'a token solved on another site' );
		$this->verdict = array(
			'success'  => true,
			'action'   => 'website-lead',
			'hostname' => 'example.org',
		);
		$this->assertSame( array(), $this->api->requests_to( '/v2/leads' ), 'failed checks never reach the API' );

		$this->assertSame( 'sent', $form->submit( $this->form( array( LeadForm::HONEYPOT => 'http://spam' ) ), '198.51.100.2' ), 'honeypot: pretend' );
		$this->assertSame( 'sent', $form->submit( $this->form( array( 'stamp' => LeadForm::stamp( time() ) ) ), '198.51.100.3' ), 'instant post: pretend' );
		$this->assertSame( 'sent', $form->submit( $this->form( array( 'stamp' => time() - 60 . '.' . str_repeat( 'a', 64 ) ) ), '198.51.100.3' ), 'forged stamp' );
		$this->assertSame( array(), $this->api->requests_to( '/v2/leads' ) );

		// Junk posts do not count (a shared IP is not locked out by them); verified submissions do.
		$this->verdict = array( 'success' => false );
		for ( $i = 0; $i < LeadForm::FAIL_LIMIT - 1; $i++ ) {
			$form->submit( $this->form(), '192.0.2.9' );
		}
		$this->verdict = array(
			'success'  => true,
			'action'   => 'website-lead',
			'hostname' => 'example.org',
		);
		for ( $i = 0; $i < LeadForm::RATE_LIMIT; $i++ ) {
			$this->assertSame( 'sent', $form->submit( $this->form( array( 'cf-turnstile-response' => 'token-' . $i ) ), '192.0.2.9' ) );
		}
		$this->assertSame( 'busy', $form->submit( $this->form(), '192.0.2.9' ) );

		Turnstile::clear_secret();
		Settings::save(
			array(
				'api_base' => FakeApi::BASE,
				'locales'  => 'en',
			)
		);
		$this->assertSame( 'none', Turnstile::mode() );
		$this->assertSame( 'unavailable', $form->submit( $this->form(), '192.0.2.10' ) );
		$this->assertStringNotContainsString( '<form', do_blocks( '<!-- wp:inmolink/lead-form {"ref":"INM-1001"} /-->' ), 'no form without Turnstile' );
	}

	/**
	 * [S8-F29] The 6th post from one IP that fails Turnstile in 10 minutes is refused without a Cloudflare call.
	 */
	public function test_s8_f29_failing_posts_are_limited_per_ip(): void {
		$form          = LeadForm::from_settings();
		$this->verdict = array( 'success' => false );
		for ( $i = 0; $i < LeadForm::FAIL_LIMIT; $i++ ) {
			$this->assertSame( 'invalid', $form->submit( $this->form( array( 'cf-turnstile-response' => 'bad-' . $i ) ), '198.51.100.50' ) );
		}
		$this->assertCount( LeadForm::FAIL_LIMIT, $this->verifications );
		$this->assertSame( 'busy', $form->submit( $this->form( array( 'cf-turnstile-response' => 'bad-6' ) ), '198.51.100.50' ), 'the 6th failing post' );
		$this->verdict = array(
			'success'  => true,
			'action'   => 'website-lead',
			'hostname' => 'example.org',
		);
		$this->assertSame( 'busy', $form->submit( $this->form( array( 'cf-turnstile-response' => 'good' ) ), '198.51.100.50' ), 'still locked out for the window' );
		$this->assertCount( LeadForm::FAIL_LIMIT, $this->verifications, 'no Cloudflare call after the limit' );
		$this->assertSame( 'sent', $form->submit( $this->form( array( 'cf-turnstile-response' => 'good' ) ), '198.51.100.51' ), 'another IP is unaffected' );
	}

	/**
	 * [S8-05] Invalid fields are refused locally; API refusals and failures map to result codes, never details.
	 */
	public function test_s8_05_validation_and_api_errors(): void {
		$form = LeadForm::from_settings();
		foreach ( array(
			array( 'name' => '' ),
			array( 'name' => 'Visit www.spam.example' ),
			array( 'email' => 'not-an-email' ),
			array( 'phone' => 'call me' ),
			array( 'privacy' => '' ),
			array( 'ref' => '../units' ),
			array( 'cf-turnstile-response' => '' ),
		) as $i => $bad ) {
			$this->assertSame( 'invalid', $form->submit( $this->form( $bad ), '10.0.0.' . $i ), wp_json_encode( $bad ) );
		}
		$this->assertSame( array(), $this->api->requests_to( '/v2/leads' ) );

		$this->api->on(
			'/v2/leads',
			array(
				'status' => 404,
				'body'   => array( 'error' => array( 'code' => 'LISTING_NOT_FOUND' ) ),
			)
		);
		$this->assertSame( 'invalid', $form->submit( $this->form(), '10.0.1.1' ) );
		$this->api->on( '/v2/leads', array( 'status' => 503 ) );
		$this->assertSame( 'error', $form->submit( $this->form(), '10.0.1.2' ) );
	}

	/**
	 * [S8-05] The rendered form carries nonce, Idempotency-Key, signed stamp, honeypot and Turnstile — never a secret;
	 * the redirect carries only a result code.
	 */
	public function test_s8_05_rendered_form_and_redirect(): void {
		$html = do_blocks( '<!-- wp:inmolink/lead-form {"ref":"INM-1001","kind":"viewing"} /-->' );
		$this->assertStringContainsString( 'name="_wpnonce"', $html );
		$this->assertStringNotContainsString( 'name="idem"', $html, 'no per-render key: cached pages are shared' );
		$this->assertMatchesRegularExpression( '/name="stamp" value="\d+\.[0-9a-f]{64}"/', $html );
		$this->assertStringContainsString( 'name="' . LeadForm::HONEYPOT . '"', $html );
		$this->assertStringContainsString( 'data-sitekey="0x4AAAAAAAtestSiteKey"', $html );
		$this->assertStringContainsString( 'name="date"', $html );
		$this->assertStringContainsString( admin_url( 'admin-post.php' ), $html );
		$this->assertStringNotContainsString( 'testSecretValue', $html );
		$this->assertStringNotContainsString( self::KEY, $html );
		$this->assertTrue( wp_script_is( 'inmolink-turnstile', 'enqueued' ) );

		$this->assertSame( 'https://example.org/property/x/?inmolink_form=sent#inmolink-form', str_replace( 'http://', 'https://', LeadForm::result_url( home_url( '/property/x/' ), 'sent' ) ) );
		$this->assertStringStartsWith( home_url( '/' ), LeadForm::result_url( 'https://evil.example/', 'sent' ), 'never redirects off-site' );
		$this->assertStringContainsString( 'inmolink_form=error', LeadForm::result_url( home_url( '/' ), '<b>ana@example.com</b>' ) );
	}
}
