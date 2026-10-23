<?php
/**
 * Enquiry and viewing-request forms, posted server-side to the website API.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\Forms;

use Inmolink\Plugin\Api\Client;
use Inmolink\Plugin\Api\Response;
use Inmolink\Plugin\I18n\Locale;
use Inmolink\Plugin\Listings;
use Inmolink\Plugin\Net\Counter;
use Inmolink\Plugin\Net\Ip;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * The form posts to `admin-post.php` (logged-in or not); the plugin then posts the lead to `/v2/leads` or
 * `/v2/viewing-requests` with the secret key — the key never reaches the browser. Each submission's
 * `Idempotency-Key` comes from its solved Turnstile challenge (a double submit makes one lead; cached pages are safe),
 * forms carry a signed render time (bots that post at once are dropped), a honeypot field, Turnstile (see
 * {@see Turnstile}) and — for logged-in users — a nonce; verified submissions are limited per IP. The visitor is
 * redirected back with a result code only — nothing they typed is echoed or logged.
 */
class LeadForm {

	public const ACTION       = 'inmolink_lead';
	public const HONEYPOT     = 'inmolink_url';
	public const RESULT_PARAM = 'inmolink_form';
	/** Submissions per IP per window. */
	public const RATE_LIMIT  = 5;
	public const RATE_WINDOW = 10 * MINUTE_IN_SECONDS;
	/** Posts per IP per window that failed Turnstile; the next one is refused without a Cloudflare call (S8-F29). */
	public const FAIL_LIMIT  = 5;
	public const FAIL_WINDOW = 10 * MINUTE_IN_SECONDS;
	/**
	 * The contract's field caps (`LEAD_LIMITS` in packages/contracts/src/values.ts). The shared fixture
	 * tests/fixtures/leads/cases.json holds the contract's values; both test suites assert them (S9-F5).
	 */
	public const LIMITS = array(
		'name'    => 120,
		'email'   => 254,
		'phone'   => 25,
		'message' => 4000,
		'pageUrl' => 2048,
	);
	/** A form sent faster than this after rendering is a bot. */
	public const MIN_FILL_SECONDS = 3;
	/** Long enough for page caches: the stamp only proves the form was rendered by this site, a while ago. */
	public const MAX_AGE_SECONDS = 30 * DAY_IN_SECONDS;
	public const RESULTS         = array( 'sent', 'invalid', 'unavailable', 'busy', 'error', 'expired' );
	private const TIMES_OF_DAY   = array( 'ANY', 'MORNING', 'AFTERNOON', 'EVENING' );

	/**
	 * Creates the form handler.
	 *
	 * @param Client $client API client (background timeout).
	 */
	public function __construct( private readonly Client $client ) {}

	/**
	 * The handler wired from the settings.
	 */
	public static function from_settings(): self {
		return new self( Client::from_settings( 8 ) );
	}

	/**
	 * Hooks the `admin-post.php` handlers.
	 */
	public static function register(): void {
		add_action( 'admin_post_' . self::ACTION, array( self::class, 'handle' ) );
		add_action( 'admin_post_nopriv_' . self::ACTION, array( self::class, 'handle' ) );
	}

	/**
	 * Whether forms can be offered (Turnstile configured and the API set up).
	 */
	public static function available(): bool {
		return 'none' !== Turnstile::mode() && \Inmolink\Plugin\Settings::is_configured();
	}

	/**
	 * The values a rendered form carries in hidden fields.
	 *
	 * @param string $ref  Reference ('' for a general enquiry).
	 * @param string $kind `enquiry` or `viewing`.
	 * @return array{ref:string,kind:string,stamp:string,lang:string,page:string,site_key:string}
	 */
	public static function hidden_fields( string $ref, string $kind ): array {
		$now = time();
		return array(
			'ref'      => preg_match( Listings::REF_PATTERN, $ref ) ? $ref : '',
			'kind'     => 'viewing' === $kind ? 'viewing' : 'enquiry',
			'stamp'    => self::stamp( $now ),
			'lang'     => Locale::current(),
			'page'     => self::current_url(),
			'site_key' => Turnstile::site_key(),
		);
	}

	/**
	 * `admin-post.php?action=inmolink_lead`: checks the nonce, submits, redirects back with a result code.
	 */
	public static function handle(): void {
		// phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- validated field by field in submit().
		$post = isset( $_POST ) && is_array( $_POST ) ? wp_unslash( $_POST ) : array();
		// Logged-in users: a nonce (CSRF would act as them). Visitors: none — an anonymous form has no session to forge,
		// and cached pages would serve stale nonces; Turnstile, the signed stamp and the honeypot guard it instead.
		$ok   = ! is_user_logged_in() || ( isset( $post['_wpnonce'] ) && is_string( $post['_wpnonce'] ) && false !== wp_verify_nonce( $post['_wpnonce'], self::ACTION ) );
		$code = $ok ? self::from_settings()->submit( $post, self::remote_ip() ) : 'expired';
		$page = isset( $post['page'] ) && is_string( $post['page'] ) ? $post['page'] : '';
		wp_safe_redirect( self::result_url( $page, $code ) );
		exit;
	}

	/**
	 * Validates a submission and posts it to the API.
	 *
	 * @param array<string,mixed> $post The form fields (unslashed).
	 * @param string              $ip   The visitor's IP (rate limit, Turnstile).
	 * @return string Result code ({@see RESULTS}).
	 */
	public function submit( array $post, string $ip ): string {
		$field = static fn ( string $name ): string => isset( $post[ $name ] ) && is_string( $post[ $name ] ) ? self::js_trim( $post[ $name ] ) : '';

		// Bots: a filled honeypot or an instant post look like success (nothing is sent; nothing tells them why).
		if ( '' !== $field( self::HONEYPOT ) || ! self::stamp_ok( $field( 'stamp' ) ) ) {
			return 'sent';
		}
		if ( self::rate_used( $ip ) >= self::RATE_LIMIT || self::fail_used( $ip ) >= self::FAIL_LIMIT ) {
			return 'busy';
		}
		if ( ! self::utf8_ok( $post ) ) {
			return 'invalid';
		}
		$mode = Turnstile::mode();
		if ( 'none' === $mode ) {
			return 'unavailable';
		}

		$token = $field( 'cf-turnstile-response' );
		if ( '' === $token || strlen( $token ) > 2048 ) {
			return 'invalid';
		}
		// One key per solved challenge: a resend (same token) is the same submission, and page caches cannot hand two
		// visitors the same key (a key rendered into the page would be shared by every visitor of a cached copy).
		$idem = 'wp-' . substr( hash( 'sha256', 'inmolink-lead|' . $token ), 0, 48 );
		$body = $this->body( $field );
		if ( null === $body ) {
			return 'invalid';
		}

		if ( 'own' === $mode ) {
			if ( ! Turnstile::verify( $token, $ip, hash( 'sha256', $idem . '|' . (string) wp_json_encode( $body ) ) ) ) {
				self::fail_count( $ip );
				return 'invalid';
			}
			// Allowed only because the plugin itself just verified the visitor (S7-05).
			$body['serverVerified'] = true;
		} else {
			$body['turnstileToken'] = $token;
		}
		// Counted only past the bot check, so junk posts cannot lock a shared IP (a proxy, an office) out.
		self::rate_count( $ip );

		$path     = 'viewing' === $field( 'kind' ) ? '/v2/viewing-requests' : '/v2/leads';
		$response = $this->client->post( $path, $body, $idem );
		if ( $response->ok() ) {
			return 'sent';
		}
		if ( Response::NOT_FOUND === $response->kind || in_array( $response->status, array( 403, 422 ), true ) ) {
			return 'invalid';
		}
		return 429 === $response->status ? 'busy' : 'error';
	}

	/**
	 * The API body for a form post (field rules of the website API contract), or null when a field is invalid.
	 *
	 * @param array<string,mixed> $post The form fields (unslashed).
	 * @return array<string,mixed>|null
	 */
	public function validate_post( array $post ): ?array {
		if ( ! self::utf8_ok( $post ) ) {
			return null;
		}
		return $this->body( static fn ( string $name ): string => isset( $post[ $name ] ) && is_string( $post[ $name ] ) ? self::js_trim( $post[ $name ] ) : '' );
	}

	/**
	 * The API body from the form fields, or null when a field is invalid.
	 *
	 * @param callable $field Field reader.
	 * @return array<string,mixed>|null
	 */
	private function body( callable $field ): ?array {
		$name    = self::js_trim( $field( 'name' ) );
		$phone   = self::js_trim( $field( 'phone' ) );
		$message = self::js_trim( $field( 'message' ) );
		if ( ! self::name_ok( $name ) || self::js_length( $phone ) > self::LIMITS['phone'] || self::js_length( $message ) > self::LIMITS['message'] || self::has_control( $message ) ) {
			return null;
		}
		$name    = sanitize_text_field( $name );
		$email   = is_email( $field( 'email' ) ) ? sanitize_email( $field( 'email' ) ) : '';
		$message = sanitize_textarea_field( $message );
		$ref     = $field( 'ref' );
		$kind    = $field( 'kind' );

		if ( '' === $name ) {
			return null;
		}
		if ( '' === $email || strlen( $email ) > self::LIMITS['email'] || ! is_email( $email ) ) {
			return null;
		}
		if ( '' !== $phone && ! preg_match( '/^\+?[0-9 ().-]{6,' . ( self::LIMITS['phone'] - 1 ) . '}\z/', $phone ) ) {
			return null;
		}
		if ( '1' !== $field( 'privacy' ) ) {
			return null;
		}
		if ( '' !== $ref && ! preg_match( Listings::REF_PATTERN, $ref ) ) {
			return null;
		}

		$body = array(
			'name'             => $name,
			'email'            => $email,
			'privacyAccepted'  => true,
			'marketingConsent' => '1' === $field( 'marketing' ),
			'lang'             => \Inmolink\Plugin\Settings::resolve_locale( $field( 'lang' ) ),
		);
		if ( '' !== $phone ) {
			$body['phone'] = $phone;
		}
		if ( '' !== $message ) {
			$body['message'] = $message;
		}
		$page = $field( 'page' );
		if ( '' !== $page && self::same_site_https( $page ) ) {
			$body['pageUrl'] = $page;
		}
		if ( '' !== $ref ) {
			$body['ref'] = $ref;
		}

		if ( 'viewing' === $kind ) {
			$date = $field( 'date' );
			$time = $field( 'time_of_day' );
			if ( '' === $ref || ! preg_match( '/^\d{4}-\d{2}-\d{2}\z/', $date ) || ! in_array( $time, self::TIMES_OF_DAY, true ) ) {
				return null;
			}
			list( $y, $m, $d ) = array_map( 'intval', explode( '-', $date ) );
			// From today (a day of slack for time zones) to a year ahead, like the contract.
			$day   = intdiv( (int) gmmktime( 0, 0, 0, $m, $d, $y ), DAY_IN_SECONDS );
			$today = intdiv( time(), DAY_IN_SECONDS );
			if ( ! checkdate( $m, $d, $y ) || $day < $today - 1 || $day > $today + 366 ) {
				return null;
			}
			$body['slots'] = array(
				array(
					'date'      => $date,
					'timeOfDay' => $time,
				),
			);
		}
		return $body;
	}

	/**
	 * The page to return to, with the result code (only the code: no submitted value is echoed).
	 *
	 * @param string $page Page URL from the form.
	 * @param string $code Result code.
	 */
	public static function result_url( string $page, string $code ): string {
		$back = wp_validate_redirect( $page, home_url( '/' ) );
		return add_query_arg( self::RESULT_PARAM, in_array( $code, self::RESULTS, true ) ? $code : 'error', $back ) . '#inmolink-form';
	}

	/**
	 * A signed render time.
	 *
	 * @param int $time Unix time the form was rendered.
	 */
	public static function stamp( int $time ): string {
		return $time . '.' . self::sign( (string) $time );
	}

	/**
	 * Whether the signed render time is valid and old enough.
	 *
	 * @param string $stamp `time.signature`.
	 */
	private static function stamp_ok( string $stamp ): bool {
		if ( ! preg_match( '/^(\d{9,11})\.([0-9a-f]{64})$/', $stamp, $m ) || ! hash_equals( self::sign( $m[1] ), $m[2] ) ) {
			return false;
		}
		$age = time() - (int) $m[1];
		return $age >= self::MIN_FILL_SECONDS && $age <= self::MAX_AGE_SECONDS;
	}

	/**
	 * Submissions counted for the IP in the current window.
	 *
	 * @param string $ip IP.
	 */
	private static function rate_used( string $ip ): int {
		return Counter::count( 'form', $ip );
	}

	/**
	 * Counts a submission for the IP.
	 *
	 * @param string $ip IP.
	 */
	private static function rate_count( string $ip ): void {
		Counter::hit( 'form', $ip, self::RATE_WINDOW );
	}

	/**
	 * Whether every string field is valid UTF-8 (anything else is refused outright: a regex on invalid UTF-8 fails
	 * silently, which would let a malformed value through the control-character check).
	 *
	 * @param array<string,mixed> $post Form fields.
	 */
	private static function utf8_ok( array $post ): bool {
		foreach ( $post as $value ) {
			if ( is_string( $value ) && ! mb_check_encoding( $value, 'UTF-8' ) ) {
				return false;
			}
		}
		return true;
	}

	/**
	 * A name per the contract (`LeadName`): 1 to 120 characters, one line without control characters or markup brackets,
	 * and no links, domains (`.xx`) or digit runs.
	 *
	 * @param string $name Trimmed name.
	 */
	public static function name_ok( string $name ): bool {
		return '' !== $name
			&& self::js_length( $name ) <= self::LIMITS['name']
			&& 1 === preg_match( '/^[^\p{Cc}<>]*\z/u', $name )
			&& 1 !== preg_match( '/(?:https?:\/\/|www\.|\.[a-z]{2,}|\d{2,})/i', $name );
	}

	/**
	 * Control characters (C0, DEL, C1) other than tab, line feed and carriage return.
	 *
	 * @param string $text Text.
	 */
	private static function has_control( string $text ): bool {
		return 1 === preg_match( '/[\x{0}-\x{8}\x{B}\x{C}\x{E}-\x{1F}\x{7F}-\x{9F}]/u', $text );
	}

	/**
	 * JavaScript's `String.prototype.trim` (Unicode white space), so a value is trimmed as the contract trims it.
	 *
	 * @param string $text Text.
	 */
	private static function js_trim( string $text ): string {
		$space = '[\t\n\x{B}\f\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]';
		return (string) preg_replace( '/^' . $space . '+|' . $space . '+\z/u', '', $text );
	}

	/**
	 * Length in UTF-16 code units, which is what the contract's `.max()` counts.
	 *
	 * @param string $text Text.
	 */
	private static function js_length( string $text ): int {
		return (int) ( strlen( (string) mb_convert_encoding( $text, 'UTF-16LE', 'UTF-8' ) ) / 2 );
	}

	/**
	 * Posts that failed Turnstile for the IP in the current window.
	 *
	 * @param string $ip IP.
	 */
	private static function fail_used( string $ip ): int {
		return Counter::count( 'fail', $ip );
	}

	/**
	 * Counts a post that failed Turnstile.
	 *
	 * @param string $ip IP.
	 */
	private static function fail_count( string $ip ): void {
		Counter::hit( 'fail', $ip, self::FAIL_WINDOW );
	}

	/**
	 * HMAC of a value with the site's salt.
	 *
	 * @param string $value Value.
	 */
	private static function sign( string $value ): string {
		return hash_hmac( 'sha256', 'inmolink-form|' . $value, wp_salt( 'nonce' ) );
	}

	/**
	 * Whether a URL is an https page of this site (the API accepts https page URLs only).
	 *
	 * @param string $url URL.
	 */
	private static function same_site_https( string $url ): bool {
		$host = wp_parse_url( home_url( '/' ), PHP_URL_HOST );
		return 'https' === wp_parse_url( $url, PHP_URL_SCHEME ) && wp_parse_url( $url, PHP_URL_HOST ) === $host && strlen( $url ) <= 2048;
	}

	/**
	 * The current page URL.
	 */
	private static function current_url(): string {
		$path = isset( $_SERVER['REQUEST_URI'] ) && is_string( $_SERVER['REQUEST_URI'] ) ? sanitize_text_field( wp_unslash( $_SERVER['REQUEST_URI'] ) ) : '/';
		return home_url( (string) wp_parse_url( $path, PHP_URL_PATH ) );
	}

	/**
	 * The visitor's IP: `REMOTE_ADDR`, or behind a trusted proxy the client address from its header
	 * (see {@see Ip::client()}: `INMOLINK_TRUSTED_PROXIES` CIDRs, `INMOLINK_TRUSTED_PROXY_HEADER`).
	 */
	public static function remote_ip(): string {
		return Ip::client();
	}
}
