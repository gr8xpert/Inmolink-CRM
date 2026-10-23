<?php
/**
 * Server-side client for the Inmolink website API v2.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\Api;

use Inmolink\Plugin\Settings;
use const Inmolink\Plugin\VERSION;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Calls `/v2/*` with the secret key (`X-Api-Key`, never in the query string), short timeouts and conditional
 * requests (`If-None-Match` → 304). Runs on the server only: the secret key never reaches a browser.
 */
class Client {

	/** Timeout for calls made while a visitor waits for a page. */
	public const PAGE_TIMEOUT = 3;
	/** Timeout for background calls (delta sync, WP-CLI). */
	public const SYNC_TIMEOUT = 10;
	/** Largest body accepted, in bytes (a detail page is well under 150 KB gzip). */
	public const MAX_BODY = 4194304;
	/** Seconds no call is made after a network error, 5xx, 401, 403 or 429. */
	public const BACKOFF        = 60;
	public const DOWN_TRANSIENT = 'inmolink_api_down';

	/**
	 * Creates a client.
	 *
	 * @param string $base    API base URL, e.g. `https://api.example.com` (no trailing slash).
	 * @param string $api_key The secret key.
	 * @param int    $timeout Seconds.
	 */
	public function __construct(
		private readonly string $base,
		private readonly string $api_key,
		private readonly int $timeout = self::PAGE_TIMEOUT
	) {}

	/**
	 * A client configured from the settings.
	 *
	 * @param int $timeout Seconds.
	 */
	public static function from_settings( int $timeout = self::PAGE_TIMEOUT ): self {
		return new self( (string) Settings::get( 'api_base' ), Settings::api_key(), $timeout );
	}

	/**
	 * `GET` a website API path.
	 *
	 * @param string              $path  Path starting with `/v2/`.
	 * @param array<string,mixed> $query Query values; lists are sent comma-separated (the API's format), nulls dropped.
	 * @param string|null         $etag  The cached copy's ETag, sent as `If-None-Match`.
	 */
	public function get( string $path, array $query = array(), ?string $etag = null ): Response {
		if ( '' === $this->base || '' === $this->api_key ) {
			return new Response( Response::FAILED, 0, null, null, 'not_configured' );
		}
		if ( false !== get_transient( self::DOWN_TRANSIENT ) ) {
			// The API failed moments ago: do not make visitors wait for another timeout.
			return new Response( Response::FAILED, 0, null, null, 'backoff' );
		}

		$headers = array(
			'Accept'     => 'application/json',
			'X-Api-Key'  => $this->api_key,
			'User-Agent' => 'Inmolink-WordPress/' . VERSION . '; ' . home_url( '/' ),
		);
		if ( null !== $etag && '' !== $etag ) {
			$headers['If-None-Match'] = $etag;
		}

		$raw = wp_remote_get(
			$this->url( $path, $query ),
			array(
				'timeout'             => $this->timeout,
				'redirection'         => 0,
				'headers'             => $headers,
				'limit_response_size' => self::MAX_BODY,
				// Loopback / private targets are refused unless wp-config opts in (INMOLINK_ALLOW_LOCAL_API).
				'reject_unsafe_urls'  => ! Settings::allow_local_api(),
			)
		);

		if ( is_wp_error( $raw ) ) {
			$this->mark_down();
			return new Response( Response::FAILED, 0, null, null, 'network' );
		}

		$status = (int) wp_remote_retrieve_response_code( $raw );
		// 5xx / 429: the API is down or asks us to slow down. 401 / 403: the key was revoked or is wrong — hammering
		// feed-api with it on every page view would only get the site's IP penalty-boxed.
		if ( $status >= 500 || in_array( $status, array( 401, 403, 429 ), true ) ) {
			$this->mark_down();
		}
		$tag = wp_remote_retrieve_header( $raw, 'etag' );
		$tag = is_string( $tag ) && '' !== $tag ? $tag : null;

		if ( 304 === $status ) {
			return new Response( Response::NOT_MODIFIED, 304, null, $tag ?? $etag );
		}
		if ( 404 === $status ) {
			return new Response( Response::NOT_FOUND, 404 );
		}
		if ( 200 !== $status ) {
			return new Response( Response::FAILED, $status, null, null, 'http_' . $status );
		}

		$body = json_decode( (string) wp_remote_retrieve_body( $raw ), true );
		if ( ! is_array( $body ) ) {
			return new Response( Response::FAILED, $status, null, null, 'invalid_json' );
		}
		return new Response( Response::OK, 200, $body, $tag );
	}

	/**
	 * `POST` JSON to a website API path (lead intake). Never cached, never retried here: the `Idempotency-Key` lets the
	 * caller resend safely. The answer's error code (`error.code`) is kept in `error` for non-2xx statuses.
	 *
	 * @param string              $path            Path starting with `/v2/`.
	 * @param array<string,mixed> $body            JSON body.
	 * @param string              $idempotency_key `Idempotency-Key` header.
	 */
	public function post( string $path, array $body, string $idempotency_key ): Response {
		if ( '' === $this->base || '' === $this->api_key ) {
			return new Response( Response::FAILED, 0, null, null, 'not_configured' );
		}
		$raw = wp_remote_post(
			$this->base . $path,
			array(
				'timeout'             => $this->timeout,
				'redirection'         => 0,
				'reject_unsafe_urls'  => ! Settings::allow_local_api(),
				'limit_response_size' => 65536,
				'headers'             => array(
					'Accept'          => 'application/json',
					'Content-Type'    => 'application/json',
					'X-Api-Key'       => $this->api_key,
					'Idempotency-Key' => $idempotency_key,
					'User-Agent'      => 'Inmolink-WordPress/' . VERSION . '; ' . home_url( '/' ),
				),
				'body'                => (string) wp_json_encode( $body ),
			)
		);
		if ( is_wp_error( $raw ) ) {
			return new Response( Response::FAILED, 0, null, null, 'network' );
		}
		$status  = (int) wp_remote_retrieve_response_code( $raw );
		$decoded = json_decode( (string) wp_remote_retrieve_body( $raw ), true );
		$decoded = is_array( $decoded ) ? $decoded : null;
		if ( 200 === $status || 201 === $status ) {
			return null === $decoded ? new Response( Response::FAILED, $status, null, null, 'invalid_json' ) : new Response( Response::OK, $status, $decoded );
		}
		$code = isset( $decoded['error']['code'] ) && is_string( $decoded['error']['code'] ) ? $decoded['error']['code'] : 'http_' . $status;
		return new Response( 404 === $status ? Response::NOT_FOUND : Response::FAILED, $status, null, null, $code );
	}

	/**
	 * Remembers for {@see BACKOFF} seconds that the API is unreachable (or asked us to slow down).
	 */
	private function mark_down(): void {
		set_transient( self::DOWN_TRANSIENT, time(), self::BACKOFF );
	}

	/**
	 * Clears the back-off (settings saved, "test connection").
	 */
	public static function reset_backoff(): void {
		delete_transient( self::DOWN_TRANSIENT );
	}

	/**
	 * Whether calls are currently skipped because the API failed moments ago.
	 */
	public static function in_backoff(): bool {
		return false !== get_transient( self::DOWN_TRANSIENT );
	}

	/**
	 * The full URL for a path and query.
	 *
	 * @param string              $path  Path starting with `/v2/`.
	 * @param array<string,mixed> $query Query values.
	 */
	public function url( string $path, array $query = array() ): string {
		$pairs = array();
		ksort( $query );
		foreach ( $query as $name => $value ) {
			if ( null === $value || '' === $value || array() === $value ) {
				continue;
			}
			if ( is_array( $value ) ) {
				$value = implode( ',', array_map( 'strval', $value ) );
			} elseif ( is_bool( $value ) ) {
				$value = $value ? 'true' : 'false';
			}
			$pairs[] = rawurlencode( (string) $name ) . '=' . rawurlencode( (string) $value );
		}
		return $this->base . $path . ( array() === $pairs ? '' : '?' . implode( '&', $pairs ) );
	}
}
