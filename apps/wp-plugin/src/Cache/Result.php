<?php
/**
 * A cached API body.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\Cache;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * A body from the cache or the API, with its age.
 */
final class Result {

	/**
	 * Builds a result.
	 *
	 * @param array<string,mixed> $body       The API body.
	 * @param int                 $fetched_at Unix time the API last confirmed it.
	 * @param bool                $stale      Served because the API could not be reached.
	 */
	public function __construct(
		public readonly array $body,
		public readonly int $fetched_at,
		public readonly bool $stale
	) {}
}
