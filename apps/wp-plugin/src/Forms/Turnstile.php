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
	private const KEY_PATTERN  = '/^[A-Za-z0-9_-]{10,100}$/';

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
	 * @param string $token           The form's `cf-turnstile-response`.
	 * @param string $remote_ip       The visitor's IP.
	 * @param string $idempotency_key The submission's key (Cloudflare dedupes retries with it).
	 */
	public static function verify( string $token, string $remote_ip, string $idempotency_key ): bool {
		if ( '' === $token || strlen( $token ) > 2048 || 'own' !== self::mode() ) {
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
					'idempotency_key' => self::uuid_or_new( $idempotency_key ),
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
			return true;
		}
		// Real keys: our action (a token from another form is refused) and this site's host (a widget shared by several
		// domains does not make their tokens good here).
		$host = wp_parse_url( home_url( '/' ), PHP_URL_HOST );
		return self::ACTION === ( $body['action'] ?? null ) && is_string( $body['hostname'] ?? null ) && strtolower( $body['hostname'] ) === strtolower( (string) $host );
	}

	/**
	 * Cloudflare's `idempotency_key` must be a UUID: the form key when it is one, else a fresh one.
	 *
	 * @param string $key Form key.
	 */
	private static function uuid_or_new( string $key ): string {
		return wp_is_uuid( $key ) ? $key : wp_generate_uuid4();
	}

	/**
	 * `INMOLINK_TURNSTILE_TEST` is set — honoured outside production only (the test keys always pass).
	 */
	public static function test_mode(): bool {
		return defined( 'INMOLINK_TURNSTILE_TEST' ) && true === INMOLINK_TURNSTILE_TEST && 'production' !== wp_get_environment_type();
	}
}
