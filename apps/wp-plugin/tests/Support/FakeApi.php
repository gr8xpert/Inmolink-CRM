<?php
/**
 * A fake website API behind `pre_http_request`.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\Tests;

/**
 * Answers the plugin's `wp_remote_get` calls from fixtures (tests/fixtures, kept in the v2 contract shapes by
 * tests/workspace/wp-plugin-fixtures.test.ts). Sends a strong ETag per body and answers `If-None-Match` with 304,
 * like feed-api. `down()` makes every call fail like an unreachable host.
 */
final class FakeApi {

	public const BASE = 'https://api.inmolink.test';

	/**
	 * Requests seen: path, query, headers.
	 *
	 * @var list<array{path:string,query:array<string,string>,headers:array<string,string>}>
	 */
	public array $requests = array();

	/**
	 * Routes by path: a response spec, or a callable returning one.
	 *
	 * @var array<string,array<string,mixed>|callable>
	 */
	private array $routes = array();

	/**
	 * Whether every call fails at the network level.
	 *
	 * @var bool
	 */
	private bool $down = false;

	/**
	 * Hooks the fake in.
	 */
	public function install(): void {
		add_filter( 'pre_http_request', array( $this, 'handle' ), 10, 3 );
	}

	/**
	 * Unhooks the fake.
	 */
	public function uninstall(): void {
		remove_filter( 'pre_http_request', array( $this, 'handle' ), 10 );
	}

	/**
	 * Sets the answer for a path.
	 *
	 * @param string                        $path  Path, e.g. `/v2/listings/INM-1001`.
	 * @param array<string,mixed>|callable  $spec  `['fixture' => 'x.json']`, `['status' => 500]`, or
	 *                                             `fn (array $query, array $headers): array` returning a spec.
	 */
	public function on( string $path, $spec ): void {
		$this->routes[ $path ] = $spec;
	}

	/**
	 * Takes the API down (or brings it back).
	 *
	 * @param bool $down Down.
	 */
	public function down( bool $down = true ): void {
		$this->down = $down;
	}

	/**
	 * Requests to one path.
	 *
	 * @param string $path Path.
	 * @return list<array{path:string,query:array<string,string>,headers:array<string,string>}>
	 */
	public function requests_to( string $path ): array {
		return array_values( array_filter( $this->requests, static fn ( array $r ): bool => $r['path'] === $path ) );
	}

	/**
	 * The `pre_http_request` filter.
	 *
	 * @param mixed               $pre  Short-circuit value.
	 * @param array<string,mixed> $args Request arguments.
	 * @param string              $url  URL.
	 * @return mixed
	 */
	public function handle( $pre, $args, $url ) {
		if ( 0 !== strpos( $url, self::BASE ) ) {
			return $pre;
		}
		$parts = wp_parse_url( $url );
		$query = array();
		parse_str( $parts['query'] ?? '', $query );
		$path    = (string) $parts['path'];
		$headers = array_change_key_case( (array) ( $args['headers'] ?? array() ), CASE_LOWER );

		$this->requests[] = array(
			'path'    => $path,
			'query'   => $query,
			'headers' => $headers,
		);

		if ( $this->down ) {
			return new \WP_Error( 'http_request_failed', 'cURL error 7: Failed to connect to api.inmolink.test port 443' );
		}

		$spec = $this->routes[ $path ] ?? array(
			'status' => 404,
			'body'   => array(
				'code'    => 'NOT_FOUND',
				'message' => 'Not found',
			),
		);
		if ( is_callable( $spec ) ) {
			$spec = $spec( $query, $headers );
		}
		if ( $spec instanceof \WP_Error ) {
			return $spec;
		}

		$status = (int) ( $spec['status'] ?? 200 );
		if ( isset( $spec['fixture'] ) ) {
			$body = (string) file_get_contents( dirname( __DIR__ ) . '/fixtures/' . $spec['fixture'] );
		} else {
			$body = (string) wp_json_encode( $spec['body'] ?? array() );
		}
		$etag = 200 === $status ? '"' . sha1( $body ) . '"' : null;

		if ( null !== $etag && isset( $headers['if-none-match'] ) && $headers['if-none-match'] === $etag ) {
			return self::response( 304, '', $etag );
		}
		return self::response( $status, $body, $etag );
	}

	/**
	 * A `wp_remote_*` response array.
	 *
	 * @param int         $status Status.
	 * @param string      $body   Body.
	 * @param string|null $etag   ETag.
	 * @return array<string,mixed>
	 */
	private static function response( int $status, string $body, ?string $etag ): array {
		$headers = array( 'content-type' => 'application/json' );
		if ( null !== $etag ) {
			$headers['etag'] = $etag;
		}
		return array(
			'headers'  => $headers,
			'body'     => $body,
			'response' => array(
				'code'    => $status,
				'message' => get_status_header_desc( $status ),
			),
			'cookies'  => array(),
			'filename' => null,
		);
	}
}
