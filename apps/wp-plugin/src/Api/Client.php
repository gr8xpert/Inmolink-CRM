<?php
/**
 * Server-side client for the Inmolink website API v2.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\Api;

use Inmolink\Plugin\Net\ApiGuard;
use Inmolink\Plugin\Net\Counter;
use Inmolink\Plugin\Net\Ip;
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
	/** Seconds no call is made after a network error, 5xx, 401, 403 or 429 (unless the API says how long: Retry-After). */
	public const BACKOFF = 60;
	/** Longest pause a `Retry-After` can ask for (a hostile or broken API cannot silence the site for days). */
	public const MAX_RETRY_AFTER = HOUR_IN_SECONDS;
	/** Back-off channels (S8-F13): page views and background sync fail and recover independently; the health probe has none. */
	public const PAGE  = 'page';
	public const SYNC  = 'sync';
	public const PROBE = 'probe';
	/** The page channel's back-off transient; the others append `_{channel}`. */
	public const DOWN_TRANSIENT = 'inmolink_api_down';
	/** The cached "API reachable" answer (S8-F28) and how long it is trusted. */
	public const PROBE_TRANSIENT = 'inmolink_api_probe';
	public const PROBE_INTERVAL  = MINUTE_IN_SECONDS;
	/** Uncached API calls one visitor IP may cause per window (S8-F23); more are answered from the stale cache. */
	public const CALL_LIMIT  = 30;
	public const CALL_WINDOW = MINUTE_IN_SECONDS;

	/**
	 * Creates a client.
	 *
	 * @param string $base    API base URL, e.g. `https://api.example.com` (no trailing slash).
	 * @param string $api_key The secret key.
	 * @param int    $timeout Seconds.
	 * @param string $channel Back-off channel ({@see PAGE}, {@see SYNC} or {@see PROBE}).
	 */
	public function __construct(
		private readonly string $base,
		private readonly string $api_key,
		private readonly int $timeout = self::PAGE_TIMEOUT,
		private readonly string $channel = self::PAGE
	) {}

	/**
	 * A client configured from the settings.
	 *
	 * @param int    $timeout Seconds.
	 * @param string $channel Back-off channel.
	 */
	public static function from_settings( int $timeout = self::PAGE_TIMEOUT, string $channel = self::PAGE ): self {
		return new self( (string) Settings::get( 'api_base' ), Settings::api_key(), $timeout, $channel );
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
		if ( self::PROBE !== $this->channel() && self::in_backoff( $this->channel() ) ) {
			// The API failed moments ago: do not make visitors wait for another timeout.
			return new Response( Response::FAILED, 0, null, null, 'backoff' );
		}
		if ( self::PROBE !== $this->channel() && $this->over_call_limit() ) {
			// One visitor IP is causing many uncached calls (a crawler walking filter combinations): serve stale.
			return new Response( Response::FAILED, 0, null, null, 'rate_limited' );
		}
		$checked = ApiGuard::check( $this->base );
		if ( ! $checked['ok'] ) {
			// A refused address stays refused for as long as DNS says so: back off. A name that merely does not resolve
			// (a DNS blip) is retried on the next call.
			if ( 'blocked_address' === $checked['error'] ) {
				$this->mark_down();
			}
			return new Response( Response::FAILED, 0, null, null, $checked['error'] );
		}
		if ( ! ApiGuard::can_call( $checked ) ) {
			// The transport cannot pin the API address (streams): no call at all, the cache answers (S10-F6).
			return new Response( Response::FAILED, 0, null, null, 'unpinned' );
		}

		$headers = array(
			'Accept'     => 'application/json',
			'X-Api-Key'  => $this->api_key,
			'User-Agent' => 'Inmolink-WordPress/' . VERSION . '; ' . home_url( '/' ),
		);
		if ( null !== $etag && '' !== $etag ) {
			$headers['If-None-Match'] = $etag;
		}

		$url = $this->url( $path, $query );
		$raw = ApiGuard::pinned(
			$checked,
			fn () => wp_remote_get(
				$url,
				array(
					'timeout'             => $this->timeout,
					'redirection'         => 0,
					'headers'             => $headers,
					'limit_response_size' => self::MAX_BODY,
					// Loopback / private targets are refused unless wp-config opts in (INMOLINK_ALLOW_LOCAL_API).
					'reject_unsafe_urls'  => ! Settings::allow_local_api(),
				)
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
			$this->mark_down( in_array( $status, array( 429, 503 ), true ) ? self::retry_after( wp_remote_retrieve_header( $raw, 'retry-after' ) ) : 0 );
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
		$checked = ApiGuard::check( $this->base );
		if ( ! $checked['ok'] ) {
			return new Response( Response::FAILED, 0, null, null, $checked['error'] );
		}
		if ( ! ApiGuard::can_call( $checked ) ) {
			return new Response( Response::FAILED, 0, null, null, 'unpinned' );
		}
		$raw = ApiGuard::pinned(
			$checked,
			fn () => wp_remote_post(
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
	 * Counts this call against the visitor's IP and says whether the IP is over {@see CALL_LIMIT} in {@see CALL_WINDOW}.
	 * Background work (WP-CLI, cron) has no visitor and is never limited. The `inmolink_api_caller_ip` filter sets the
	 * IP (tests, custom setups).
	 */
	private function over_call_limit(): bool {
		$ip = ( 'cli' === PHP_SAPI || wp_doing_cron() ) ? '' : Ip::client();
		$ip = apply_filters( 'inmolink_api_caller_ip', $ip );
		if ( ! is_string( $ip ) || '' === $ip ) {
			return false;
		}
		// Counted per IPv4 address / IPv6 /64, in bounded storage (see Counter).
		if ( Counter::count( 'api', $ip ) >= self::CALL_LIMIT ) {
			return true;
		}
		Counter::hit( 'api', $ip, self::CALL_WINDOW );
		return false;
	}

	/**
	 * This client's back-off channel.
	 */
	private function channel(): string {
		return in_array( $this->channel, array( self::PAGE, self::SYNC, self::PROBE ), true ) ? $this->channel : self::PAGE;
	}

	/**
	 * Remembers that the API is unreachable (or asked us to slow down) for this client's channel only: for
	 * {@see BACKOFF} seconds, or for the API's `Retry-After` when it gave one.
	 *
	 * @param int $seconds Pause asked for by the API, 0 for the default.
	 */
	private function mark_down( int $seconds = 0 ): void {
		if ( self::PROBE === $this->channel() ) {
			return; // The probe's own cached answer is its back-off.
		}
		// The value tells a pause the API asked for from our own default back-off.
		set_transient( self::down_key( $this->channel() ), $seconds > 0 ? 'retry_after' : 'down', $seconds > 0 ? $seconds : self::BACKOFF );
	}

	/**
	 * A `Retry-After` header as seconds (delta-seconds or an HTTP date), clamped to 1..{@see MAX_RETRY_AFTER};
	 * 0 when absent or unusable.
	 *
	 * @param mixed $header Header value.
	 */
	public static function retry_after( $header ): int {
		if ( is_array( $header ) ) {
			$header = reset( $header );
		}
		if ( ! is_string( $header ) || '' === trim( $header ) ) {
			return 0;
		}
		$header = trim( $header );
		if ( ctype_digit( $header ) ) {
			$seconds = (int) $header;
		} else {
			// Strict HTTP-date (RFC 7231 IMF-fixdate, e.g. `Wed, 21 Oct 2026 07:28:00 GMT`); anything else is ignored.
			$date    = 1 === preg_match( '/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/', $header ) ? date_create_immutable_from_format( 'D, d M Y H:i:s \G\M\T', $header, new \DateTimeZone( 'UTC' ) ) : false;
			$seconds = false === $date ? 0 : $date->getTimestamp() - time();
		}
		return $seconds <= 0 ? 0 : min( self::MAX_RETRY_AFTER, $seconds );
	}

	/**
	 * The back-off transient name of a channel.
	 *
	 * @param string $channel Channel.
	 */
	private static function down_key( string $channel ): string {
		return self::PAGE === $channel ? self::DOWN_TRANSIENT : self::DOWN_TRANSIENT . '_' . $channel;
	}

	/**
	 * Clears every back-off and the cached probe (settings saved, "test connection", "sync now").
	 */
	public static function reset_backoff(): void {
		foreach ( array( self::PAGE, self::SYNC ) as $channel ) {
			delete_transient( self::down_key( $channel ) );
		}
		delete_transient( self::PROBE_TRANSIENT );
	}

	/**
	 * Whether calls of a channel are currently skipped because the API failed (or asked for a pause) moments ago.
	 *
	 * @param string $channel Channel ({@see PAGE} or {@see SYNC}).
	 */
	public static function in_backoff( string $channel = self::PAGE ): bool {
		return false !== get_transient( self::down_key( $channel ) );
	}

	/**
	 * Whether the API asked for a pause (Retry-After) that is still running on any channel.
	 */
	public static function paused_by_api(): bool {
		return 'retry_after' === get_transient( self::down_key( self::PAGE ) ) || 'retry_after' === get_transient( self::down_key( self::SYNC ) );
	}

	/**
	 * Whether the API answers right now: one cheap call (the change feed, one item), remembered for
	 * {@see PROBE_INTERVAL} so the health page never calls on every view and still follows a change within one interval.
	 * Not configured is unreachable without a call.
	 */
	public static function reachable(): bool {
		if ( ! Settings::is_configured() ) {
			return false;
		}
		$cached = get_transient( self::PROBE_TRANSIENT );
		if ( is_array( $cached ) && isset( $cached['ok'] ) ) {
			return true === $cached['ok'];
		}
		if ( self::paused_by_api() ) {
			return false; // The API asked for quiet: no probe call, and no cached answer to prefer.
		}
		$client   = new self( (string) Settings::get( 'api_base' ), Settings::api_key(), self::PAGE_TIMEOUT, self::PROBE );
		$response = $client->get(
			'/v2/changes',
			array(
				'since' => gmdate( 'Y-m-d\TH:i:s\Z' ),
				'limit' => 1,
			)
		);
		$ok       = $response->ok();
		set_transient( self::PROBE_TRANSIENT, array( 'ok' => $ok ), self::PROBE_INTERVAL );
		return $ok;
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
