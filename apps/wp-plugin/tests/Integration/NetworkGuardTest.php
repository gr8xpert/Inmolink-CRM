<?php
/**
 * S8-F23 / S8-F29: API host address checks, per-IP call limit, trusted proxies.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\Tests\Integration;

use Inmolink\Plugin\Api\Client;
use Inmolink\Plugin\Forms\LeadForm;
use Inmolink\Plugin\Net\ApiGuard;
use Inmolink\Plugin\Net\Counter;
use Inmolink\Plugin\Net\Ip;
use Inmolink\Plugin\Settings;
use Inmolink\Plugin\Tests\FakeApi;
use Inmolink\Plugin\Tests\TestCase;

/**
 * Network-level guards of the plugin.
 */
final class NetworkGuardTest extends TestCase {

	/**
	 * Restores `$_SERVER`.
	 */
	public function tear_down(): void {
		unset( $_SERVER['REMOTE_ADDR'], $_SERVER['HTTP_X_FORWARDED_FOR'], $_SERVER['HTTP_CF_CONNECTING_IP'] );
		parent::tear_down();
	}

	/**
	 * Addresses by name for the resolver filter.
	 *
	 * @param array<string,list<string>> $map Host => addresses.
	 */
	private function dns( array $map ): void {
		add_filter( 'inmolink_resolve_host', static fn ( $pre, $host ) => $map[ $host ] ?? $pre, 1, 2 );
	}

	/**
	 * [S8-F23] The non-public ranges, including the ones WordPress does not block.
	 */
	public function test_s8_f23_non_public_ranges(): void {
		foreach ( array( '169.254.169.254', '169.254.0.1', '100.64.0.1', '100.127.255.254', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', '::1', '::', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '127.0.0.1', '0.0.0.0', '::ffff:169.254.169.254', '::ffff:10.0.0.1', '64:ff9b::a9fe:a9fe', '64:ff9b::a00:1', '64:ff9b:1:a9fe:a9:fe00::', '2002:a9fe:a9fe::1', '2002:a00:1::1', '::a00:1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '100::1', '2001:db8::1', '::ffff:0:1:2' ) as $ip ) {
			$this->assertFalse( Ip::is_public( $ip ), $ip );
		}
		foreach ( array( '93.184.216.34', '8.8.8.8', '100.63.255.255', '100.128.0.1', '169.253.0.1', '172.32.0.1', '2606:4700::1111', '2001:4860:4860::8888', 'fbff::1', 'fec0::1', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1' ) as $ip ) {
			$this->assertTrue( Ip::is_public( $ip ), $ip );
		}
	}

	/**
	 * [S8-F23] A base resolving to link-local, carrier-grade NAT or unique-local space is refused, with no request made
	 * (one bad address among good ones is enough); a public one goes through.
	 */
	public function test_s8_f23_resolved_addresses_are_checked(): void {
		$this->dns(
			array(
				'meta.attacker.example'  => array( '169.254.169.254' ),
				'cgnat.attacker.example' => array( '100.64.0.9' ),
				'ula.attacker.example'   => array( 'fd00::5' ),
				'll.attacker.example'    => array( 'fe80::1' ),
				'nat64.attacker.example' => array( '64:ff9b::a9fe:a9fe' ),
				'6to4.attacker.example'  => array( '2002:a9fe:a9fe::1' ),
				'mixed.attacker.example' => array( '93.184.216.34', '169.254.169.254' ),
				'public.example'         => array( '93.184.216.34', '2606:4700::1111' ),
				'gone.example'           => array(),
			)
		);
		$requests = 0;
		add_filter(
			'pre_http_request',
			static function ( $pre ) use ( &$requests ) {
				++$requests;
				return $pre;
			},
			1
		);
		foreach ( array( 'meta', 'cgnat', 'ula', 'll', 'mixed', 'nat64', '6to4' ) as $name ) {
			$client = new Client( 'https://' . $name . '.attacker.example', self::KEY );
			$this->assertSame( 'blocked_address', $client->get( '/v2/listings' )->error, $name . ' (GET)' );
			Client::reset_backoff();
			$this->assertSame( 'blocked_address', $client->post( '/v2/leads', array(), 'wp-key' )->error, $name . ' (POST)' );
		}
		$this->assertSame( 'unresolvable', ( new Client( 'https://gone.example', self::KEY ) )->get( '/v2/listings' )->error );
		$this->assertFalse( Client::in_backoff(), 'a name that does not resolve is retried, not backed off for a minute' );
		$this->assertSame( 0, $requests, 'no request leaves for a refused host' );

		$this->assertTrue( ApiGuard::check( 'https://public.example' )['ok'] );
		$this->assertSame( '93.184.216.34', ApiGuard::check( 'https://public.example' )['ip'], 'IPv4 first' );
		$this->assertSame( array( '93.184.216.34', '2606:4700::1111' ), ApiGuard::check( 'https://public.example' )['ips'], 'every checked address is pinned' );
		$this->assertTrue( ApiGuard::check( 'https://public.example:8443' )['ok'] );
		$this->assertSame( 8443, ApiGuard::check( 'https://public.example:8443' )['port'] );
		$this->assertFalse( ApiGuard::check( 'https://[fd00::1]' )['ok'], 'a literal is checked too' );
	}

	/**
	 * [S8-F23] The connection is pinned to the checked address for the request only (no DNS rebinding between the check
	 * and the connect): the cURL hook sets `CURLOPT_RESOLVE` and is removed afterwards.
	 */
	public function test_s8_f23_connection_is_pinned_for_the_request_only(): void {
		$this->dns( array( 'public.example' => array( '93.184.216.34' ) ) );
		$checked = ApiGuard::check( 'https://public.example' );
		$this->assertFalse( has_action( 'http_api_curl' ) );
		$seen = null;
		ApiGuard::pinned(
			$checked,
			function () use ( &$seen ) {
				$seen = has_action( 'http_api_curl' );
				return null;
			}
		);
		$this->assertNotFalse( $seen, 'hooked while the request runs' );
		$this->assertFalse( has_action( 'http_api_curl' ), 'unhooked afterwards' );

		$set = array();
		ApiGuard::pinned(
			$checked,
			static function () use ( &$set ) {
				$handle = curl_init(); // phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_init
				do_action( 'http_api_curl', $handle, array(), 'https://public.example/v2/listings' );
				do_action( 'http_api_curl', $handle, array(), 'https://other.example/' );
				$set[] = true;
				return null;
			}
		);
		$this->assertSame( array( true ), $set );
	}

	/**
	 * [S8-F23] The settings page refuses address literals in those ranges and numeric host spellings.
	 */
	public function test_s8_f23_base_url_literals(): void {
		foreach ( array( 'https://169.254.169.254', 'https://100.64.0.1', 'https://[fd00::1]', 'https://[fe80::1]', 'https://10.0.0.5', 'https://[::ffff:169.254.169.254]', 'https://2130706433', 'https://0x7f.1', 'https://017700000001' ) as $bad ) {
			$this->assertSame( '', Settings::sanitize_base( $bad ), $bad );
		}
		$this->assertSame( 'https://93.184.216.34', Settings::sanitize_base( 'https://93.184.216.34' ) );
		$this->assertSame( 'https://[2606:4700::1111]', Settings::sanitize_base( 'https://[2606:4700::1111]' ) );
		$this->assertSame( 'https://10.0.0.5', Settings::sanitize_base_for( 'https://10.0.0.5', true ), 'the wp-config opt-in still allows a local API' );
	}

	/**
	 * [S8-F23] One visitor IP can cause only CALL_LIMIT uncached API calls per window; the rest see the stale cache.
	 */
	public function test_s8_f23_uncached_calls_are_limited_per_ip(): void {
		$ip = '203.0.113.77';
		add_filter(
			'inmolink_api_caller_ip',
			function () use ( &$ip ) {
				return $ip;
			}
		);
		$this->api->on( '/v2/listings', array( 'fixture' => 'listings.search.json' ) );
		$client = new Client( FakeApi::BASE, self::KEY );
		for ( $i = 0; $i < Client::CALL_LIMIT; $i++ ) {
			$this->assertTrue( $client->get( '/v2/listings', array( 'page' => $i ) )->ok(), 'call ' . $i );
		}
		$calls = count( $this->api->requests_to( '/v2/listings' ) );
		$cut   = $client->get( '/v2/listings', array( 'page' => 99 ) );
		$this->assertSame( 'rate_limited', $cut->error );
		$this->assertSame( $calls, count( $this->api->requests_to( '/v2/listings' ) ), 'no call reaches the API' );
		$this->assertFalse( Client::in_backoff(), 'a busy visitor does not put the whole site into back-off' );

		$ip = '203.0.113.78';
		$this->assertTrue( $client->get( '/v2/listings', array( 'page' => 1 ) )->ok(), 'another IP is unaffected' );
	}

	/**
	 * [S8-F29] Nothing configured: REMOTE_ADDR only; forged headers are ignored.
	 */
	public function test_s8_f29_default_ignores_proxy_headers(): void {
		$_SERVER['REMOTE_ADDR']          = '198.51.100.5';
		$_SERVER['HTTP_X_FORWARDED_FOR'] = '1.2.3.4';
		$this->assertSame( '198.51.100.5', LeadForm::remote_ip() );
	}

	/**
	 * [S8-F29] With trusted proxy CIDRs the header is read only from those proxies, from the right: a client cannot
	 * prepend a fake address; a request that did not come through a proxy keeps its own address.
	 */
	public function test_s8_f29_trusted_proxy_cidrs(): void {
		add_filter( 'inmolink_trusted_proxies', static fn () => '10.0.0.0/8, 2001:db8::/32, bogus, 300.1.1.1/8' );
		$this->assertSame( array( '10.0.0.0/8', '2001:db8::/32' ), Ip::trusted_proxies(), 'invalid entries dropped' );

		$_SERVER['REMOTE_ADDR']          = '10.2.3.4';
		$_SERVER['HTTP_X_FORWARDED_FOR'] = '6.6.6.6, 198.51.100.9, 10.9.9.9';
		$this->assertSame( '198.51.100.9', LeadForm::remote_ip(), 'first address from the right that is not a proxy' );

		$_SERVER['HTTP_X_FORWARDED_FOR'] = '198.51.100.9';
		$this->assertSame( '198.51.100.9', LeadForm::remote_ip() );

		$_SERVER['REMOTE_ADDR']          = '203.0.113.50';
		$_SERVER['HTTP_X_FORWARDED_FOR'] = '1.2.3.4';
		$this->assertSame( '203.0.113.50', LeadForm::remote_ip(), 'not from a trusted proxy: the header is forged' );

		$_SERVER['REMOTE_ADDR']          = '2001:db8::7';
		$_SERVER['HTTP_X_FORWARDED_FOR'] = 'not-an-ip';
		$this->assertSame( '2001:db8::7', LeadForm::remote_ip(), 'garbage falls back to the connection' );

		add_filter( 'inmolink_trusted_proxy_header', static fn () => 'HTTP_CF_CONNECTING_IP' );
		$_SERVER['REMOTE_ADDR']            = '10.2.3.4';
		$_SERVER['HTTP_CF_CONNECTING_IP'] = '198.51.100.77';
		$this->assertSame( '198.51.100.77', LeadForm::remote_ip(), 'the named header, still only behind a trusted proxy' );
	}

	/**
	 * [S8-F29] The single-header setting keeps working (backward compatible), falling back to the connection.
	 */
	public function test_s8_f29_header_only_setting_still_works(): void {
		add_filter( 'inmolink_trusted_proxy_header', static fn () => 'HTTP_CF_CONNECTING_IP' );
		$_SERVER['REMOTE_ADDR']            = '198.51.100.5';
		$_SERVER['HTTP_CF_CONNECTING_IP'] = '203.0.113.5';
		$this->assertSame( '203.0.113.5', LeadForm::remote_ip() );
		unset( $_SERVER['HTTP_CF_CONNECTING_IP'] );
		$this->assertSame( '198.51.100.5', LeadForm::remote_ip() );
	}

	/**
	 * Ranges and CIDR matching.
	 */
	public function test_s8_f29_cidr_matching(): void {
		$this->assertTrue( Ip::in_cidr( '10.255.0.1', '10.0.0.0/8' ) );
		$this->assertFalse( Ip::in_cidr( '11.0.0.1', '10.0.0.0/8' ) );
		$this->assertTrue( Ip::in_cidr( '100.100.0.1', '100.64.0.0/10' ) );
		$this->assertFalse( Ip::in_cidr( '100.128.0.1', '100.64.0.0/10' ) );
		$this->assertTrue( Ip::in_cidr( '1.2.3.4', '1.2.3.4' ), 'a bare address is a host range' );
		$this->assertFalse( Ip::in_cidr( '1.2.3.5', '1.2.3.4' ) );
		$this->assertFalse( Ip::in_cidr( '::1', '0.0.0.0/0' ), 'families do not mix' );
		$this->assertTrue( Ip::in_cidr( 'fdff::1', 'fc00::/7' ) );
		$this->assertFalse( Ip::in_cidr( 'fe00::1', 'fc00::/7' ) );
	}

	/**
	 * [S8-F23] Resolved addresses are remembered for DNS_TTL (and that cached answer is what is checked and pinned).
	 */
	public function test_s8_f23_resolved_addresses_are_cached(): void {
		remove_all_filters( 'inmolink_resolve_host' );
		set_transient( 'inmolink_dns_' . md5( 'cached.example' ), array( '93.184.216.34' ), ApiGuard::DNS_TTL );
		$this->assertSame( array( '93.184.216.34' ), ApiGuard::resolve( 'cached.example' ) );
		$this->assertTrue( ApiGuard::check( 'https://cached.example' )['ok'] );
		set_transient( 'inmolink_dns_' . md5( 'cached-bad.example' ), array( '169.254.169.254' ), ApiGuard::DNS_TTL );
		$this->assertSame( 'blocked_address', ApiGuard::check( 'https://cached-bad.example' )['error'] );
	}

	/**
	 * [S8-F23] The per-IP limit is checked before any DNS work, and IPv6 clients share their /64.
	 */
	public function test_s8_f23_limit_comes_before_the_address_check_and_counts_ipv6_per_64(): void {
		$ip = '2001:db8:0:1:aaaa::1';
		add_filter(
			'inmolink_api_caller_ip',
			function () use ( &$ip ) {
				return $ip;
			}
		);
		$resolved = 0;
		add_filter(
			'inmolink_resolve_host',
			static function ( $pre ) use ( &$resolved ) {
				++$resolved;
				return $pre;
			},
			1
		);
		$this->api->on( '/v2/listings', array( 'fixture' => 'listings.search.json' ) );
		$client = new Client( FakeApi::BASE, self::KEY );
		for ( $i = 0; $i < Client::CALL_LIMIT; $i++ ) {
			$ip = '2001:db8:0:1:' . dechex( $i + 1 ) . '::' . dechex( $i + 1 ); // A new address in the same /64 each time.
			$client->get( '/v2/listings', array( 'page' => $i ) );
		}
		$before = $resolved;
		$ip     = '2001:db8:0:1:ffff::9';
		$this->assertSame( 'rate_limited', $client->get( '/v2/listings', array( 'page' => 99 ) )->error, 'rotating inside a /64 does not help' );
		$this->assertSame( $before, $resolved, 'refused before DNS' );
		$ip = '2001:db8:0:2::1';
		$this->assertTrue( $client->get( '/v2/listings', array( 'page' => 1 ) )->ok(), 'another /64 is unaffected' );
	}

	/**
	 * [S8-F29] Buckets: canonical form, IPv6 per /64, mapped IPv4 as IPv4.
	 */
	public function test_s8_f29_buckets(): void {
		$this->assertSame( Ip::bucket( '2001:db8:0:1:aaaa::1' ), Ip::bucket( '2001:0DB8:0:1::2' ) );
		$this->assertNotSame( Ip::bucket( '2001:db8:0:1::1' ), Ip::bucket( '2001:db8:0:2::1' ) );
		$this->assertSame( '198.51.100.7', Ip::bucket( '::ffff:198.51.100.7' ) );
		$this->assertSame( '198.51.100.7', Ip::canonical( '::FFFF:198.51.100.7' ) );
		$this->assertSame( '2001:db8::1', Ip::canonical( '2001:0DB8:0:0:0:0:0:1' ) );
		$this->assertSame( '', Ip::bucket( 'nonsense' ) );
	}

	/**
	 * [S8-F29] Counters: an unknown IP is not counted (no shared bucket); storage stays bounded without an object cache.
	 */
	public function test_s8_f29_counters_are_bounded(): void {
		$this->assertSame( 0, Counter::hit( 'form', '', 600 ) );
		$this->assertSame( 0, Counter::count( 'form', '' ) );
		$this->assertSame( 0, Counter::hit( 'form', 'not-an-ip', 600 ) );
		$this->assertFalse( get_option( Counter::OPTION, false ), 'nothing stored for an unknown IP' );

		$this->assertSame( 1, Counter::hit( 'form', '198.51.100.1', 600 ) );
		$this->assertSame( 2, Counter::hit( 'form', '198.51.100.1', 600 ) );
		$this->assertSame( 2, Counter::count( 'form', '198.51.100.1' ) );
		$this->assertSame( 0, Counter::count( 'fail', '198.51.100.1' ), 'scopes are separate' );

		for ( $i = 0; $i < Counter::MAX_BUCKETS + 50; $i++ ) {
			Counter::hit( 'api', '10.' . intdiv( $i, 65536 ) . '.' . intdiv( $i % 65536, 256 ) . '.' . ( $i % 256 ), 600 );
		}
		$this->assertLessThanOrEqual( Counter::MAX_BUCKETS, count( (array) get_option( Counter::OPTION ) ) );

		update_option( Counter::OPTION, array( 'form_dead' => array( 5, time() - 1 ) ), false );
		$this->assertSame( 1, Counter::hit( 'form', '198.51.100.2', 600 ) );
		$this->assertArrayNotHasKey( 'form_dead', (array) get_option( Counter::OPTION ), 'expired counters are pruned' );
	}

	/**
	 * [S8-F29] A dual-stack server reports IPv4 visitors as ::ffff:a.b.c.d: that matches IPv4 ranges (and the reverse).
	 */
	public function test_s8_f29_mapped_addresses_match_ipv4_ranges(): void {
		$this->assertTrue( Ip::in_cidr( '::ffff:10.0.0.1', '10.0.0.0/8' ) );
		$this->assertFalse( Ip::in_cidr( '::ffff:11.0.0.1', '10.0.0.0/8' ) );
		$this->assertTrue( Ip::in_cidr( '10.0.0.1', '::ffff:10.0.0.0/104' ) );
		$this->assertTrue( Ip::in_cidr( '::ffff:10.0.0.1', '::ffff:10.0.0.0/104' ) );
		$this->assertFalse( Ip::in_cidr( '::ffff:11.0.0.1', '::ffff:10.0.0.0/104' ) );

		add_filter( 'inmolink_trusted_proxies', static fn () => array( '10.0.0.0/8' ) );
		$_SERVER['REMOTE_ADDR']          = '::ffff:10.0.0.1';
		$_SERVER['HTTP_X_FORWARDED_FOR'] = '198.51.100.9';
		$this->assertSame( '198.51.100.9', LeadForm::remote_ip(), 'the mapped proxy address is trusted' );
		$_SERVER['REMOTE_ADDR']          = '::ffff:203.0.113.5';
		$this->assertSame( '203.0.113.5', LeadForm::remote_ip(), 'canonical form' );
	}

	/**
	 * [S8-F29] The legacy single-header setting takes the rightmost value and never trusts X-Forwarded-For.
	 */
	public function test_s8_f29_legacy_header_is_not_client_controlled(): void {
		add_filter( 'inmolink_trusted_proxy_header', static fn () => 'HTTP_X_FORWARDED_FOR' );
		$_SERVER['REMOTE_ADDR']          = '198.51.100.5';
		$_SERVER['HTTP_X_FORWARDED_FOR'] = '1.2.3.4';
		$this->assertSame( '198.51.100.5', LeadForm::remote_ip(), 'a rotating X-Forwarded-For does not change the visitor' );

		remove_all_filters( 'inmolink_trusted_proxy_header' );
		add_filter( 'inmolink_trusted_proxy_header', static fn () => 'HTTP_CF_CONNECTING_IP' );
		$_SERVER['HTTP_CF_CONNECTING_IP'] = '9.9.9.9, 203.0.113.5';
		$this->assertSame( '203.0.113.5', LeadForm::remote_ip(), 'the rightmost value: the left side is client-controlled' );
	}

	/**
	 * [S8-F23] The health report says whether the address pin takes effect.
	 */
	public function test_s8_f23_health_reports_address_pinning(): void {
		$this->assertSame( extension_loaded( 'curl' ), \Inmolink\Plugin\Admin\Health::report()['api_pinning'] );
	}
}
