<?php
/**
 * wp-config key / base changes and unpinned transports (S10-F6).
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\Tests\Integration;

use Inmolink\Plugin\Admin\Health;
use Inmolink\Plugin\Admin\LegacyProxyNotice;
use Inmolink\Plugin\Api\Client;
use Inmolink\Plugin\Api\Response;
use Inmolink\Plugin\Cache\Cache;
use Inmolink\Plugin\ConfigGuard;
use Inmolink\Plugin\Listings;
use Inmolink\Plugin\Mirror\Mirror;
use Inmolink\Plugin\Net\ApiGuard;
use Inmolink\Plugin\Renderer;
use Inmolink\Plugin\Seo\SitemapIndex;
use Inmolink\Plugin\Settings;
use Inmolink\Plugin\Tests\FakeApi;
use Inmolink\Plugin\Tests\TestCase;

/**
 * Editing `INMOLINK_API_KEY` / `INMOLINK_API_BASE` never serves the previous agency; a transport that cannot pin the
 * API address never calls the API.
 */
final class ConfigChangeTest extends TestCase {

	/** Another agency's well-formed key. */
	private const OTHER_KEY = 'inl_test_skzyxwvutsrq_abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrst';

	/**
	 * The "wp-config" values the filter answers.
	 *
	 * @var array<string,string>
	 */
	private array $config = array();

	/**
	 * Answers the wp-config constants from {@see $config}.
	 */
	public function set_up(): void {
		parent::set_up();
		$this->config = array(
			'INMOLINK_API_BASE' => FakeApi::BASE,
			'INMOLINK_API_KEY'  => self::KEY,
		);
		add_filter( 'inmolink_wp_config_constant', fn ( $value, $name ) => $this->config[ $name ] ?? $value, 10, 2 );
	}

	/**
	 * [S10-F6] Changing the key constant, then taking the API down, renders nothing from the old agency.
	 */
	public function test_s10_f6_key_constant_change_never_serves_old_agency(): void {
		$this->assertSame( 20, has_action( 'plugins_loaded', array( ConfigGuard::class, 'check' ) ), 'the check runs on every boot' );
		ConfigGuard::check();
		$this->assertTrue( Settings::key_from_constant() );
		$this->assertSame( self::KEY, Settings::api_key() );

		$this->api->on( '/v2/listings', array( 'fixture' => 'listings.search.json' ) );
		$this->api->on( '/v2/listings/INM-1001', array( 'fixture' => 'listing.INM-1001.json' ) );
		$this->api->on( '/v2/sitemap', static fn ( array $query ): array => array( 'fixture' => 'sm_p2' === ( $query['cursor'] ?? null ) ? 'sitemap.page2.json' : 'sitemap.page1.json' ) );
		$args = array( 'transaction' => 'SALE' );
		$this->assertStringContainsString( 'Villa Sol', Renderer::from_settings()->search( $args ) );
		$this->assertStringContainsString( 'Villa Sol', Renderer::from_settings()->detail( 'INM-1001' ) );
		$this->assertNotNull( ( new Mirror() )->find( 'INM-1001', 'en' ) );
		$this->assertSame( 1, SitemapIndex::from_settings()->pages( 'en' ) );
		$this->assertNotSame( array(), SitemapIndex::from_settings()->entries( 'en', 1 ) );
		$this->assertFalse( ConfigGuard::check(), 'an unchanged config flushes nothing' );

		// wp-config.php now names another agency's key; the API is unreachable.
		$this->config['INMOLINK_API_KEY'] = self::OTHER_KEY;
		$this->api->down();
		$this->assertNull( Listings::from_settings()->search( $args ), 'the cache key alone already skips the old answers' );
		$this->assertSame( array(), SitemapIndex::from_settings()->entries( 'en', 1 ), 'the fingerprint alone already hides the old sitemap' );
		$this->assertTrue( ConfigGuard::check(), 'the boot check sees the change' );
		$this->assertSame( (string) get_option( ConfigGuard::OPTION ), Settings::config_fingerprint(), 'stored once the purge succeeded' );

		$search = Renderer::from_settings()->search( $args );
		$detail = Renderer::from_settings()->detail( 'INM-1001' );
		foreach ( array( $search, $detail ) as $html ) {
			$this->assertStringNotContainsString( 'Villa Sol', $html );
			$this->assertStringNotContainsString( 'Casa Luna', $html );
		}
		$this->assertNull( ( new Mirror() )->find( 'INM-1001', 'en' ), 'the mirror was emptied' );
		$this->assertNull( Listings::from_settings()->search( $args ) );
		$this->assertSame( 0, SitemapIndex::from_settings()->pages( 'en' ), 'an empty sitemap (rebuild failed: API down)' );
		$this->assertSame( array(), SitemapIndex::from_settings()->entries( 'en', 1 ) );
	}

	/**
	 * [S10-F6] The first boot with no stored fingerprint purges a mirror that already holds rows (safe default), and
	 * only records it otherwise.
	 */
	public function test_s10_f6_first_boot_purges_existing_mirror(): void {
		delete_option( ConfigGuard::OPTION );
		( new Mirror() )->upsert( 'INM-1001', 'en', array( 'slug' => 'villa-sol' ), null );
		$this->assertTrue( ConfigGuard::check() );
		$this->assertSame( 0, ( new Mirror() )->count() );
		$this->assertSame( Settings::config_fingerprint(), get_option( ConfigGuard::OPTION ) );

		delete_option( ConfigGuard::OPTION );
		$this->assertFalse( ConfigGuard::check(), 'an empty mirror: only recorded' );
		$this->assertSame( Settings::config_fingerprint(), get_option( ConfigGuard::OPTION ) );
	}

	/**
	 * [S10-F6] A base constant change is a new agency too; the fingerprint holds only the key's public prefix.
	 */
	public function test_s10_f6_base_constant_change_flushes(): void {
		ConfigGuard::check();
		$before                            = Settings::config_fingerprint();
		$key_before                        = Cache::key( '/v2/listings', array() );
		$this->config['INMOLINK_API_BASE'] = 'https://api2.inmolink.test';
		$this->assertNotSame( $before, Settings::config_fingerprint() );
		$this->assertNotSame( $key_before, Cache::key( '/v2/listings', array() ), 'another agency, other cache keys' );
		$this->assertTrue( ConfigGuard::check() );

		$this->config['INMOLINK_API_BASE'] = FakeApi::BASE;
		ConfigGuard::check();
		$same_prefix                      = Settings::config_fingerprint();
		$this->config['INMOLINK_API_KEY'] = substr( self::KEY, 0, 22 ) . str_repeat( 'z', 52 );
		$this->assertSame( $same_prefix, Settings::config_fingerprint(), 'only the public prefix: the secret part never enters it' );
	}

	/**
	 * [S10-F6] A settings-page save records the fingerprint, so the next boot does not flush a second time.
	 */
	public function test_s10_f6_settings_save_records_fingerprint(): void {
		ConfigGuard::check();
		$this->config = array();
		( new \Inmolink\Plugin\Admin\SettingsPage() )->save( array( 'api_base' => FakeApi::BASE ) );
		$this->assertFalse( ConfigGuard::check() );
	}

	/**
	 * [S10-F6] A streams-transport request makes no network call: the cache answers and the health page says so.
	 */
	public function test_s10_f6_streams_transport_makes_no_network_call(): void {
		$this->api->on( '/v2/listings', array( 'fixture' => 'listings.search.json' ) );
		$args   = array( 'transaction' => 'SALE' );
		$online = Renderer::from_settings()->search( $args );
		$this->assertStringContainsString( 'Villa Sol', $online );
		$key                  = Cache::key( '/v2/listings', Listings::search_query( $args ) );
		$entry                = get_transient( $key );
		$entry['fresh_until'] = time() - 1;
		set_transient( $key, $entry, DAY_IN_SECONDS );

		add_filter( 'use_curl_transport', '__return_false' );
		$this->api->requests = array();
		$this->assertFalse( ApiGuard::transport_pins() );

		$this->assertSame( $online, Renderer::from_settings()->search( $args ), 'the cached copy answers' );
		$response = Client::from_settings()->get( '/v2/listings', array( 'page' => 2 ) );
		$this->assertSame( Response::FAILED, $response->kind );
		$this->assertSame( 'unpinned', $response->error );
		$this->assertSame( Response::FAILED, Client::from_settings()->post( '/v2/leads', array(), 'idem-1' )->kind );
		$this->assertSame( array(), $this->api->requests, 'no request left the site' );
		$this->assertFalse( Client::in_backoff(), 'not a failure of the API: no back-off' );

		$report = Health::report();
		$this->assertTrue( $report['api_cache_only'] );
		$this->assertFalse( $report['api_pinning'] );
		$this->assertSame( 'critical', Health::site_status()['status'] );
		wp_set_current_user( self::factory()->user->create( array( 'role' => 'administrator' ) ) );
		ob_start();
		Health::render();
		$this->assertStringContainsString( 'served from the cache only', (string) ob_get_clean() );
		$this->assertSame( array(), $this->api->requests );
	}

	/**
	 * [S10-F6] With the cURL transport off, pinned() refuses and a real wp_remote_get never reaches the transport.
	 */
	public function test_s10_f6_unpinned_request_never_reaches_transport(): void {
		$this->api->uninstall();
		$reached  = array();
		$sentinel = static function ( $pre, $args, $url ) use ( &$reached ) {
			$reached[] = $url;
			return new \WP_Error( 'sentinel', 'no network in tests' );
		};
		add_filter( 'pre_http_request', $sentinel, PHP_INT_MAX, 3 );
		add_filter( 'use_curl_transport', '__return_false' );

		$checked = ApiGuard::check( FakeApi::BASE );
		$result  = ApiGuard::pinned( $checked, static fn () => wp_remote_get( FakeApi::BASE . '/v2/listings' ) );
		$this->assertWPError( $result );
		$this->assertSame( 'inmolink_unpinned', $result->get_error_code() );
		$this->assertSame( 'unpinned', Client::from_settings()->get( '/v2/listings' )->error );
		$this->assertSame( array(), $reached, 'no request was handed to the HTTP API' );

		remove_filter( 'use_curl_transport', '__return_false' );
		ApiGuard::pinned( $checked, static fn () => wp_remote_get( FakeApi::BASE . '/v2/listings' ) );
		$this->assertCount( 1, $reached, 'the sentinel does see a pinnable request' );
		remove_filter( 'pre_http_request', $sentinel, PHP_INT_MAX );
		$this->api->install();
	}

	/**
	 * [S10-F6] Should WordPress still pick the fsockopen transport, the pinned request is aborted before connecting.
	 */
	public function test_s10_f6_fsockopen_attempt_is_aborted(): void {
		$checked = ApiGuard::check( FakeApi::BASE );
		$this->assertNotSame( array(), $checked['ips'] );
		$this->expectException( \WpOrg\Requests\Exception::class );
		ApiGuard::pinned( $checked, static fn () => do_action( 'requests-fsockopen.before_request' ) ); // phpcs:ignore WordPress.NamingConventions.ValidHookName.UseUnderscores
	}

	/**
	 * [S10-F6] A deprecation notice when only the legacy trusted-header setting is used.
	 */
	public function test_s10_f6_legacy_trusted_header_deprecation_notice(): void {
		wp_set_current_user( self::factory()->user->create( array( 'role' => 'administrator' ) ) );
		$render = static function (): string {
			ob_start();
			LegacyProxyNotice::render();
			return (string) ob_get_clean();
		};
		$this->assertSame( '', $render(), 'nothing configured: no notice' );

		add_filter( 'inmolink_trusted_proxy_header', static fn () => 'HTTP_CF_CONNECTING_IP' );
		$this->assertStringContainsString( 'deprecated', $render() );

		add_filter( 'inmolink_trusted_proxies', static fn () => array( '10.0.0.0/8' ) );
		$this->assertSame( '', $render(), 'with proxy ranges the header is read safely' );
	}
}
