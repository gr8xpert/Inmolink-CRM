<?php
/**
 * S8-03 hardening: endpoint validation, key binding, TTL-only cache entries.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\Tests\Integration;

use Inmolink\Plugin\Admin\SettingsPage;
use Inmolink\Plugin\Api\Client;
use Inmolink\Plugin\Cache\Cache;
use Inmolink\Plugin\Listings;
use Inmolink\Plugin\Settings;
use Inmolink\Plugin\Tests\FakeApi;
use Inmolink\Plugin\Tests\TestCase;

/**
 * The URL an admin enters can neither reach this machine nor receive a key entered for another endpoint.
 */
final class HardeningTest extends TestCase {

	/**
	 * [S8-03] The API base is https://host[:port] only; a local API needs the wp-config opt-in.
	 */
	public function test_s8_03_base_url_rejects_unsafe_forms(): void {
		foreach ( array(
			'https://api.example.com#frag',
			'https://user:pw@api.example.com',
			'https://api.example.com?x=1',
			'https://api.example.com/v2',
			'https://api.example.com/../',
			'http://api.example.com',
			'https://localhost',
			'http://127.0.0.1:3001',
			'https://[::1]',
			'javascript:alert(1)',
			'https://api.exa mple.com',
		) as $bad ) {
			$this->assertSame( '', Settings::sanitize_base( $bad ), $bad );
		}
		$this->assertSame( 'https://api.example.com:8443', Settings::sanitize_base( 'https://API.example.com:8443/' ) );
		$this->assertSame( 'http://localhost:3001', Settings::sanitize_base_for( 'http://localhost:3001', true ) );
		$this->assertSame( '', Settings::sanitize_base_for( 'http://api.example.com', true ), 'plain http only on loopback' );
		$this->assertFalse( Settings::allow_local_api() );
	}

	/**
	 * [S8-03] WordPress's loopback / private-IP protection stays on without the opt-in.
	 */
	public function test_s8_03_requests_reject_unsafe_urls(): void {
		$seen = null;
		add_filter(
			'pre_http_request',
			static function ( $pre, $args ) use ( &$seen ) {
				$seen = $args['reject_unsafe_urls'] ?? null;
				return $pre;
			},
			1,
			2
		);
		$this->api->on( '/v2/listings', array( 'fixture' => 'listings.search.json' ) );
		Listings::from_settings()->search( array() );
		$this->assertTrue( $seen );
	}

	/**
	 * [S8-03] Changing the API URL clears the stored key: it is never sent to the new host.
	 */
	public function test_s8_03_changing_base_clears_key(): void {
		$notice = ( new SettingsPage() )->save(
			array(
				'api_base' => 'https://attacker.example',
				'locales'  => 'en',
			)
		);
		$this->assertSame( 'key_reentry', $notice );
		$this->assertSame( '', Settings::api_key() );
		$this->assertFalse( Settings::is_configured() );

		Client::from_settings()->get( '/v2/listings' );
		$this->assertSame( array(), $this->api->requests );
	}

	/**
	 * [S8-03] The stored key is sealed with its endpoint: editing the URL option directly does not redirect it.
	 */
	public function test_s8_03_stored_key_bound_to_its_base(): void {
		$settings             = get_option( Settings::OPTION );
		$settings['api_base'] = 'https://attacker.example';
		update_option( Settings::OPTION, $settings, false );

		$this->assertSame( '', Settings::api_key() );
		$this->assertSame( '', Settings::stored_key_for( self::KEY, FakeApi::BASE ), 'an unbound (legacy-format) value is not a key' );
	}

	/**
	 * [S8-03] A wp-config key goes only to INMOLINK_API_BASE, or to the production API when no base constant exists.
	 */
	public function test_s8_03_constant_key_only_to_its_base(): void {
		$this->assertTrue( Settings::constant_key_allowed( Settings::DEFAULT_API_BASE, null ) );
		$this->assertFalse( Settings::constant_key_allowed( 'https://attacker.example', null ) );
		$this->assertTrue( Settings::constant_key_allowed( 'https://api.inmolink.test', 'https://api.inmolink.test/' ) );
		$this->assertFalse( Settings::constant_key_allowed( 'https://attacker.example', 'https://api.inmolink.test' ) );
		$this->assertFalse( Settings::constant_key_allowed( '', null ) );
	}

	/**
	 * [S8-03] A TTL-only entry (free-text search) is never served or rewritten as a long-lived stale copy.
	 */
	public function test_s8_03_ttl_only_entries_never_go_stale(): void {
		$this->api->on( '/v2/listings', array( 'fixture' => 'listings.search.json' ) );
		$args = array( 'q' => 'villa' );
		$this->assertNotNull( Listings::from_settings()->search( $args ) );

		$key                  = Cache::key( '/v2/listings', Listings::search_query( $args ) );
		$entry                = get_transient( $key );
		$entry['fresh_until'] = time() - 1;
		set_transient( $key, $entry, DAY_IN_SECONDS );
		$this->api->down();

		$this->assertNull( Listings::from_settings()->search( $args ) );
		$after = get_transient( $key );
		$this->assertFalse( $after['keep_stale'], 'not upgraded to a stale copy' );
		$this->assertSame( $entry['fresh_until'], $after['fresh_until'], 'not rewritten by the failed call' );
	}
}
