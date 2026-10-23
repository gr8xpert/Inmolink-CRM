<?php
/**
 * One website API answer.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\Api;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * The outcome of an API call, reduced to what the cache layer needs.
 */
final class Response {

	/** 200 with a JSON object body. */
	public const OK = 'ok';
	/** 304: the cached copy (sent as `If-None-Match`) is current. */
	public const NOT_MODIFIED = 'not_modified';
	/** 404: the resource is not (or no longer) on this site. */
	public const NOT_FOUND = 'not_found';
	/** Anything else — network error, timeout, 5xx, 429, 401/403, a body that is not JSON: serve stale. */
	public const FAILED = 'failed';

	/**
	 * Builds a response.
	 *
	 * @param string                   $kind   One of the constants.
	 * @param int                      $status HTTP status (0 when no answer arrived).
	 * @param array<string,mixed>|null $body   Decoded JSON body (OK only).
	 * @param string|null              $etag   The `ETag` header.
	 * @param string                   $error  Short machine-readable reason (FAILED only), never shown to visitors.
	 */
	public function __construct(
		public readonly string $kind,
		public readonly int $status = 0,
		public readonly ?array $body = null,
		public readonly ?string $etag = null,
		public readonly string $error = ''
	) {}

	/**
	 * Whether the call returned a fresh body.
	 */
	public function ok(): bool {
		return self::OK === $this->kind;
	}

	/**
	 * Whether the API could not answer usefully (the caller falls back to stale data).
	 */
	public function failed(): bool {
		return self::FAILED === $this->kind;
	}
}
