<?php
/**
 * IP address helpers: CIDR matching, non-public ranges, the visitor's IP behind trusted proxies.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\Net;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Pure address logic (no I/O except reading `$_SERVER` in {@see client()}).
 */
final class Ip {

	/**
	 * Ranges an API host may never be in (S8-F23): "this" network, private (RFC 1918), carrier-grade NAT (RFC 6598),
	 * loopback, link-local (cloud metadata lives at 169.254.169.254), IETF protocol / benchmarking blocks, multicast and
	 * reserved space; and for IPv6 the unspecified, loopback, unique-local (fc00::/7), link-local (fe80::/10) and
	 * multicast ranges, discard-only (100::/64), Teredo (2001::/32), documentation (2001:db8::/32) and the
	 * IPv4-translated range. IPv6 forms that carry an IPv4 address (mapped ::ffff:0:0/96, compatible ::/96, NAT64
	 * 64:ff9b::/96 and 64:ff9b:1::/48, 6to4 2002::/16) are judged by the IPv4 address inside them as well, see
	 * {@see embedded_v4()}.
	 */
	public const NON_PUBLIC = array(
		'0.0.0.0/8',
		'10.0.0.0/8',
		'100.64.0.0/10',
		'127.0.0.0/8',
		'169.254.0.0/16',
		'172.16.0.0/12',
		'192.0.0.0/24',
		'192.168.0.0/16',
		'198.18.0.0/15',
		'224.0.0.0/4',
		'240.0.0.0/4',
		'::/128',
		'::1/128',
		'fc00::/7',
		'fe80::/10',
		'ff00::/8',
		'100::/64',
		'2001::/32',
		'2001:db8::/32',
		'::ffff:0:0:0/96',
	);

	/**
	 * Proxy headers a client can append to; never accepted as the single "trusted header" without CIDRs.
	 */
	private const FORWARDING_HEADERS = array( 'HTTP_X_FORWARDED_FOR', 'HTTP_FORWARDED', 'HTTP_X_FORWARDED' );

	/**
	 * Whether a string is an IPv4 or IPv6 address.
	 *
	 * @param string $ip Candidate.
	 */
	public static function valid( string $ip ): bool {
		return false !== filter_var( $ip, FILTER_VALIDATE_IP );
	}

	/**
	 * Whether the value is `ip` or `ip/bits` with the bits in range.
	 *
	 * @param string $cidr Candidate.
	 */
	public static function valid_cidr( string $cidr ): bool {
		$parts = explode( '/', $cidr, 2 );
		if ( ! self::valid( $parts[0] ) ) {
			return false;
		}
		if ( ! isset( $parts[1] ) ) {
			return true;
		}
		$max = str_contains( $parts[0], ':' ) ? 128 : 32;
		return 1 === preg_match( '/^\d{1,3}\z/', $parts[1] ) && (int) $parts[1] <= $max;
	}

	/**
	 * Whether an IP is inside a CIDR range (a bare address is a /32 or /128). An IPv4-mapped IPv6 address
	 * (`::ffff:10.0.0.1`, as dual-stack servers report IPv4 clients) is compared as IPv4, on both sides.
	 *
	 * @param string $ip   IP.
	 * @param string $cidr Range.
	 */
	public static function in_cidr( string $ip, string $cidr ): bool {
		if ( ! self::valid_cidr( $cidr ) ) {
			return false;
		}
		$parts = explode( '/', $cidr, 2 );
		$addr  = self::pack( $ip );
		$net   = self::pack( $parts[0] );
		if ( null === $addr || null === $net ) {
			return false;
		}
		$bits    = isset( $parts[1] ) ? (int) $parts[1] : strlen( $net ) * 8;
		$addr_v4 = self::mapped_v4( $addr );
		$net_v4  = self::mapped_v4( $net );
		if ( 4 === strlen( $net ) && null !== $addr_v4 ) {
			$addr = $addr_v4;
		} elseif ( null !== $net_v4 && $bits >= 96 && ( 4 === strlen( $addr ) || null !== $addr_v4 ) ) {
			$addr  = $addr_v4 ?? $addr;
			$net   = $net_v4;
			$bits -= 96;
		}
		if ( strlen( $addr ) !== strlen( $net ) ) {
			return false;
		}
		$whole = intdiv( $bits, 8 );
		if ( $whole > 0 && substr( $addr, 0, $whole ) !== substr( $net, 0, $whole ) ) {
			return false;
		}
		$rest = $bits % 8;
		if ( 0 === $rest ) {
			return true;
		}
		$mask = ( 0xFF << ( 8 - $rest ) ) & 0xFF;
		return ( ord( $addr[ $whole ] ) & $mask ) === ( ord( $net[ $whole ] ) & $mask );
	}

	/**
	 * Whether an IP is inside any of the ranges.
	 *
	 * @param string            $ip     IP.
	 * @param array<int,string> $ranges CIDRs.
	 */
	public static function in_any( string $ip, array $ranges ): bool {
		foreach ( $ranges as $range ) {
			if ( self::in_cidr( $ip, $range ) ) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Whether an address is routable on the public internet: not in {@see NON_PUBLIC}, and the IPv4 address it carries
	 * (if any, see {@see embedded_v4()}) is not either.
	 *
	 * @param string $ip IP (a bracketed IPv6 host is accepted).
	 */
	public static function is_public( string $ip ): bool {
		$ip = trim( $ip, '[]' );
		if ( ! self::valid( $ip ) || self::in_any( $ip, self::NON_PUBLIC ) ) {
			return false;
		}
		$inner = self::embedded_v4( $ip );
		return null === $inner || ! self::in_any( $inner, self::NON_PUBLIC );
	}

	/**
	 * The IPv4 address an IPv6 address carries, for the forms that embed one: mapped (::ffff:0:0/96), compatible
	 * (::/96), NAT64 (64:ff9b::/96 and the local-use 64:ff9b:1::/48, RFC 6052) and 6to4 (2002::/16). Null for any other
	 * address.
	 *
	 * @param string $ip IP.
	 */
	public static function embedded_v4( string $ip ): ?string {
		$p = self::pack( $ip );
		if ( null === $p || 16 !== strlen( $p ) ) {
			return null;
		}
		$head = substr( $p, 0, 12 );
		if ( str_repeat( "\0", 12 ) === $head || str_repeat( "\0", 10 ) . "\xff\xff" === $head || "\x00\x64\xff\x9b" . str_repeat( "\0", 8 ) === $head ) {
			return (string) inet_ntop( substr( $p, 12 ) );
		}
		if ( "\x00\x64\xff\x9b\x00\x01" === substr( $p, 0, 6 ) ) {
			// RFC 6052 /48: the address sits in bytes 6, 7, 9 and 10 (byte 8 is reserved).
			return (string) inet_ntop( $p[6] . $p[7] . $p[9] . $p[10] );
		}
		if ( "\x20\x02" === substr( $p, 0, 2 ) ) {
			return (string) inet_ntop( substr( $p, 2, 4 ) );
		}
		return null;
	}

	/**
	 * The canonical text of an address: IPv6 compressed and lower case, an IPv4-mapped one as plain IPv4. '' when not
	 * an address.
	 *
	 * @param string $ip IP.
	 */
	public static function canonical( string $ip ): string {
		$p = self::pack( trim( $ip, '[]' ) );
		if ( null === $p ) {
			return '';
		}
		return (string) inet_ntop( self::mapped_v4( $p ) ?? $p );
	}

	/**
	 * The identity an IP is rate-limited by: the canonical IPv4 address, or the /64 network of an IPv6 address (one
	 * subscriber holds a whole /64 and can rotate within it at will). '' when not an address.
	 *
	 * @param string $ip IP.
	 */
	public static function bucket( string $ip ): string {
		$p = self::pack( trim( $ip, '[]' ) );
		if ( null === $p ) {
			return '';
		}
		$p = self::mapped_v4( $p ) ?? $p;
		return 4 === strlen( $p ) ? (string) inet_ntop( $p ) : bin2hex( substr( $p, 0, 8 ) ) . '/64';
	}

	/**
	 * The trusted proxy ranges: `INMOLINK_TRUSTED_PROXIES` in wp-config.php (an array, or a comma / space separated
	 * string, of CIDRs or addresses; invalid entries are dropped). Only wp-config can set it: the settings page cannot.
	 *
	 * @return list<string>
	 */
	public static function trusted_proxies(): array {
		$raw = defined( 'INMOLINK_TRUSTED_PROXIES' ) ? INMOLINK_TRUSTED_PROXIES : array();
		$raw = apply_filters( 'inmolink_trusted_proxies', $raw );
		if ( is_string( $raw ) ) {
			$raw = preg_split( '/[\s,]+/', $raw, -1, PREG_SPLIT_NO_EMPTY );
		}
		if ( ! is_array( $raw ) ) {
			return array();
		}
		$out = array();
		foreach ( $raw as $entry ) {
			if ( is_string( $entry ) && self::valid_cidr( trim( $entry ) ) ) {
				$out[] = trim( $entry );
			}
		}
		return $out;
	}

	/**
	 * The `$_SERVER` key of the proxy's client-IP header (`INMOLINK_TRUSTED_PROXY_HEADER`, e.g. `HTTP_CF_CONNECTING_IP`),
	 * or null when none is named.
	 */
	public static function trusted_header(): ?string {
		$name = defined( 'INMOLINK_TRUSTED_PROXY_HEADER' ) ? INMOLINK_TRUSTED_PROXY_HEADER : null;
		$name = apply_filters( 'inmolink_trusted_proxy_header', $name );
		return is_string( $name ) && 1 === preg_match( '/^HTTP_[A-Z0-9_]{1,60}\z/', $name ) ? $name : null;
	}

	/**
	 * The visitor's IP in canonical form ('' when unknown).
	 *
	 * - Nothing configured: `REMOTE_ADDR`. Proxy headers are forgeable, so none is read by default.
	 * - `INMOLINK_TRUSTED_PROXIES` (CIDRs): the header (`INMOLINK_TRUSTED_PROXY_HEADER`, default `HTTP_X_FORWARDED_FOR`)
	 *   is read only when `REMOTE_ADDR` is one of those proxies; the list is then walked from the right, skipping
	 *   trusted proxies, and the first other address is the visitor (so a client cannot prepend a fake address).
	 * - Only `INMOLINK_TRUSTED_PROXY_HEADER` (the pre-S8-F29 setting, kept for sites that already set it): the header's
	 *   RIGHTMOST value (a proxy appends; the left side is client-controlled). Appendable forwarding headers
	 *   (`X-Forwarded-For`, `Forwarded`) are ignored in this mode, because without proxy ranges nothing says which hops
	 *   are the site's own; set `INMOLINK_TRUSTED_PROXIES` for them. A missing or invalid value falls back to
	 *   `REMOTE_ADDR`.
	 */
	public static function client(): string {
		$remote = self::canonical( trim( self::server_value( 'REMOTE_ADDR' ) ) );
		$ranges = self::trusted_proxies();
		$header = self::trusted_header();
		if ( array() === $ranges ) {
			if ( null === $header || in_array( $header, self::FORWARDING_HEADERS, true ) ) {
				return $remote;
			}
			$values = array_map( 'trim', explode( ',', self::server_value( $header ) ) );
			$last   = self::canonical( (string) end( $values ) );
			return '' !== $last ? $last : $remote;
		}
		if ( '' === $remote || ! self::in_any( $remote, $ranges ) ) {
			return $remote;
		}
		$chain = array_reverse( array_map( 'trim', explode( ',', self::server_value( $header ?? 'HTTP_X_FORWARDED_FOR' ) ) ) );
		foreach ( $chain as $hop ) {
			$hop = self::canonical( $hop );
			if ( '' === $hop ) {
				return $remote;
			}
			if ( ! self::in_any( $hop, $ranges ) ) {
				return $hop;
			}
		}
		return $remote;
	}

	/**
	 * A `$_SERVER` value as a string ('' when missing).
	 *
	 * @param string $name Key.
	 */
	private static function server_value( string $name ): string {
		return isset( $_SERVER[ $name ] ) && is_string( $_SERVER[ $name ] ) ? sanitize_text_field( wp_unslash( $_SERVER[ $name ] ) ) : '';
	}

	/**
	 * The 4 bytes of an IPv4-mapped IPv6 address (::ffff:a.b.c.d), else null.
	 *
	 * @param string $packed Packed address.
	 */
	private static function mapped_v4( string $packed ): ?string {
		return 16 === strlen( $packed ) && str_repeat( "\0", 10 ) . "\xff\xff" === substr( $packed, 0, 12 ) ? substr( $packed, 12 ) : null;
	}

	/**
	 * The packed form of an address (4 or 16 bytes), or null.
	 *
	 * @param string $ip IP.
	 */
	private static function pack( string $ip ): ?string {
		$packed = self::valid( $ip ) ? inet_pton( $ip ) : false;
		return false === $packed ? null : $packed;
	}
}
