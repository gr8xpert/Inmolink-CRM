<?php
/**
 * Cloudflare Turnstile for the plugin's forms.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\Forms;

use Inmolink\Plugin\Crypto;
use Inmolink\Plugin\Settings;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Three modes, from the configuration:
 * - `own`: the site has its own Turnstile widget (site key + secret). The plugin verifies the visitor's token with
 *   Cloudflare (`siteverify`, action `website-lead`) and tells the API `serverVerified: true` — allowed only because
 *   this check ran (S7-05).
 * - `forward`: only a site key (the platform's, registered for this host): the token is forwarded to the API, which
 *   verifies it (`turnstileToken`).
 * - `none`: no keys — the forms are not offered (a form without a bot check would be spam).
 *
 * Keys: `INMOLINK_TURNSTILE_SITE_KEY` / `INMOLINK_TURNSTILE_SECRET` in wp-config.php, else the settings (the secret is
 * stored encrypted and write-only). `INMOLINK_TURNSTILE_TEST` switches to Cloudflare's always-passing test keys
 * (development and tests; the real keys are HUMAN-ACTIONS H3).
 */
class Turnstile {

	public const ACTION        = 'website-lead';
	public const VERIFY_URL    = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
	public const SCRIPT_URL    = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
	public const SECRET_OPTION = 'inmolink_turnstile_secret';
	/** Cloudflare's documented test keys (always pass). */
	public const TEST_SITE_KEY = '1x00000000000000000000AA';
	public const TEST_SECRET   = '1x0000000000000000000000000000000AA';
	private const KEY_PATTERN  = '/^[A-Za-z0-9_-]{10,100}\z/';
	/** How long a verified token stays bound to its submission (seconds). */
	public const TOKEN_TTL    = 300;
	private const USED_PREFIX = 'inmolink_ts_';
	/** UUIDv5 namespace of the siteverify idempotency keys (fixed; a random UUID generated once for this plugin). */
	private const KEY_NAMESPACE = '6f1b3a52-8d0e-4c47-9b1a-2e5d7c9f4a10';

	/**
	 * `own`, `forward` or `none`.
	 */
	public static function mode(): string {
		if ( '' === self::site_key() ) {
			return 'none';
		}
		return '' !== self::secret() ? 'own' : 'forward';
	}

	/**
	 * The widget's site key ('' when none).
	 */
	public static function site_key(): string {
		if ( self::test_mode() ) {
			return self::TEST_SITE_KEY;
		}
		if ( defined( 'INMOLINK_TURNSTILE_SITE_KEY' ) && is_string( INMOLINK_TURNSTILE_SITE_KEY ) ) {
			return preg_match( self::KEY_PATTERN, INMOLINK_TURNSTILE_SITE_KEY ) ? INMOLINK_TURNSTILE_SITE_KEY : '';
		}
		return (string) Settings::get( 'turnstile_site_key' );
	}

	/**
	 * The secret ('' when none).
	 */
	private static function secret(): string {
		if ( self::test_mode() ) {
			return self::TEST_SECRET;
		}
		if ( defined( 'INMOLINK_TURNSTILE_SECRET' ) && is_string( INMOLINK_TURNSTILE_SECRET ) ) {
			return INMOLINK_TURNSTILE_SECRET;
		}
		$sealed = get_option( self::SECRET_OPTION, '' );
		return is_string( $sealed ) && '' !== $sealed ? (string) ( Crypto::open( $sealed ) ?? '' ) : '';
	}

	/**
	 * Whether a secret is configured (for the settings page; never returns it).
	 */
	public static function has_secret(): bool {
		return '' !== self::secret();
	}

	/**
	 * Stores the secret encrypted (autoload off). An invalid value is ignored.
	 *
	 * @param string $secret Secret as entered.
	 */
	public static function set_secret( string $secret ): bool {
		$secret = trim( $secret );
		if ( ! preg_match( self::KEY_PATTERN, $secret ) ) {
			return false;
		}
		update_option( self::SECRET_OPTION, Crypto::seal( $secret ), false );
		return true;
	}

	/**
	 * Removes the stored secret.
	 */
	public static function clear_secret(): void {
		delete_option( self::SECRET_OPTION );
	}

	/**
	 * Whether a site key looks valid.
	 *
	 * @param string $key Site key.
	 */
	public static function valid_site_key( string $key ): bool {
		return 1 === preg_match( self::KEY_PATTERN, $key );
	}

	/**
	 * `own` mode: asks Cloudflare whether the visitor's token is good, for this action.
	 *
	 * A token is single-use at Cloudflare, which caches a success per `idempotency_key`. The key is a UUIDv5 of the
	 * submission's own key plus the token's hash: a network retry of the same submission gets the same key and succeeds,
	 * while the same token on another submission would get another key — and is refused here, before any Cloudflare
	 * call, for {@see TOKEN_TTL} seconds after a success (so one solved challenge cannot carry several submissions).
	 *
	 * @param string $token          The form's `cf-turnstile-response`.
	 * @param string $remote_ip      The visitor's IP.
	 * @param string $submission_key A digest of the validated submission (token and content), same for a retry.
	 */
	public static function verify( string $token, string $remote_ip, string $submission_key ): bool {
		if ( '' === $token || strlen( $token ) > 2048 || 'own' !== self::mode() || '' === $submission_key ) {
			return false;
		}
		$used = self::USED_PREFIX . substr( hash( 'sha256', $token ), 0, 40 );
		$prev = get_transient( $used );
		if ( is_string( $prev ) && ! hash_equals( $prev, $submission_key ) ) {
			return false;
		}
		$response = wp_remote_post(
			self::VERIFY_URL,
			array(
				'timeout' => 5,
				'body'    => array(
					'secret'          => self::secret(),
					'response'        => $token,
					'remoteip'        => $remote_ip,
					'idempotency_key' => self::idempotency_key( $token, $submission_key ),
				),
			)
		);
		if ( is_wp_error( $response ) || 200 !== (int) wp_remote_retrieve_response_code( $response ) ) {
			return false;
		}
		$body = json_decode( (string) wp_remote_retrieve_body( $response ), true );
		if ( ! is_array( $body ) || true !== ( $body['success'] ?? null ) ) {
			return false;
		}
		if ( self::test_mode() ) {
			set_transient( $used, $submission_key, self::TOKEN_TTL );
			return true;
		}
		// Real keys: our action (a token from another form is refused) and this site's host (a widget shared by several
		// domains does not make their tokens good here).
		$host = wp_parse_url( home_url( '/' ), PHP_URL_HOST );
		$good = self::ACTION === ( $body['action'] ?? null ) && is_string( $body['hostname'] ?? null ) && strtolower( $body['hostname'] ) === strtolower( (string) $host );
		if ( $good ) {
			set_transient( $used, $submission_key, self::TOKEN_TTL );
		}
		return $good;
	}

	/**
	 * Cloudflare's `idempotency_key` must be a UUID: a UUIDv5 (RFC 4122, SHA-1) under a fixed namespace of the submission
	 * key and the token's SHA-256 — stable for a retry, different for another submission or token.
	 *
	 * @param string $token          Turnstile token.
	 * @param string $submission_key Submission digest.
	 */
	public static function idempotency_key( string $token, string $submission_key ): string {
		$ns   = hex2bin( str_replace( '-', '', self::KEY_NAMESPACE ) );
		$hash = sha1( (string) $ns . $submission_key . '|' . hash( 'sha256', $token ), true );
		$hex  = bin2hex( substr( $hash, 0, 16 ) );
		// Version 5 and the RFC 4122 variant.
		$hex[12] = '5';
		$hex[16] = dechex( ( hexdec( $hex[16] ) & 0x3 ) | 0x8 );
		return substr( $hex, 0, 8 ) . '-' . substr( $hex, 8, 4 ) . '-' . substr( $hex, 12, 4 ) . '-' . substr( $hex, 16, 4 ) . '-' . substr( $hex, 20, 12 );
	}

	/**
	 * `INMOLINK_TURNSTILE_TEST` is set — honoured outside production only (the test keys always pass).
	 */
	public static function test_mode(): bool {
		return defined( 'INMOLINK_TURNSTILE_TEST' ) && true === INMOLINK_TURNSTILE_TEST && 'production' !== wp_get_environment_type();
	}
}
