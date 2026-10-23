<?php
/**
 * Address checks for the API host, applied to the addresses it actually resolves to.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\Net;

use Inmolink\Plugin\Settings;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * WordPress's `reject_unsafe_urls` blocks private IPv4 ranges but not link-local (169.254.0.0/16, where cloud
 * metadata lives), carrier-grade NAT (100.64.0.0/10) or any IPv6 range. This guard resolves the API host (A and AAAA),
 * refuses it when ANY address is in {@see Ip::NON_PUBLIC} (or carries such an IPv4 address), and pins the connection
 * to the addresses that were checked (`CURLOPT_RESOLVE`), so a DNS answer that changes between the check and the
 * connect (rebinding) cannot reach another address.
 *
 * Limits of the pin: it needs WordPress's cURL transport. Without it (the streams / fsockopen transport, where
 * WordPress has no hook to pin the address) a name is never called at all (S10-F6): {@see can_call()} says no, the
 * client answers from the cache only, and {@see pinned()} refuses the request and aborts any fsockopen connection
 * attempt. Through an HTTP proxy (`WP_PROXY_HOST`) the proxy resolves the name, and the plugin's check is then only a
 * sanity check. The health page says when pinning is off, see {@see pin_effective()} and {@see transport_pins()}.
 *
 * Resolved addresses are cached for {@see DNS_TTL} seconds per host, so a page view does not cost a DNS round trip;
 * the cached addresses are also the ones pinned, so the cache cannot be raced by rebinding.
 *
 * Off with `INMOLINK_ALLOW_LOCAL_API` (a development API on this machine).
 */
final class ApiGuard {

	/** Seconds a resolved host is remembered. */
	public const DNS_TTL = 60;

	/**
	 * Checks an API base (`https://host[:port]`) and returns the addresses to pin.
	 *
	 * @param string $base API base URL.
	 * @return array{ok:bool,host:string,port:int,ip:string,ips:list<string>,error:string}
	 */
	public static function check( string $base ): array {
		$parts = wp_parse_url( $base );
		$host  = is_array( $parts ) && isset( $parts['host'] ) ? strtolower( trim( $parts['host'], '[]' ) ) : '';
		$port  = is_array( $parts ) && isset( $parts['port'] ) ? (int) $parts['port'] : ( is_array( $parts ) && 'http' === ( $parts['scheme'] ?? '' ) ? 80 : 443 );
		$out   = array(
			'ok'    => false,
			'host'  => $host,
			'port'  => $port,
			'ip'    => '',
			'ips'   => array(),
			'error' => 'blocked_address',
		);
		if ( '' === $host ) {
			return $out;
		}
		if ( Settings::allow_local_api() ) {
			$out['ok']    = true;
			$out['error'] = '';
			return $out;
		}
		$literal   = Ip::valid( $host );
		$addresses = $literal ? array( $host ) : self::resolve( $host );
		if ( array() === $addresses ) {
			$out['error'] = 'unresolvable';
			return $out;
		}
		foreach ( $addresses as $address ) {
			if ( ! Ip::is_public( $address ) ) {
				return $out;
			}
		}
		$out['ok']    = true;
		$out['error'] = '';
		// A literal needs no pin; a name is pinned to every checked address.
		$out['ips'] = $literal ? array() : $addresses;
		$out['ip']  = $literal ? '' : $addresses[0];
		return $out;
	}

	/**
	 * Whether the connection pin takes effect: the cURL transport is used and no HTTP proxy is configured.
	 */
	public static function pin_effective(): bool {
		return self::transport_pins() && ! ( defined( 'WP_PROXY_HOST' ) && '' !== (string) WP_PROXY_HOST );
	}

	/**
	 * Whether the HTTP transport can pin an address (`CURLOPT_RESOLVE`): WordPress's cURL transport is available and
	 * not turned off with the `use_curl_transport` filter.
	 */
	public static function transport_pins(): bool {
		if ( ! defined( 'CURLOPT_RESOLVE' ) ) {
			return false;
		}
		$curl = class_exists( '\WpOrg\Requests\Transport\Curl' ) ? \WpOrg\Requests\Transport\Curl::test() : function_exists( 'curl_init' );
		return $curl && (bool) apply_filters( 'use_curl_transport', true, array() ); // phpcs:ignore WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- WordPress core hook.
	}

	/**
	 * Whether a checked API base may be called: an address literal or a local development API needs no pin; a name
	 * only when the transport pins it (no unpinned calls, S10-F6).
	 *
	 * @param array{ok:bool,host:string,port:int,ip:string,ips:list<string>,error:string} $checked Result of {@see check()}.
	 */
	public static function can_call( array $checked ): bool {
		return array() === $checked['ips'] || self::transport_pins();
	}

	/**
	 * Runs a request with the connection pinned to the checked addresses. Hooks `http_api_curl` for this request only.
	 * Never runs it unpinned: refused when the transport cannot pin ({@see can_call()}), and should WordPress still
	 * pick the fsockopen transport, its connection attempt is aborted before it connects.
	 *
	 * @param array{ok:bool,host:string,port:int,ip:string,ips:list<string>,error:string} $checked Result of {@see check()}.
	 * @param callable                                                                    $request Performs the request.
	 * @return mixed What the request returns, or a `WP_Error` (`inmolink_unpinned`) when it was not run.
	 */
	public static function pinned( array $checked, callable $request ) {
		if ( array() === $checked['ips'] ) {
			return $request();
		}
		if ( ! self::can_call( $checked ) ) {
			return new \WP_Error( 'inmolink_unpinned', 'The HTTP transport cannot pin the API address.' );
		}
		$list   = array_map( static fn ( string $ip ): string => str_contains( $ip, ':' ) ? '[' . $ip . ']' : $ip, $checked['ips'] );
		$pin    = static function ( $handle, $args, $url ) use ( $checked, $list ): void {
			$host = wp_parse_url( (string) $url, PHP_URL_HOST );
			if ( is_string( $host ) && strtolower( $host ) === $checked['host'] ) {
				curl_setopt( $handle, CURLOPT_RESOLVE, array( $checked['host'] . ':' . $checked['port'] . ':' . implode( ',', $list ) ) ); // phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_setopt
			}
		};
		$refuse = static function (): void {
			// WordPress turns a Requests exception into a WP_Error (`http_request_failed`); nothing was connected.
			throw new \WpOrg\Requests\Exception( 'The HTTP transport cannot pin the API address.', 'inmolink_unpinned' );
		};
		add_action( 'http_api_curl', $pin, 10, 3 );
		add_action( 'requests-fsockopen.before_request', $refuse ); // phpcs:ignore WordPress.NamingConventions.ValidHookName.UseUnderscores -- WordPress core hook (WP_HTTP_Requests_Hooks).
		try {
			return $request();
		} finally {
			remove_action( 'http_api_curl', $pin, 10 );
			remove_action( 'requests-fsockopen.before_request', $refuse );
		}
	}

	/**
	 * The IPv4 and IPv6 addresses a name resolves to, IPv4 first (empty when it does not resolve). The system resolver
	 * is the primary source (`gethostbynamel`, so /etc/hosts agrees with what the streams transport would connect to),
	 * plus the AAAA records. The answer is cached for {@see DNS_TTL} seconds. The `inmolink_resolve_host` filter may
	 * answer instead (tests, a custom resolver; not cached).
	 *
	 * @param string $host Host name.
	 * @return list<string>
	 */
	public static function resolve( string $host ): array {
		$pre = apply_filters( 'inmolink_resolve_host', null, $host );
		if ( is_array( $pre ) ) {
			return array_values( array_filter( $pre, 'is_string' ) );
		}
		$key    = 'inmolink_dns_' . md5( $host );
		$cached = get_transient( $key );
		if ( is_array( $cached ) && array() !== $cached ) {
			return array_values( array_filter( $cached, 'is_string' ) );
		}
		$found = array();
		$v4    = gethostbynamel( $host ); // Also reads numeric forms such as `2130706433` as the address they are.
		if ( is_array( $v4 ) ) {
			$found = $v4;
		}
		$dns = function_exists( 'dns_get_record' ) ? @dns_get_record( $host, DNS_AAAA ) : false; // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
		if ( is_array( $dns ) ) {
			foreach ( $dns as $record ) {
				if ( isset( $record['ipv6'] ) && is_string( $record['ipv6'] ) ) {
					$found[] = $record['ipv6'];
				}
			}
		}
		$found = array_values( array_unique( $found ) );
		if ( array() !== $found ) {
			set_transient( $key, $found, self::DNS_TTL );
		}
		return $found;
	}
}
