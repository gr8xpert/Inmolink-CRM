<?php
/**
 * Base test case.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\Tests;

use Inmolink\Plugin\Api\Client;
use Inmolink\Plugin\Mirror\Mirror;
use Inmolink\Plugin\Settings;

/**
 * A configured plugin (API URL, a valid secret key, English) talking to {@see FakeApi}.
 */
abstract class TestCase extends \WP_UnitTestCase {

	/** A well-formed secret key (never a real one). */
	public const KEY = 'inl_test_skabcdefghij_abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrst';

	/**
	 * The fake API.
	 *
	 * @var FakeApi
	 */
	protected FakeApi $api;

	/**
	 * Configures the plugin and installs the fake API.
	 */
	public function set_up(): void {
		parent::set_up();
		Settings::save(
			array(
				'api_base'       => FakeApi::BASE,
				'locales'        => 'en',
				'default_locale' => 'en',
				'cache_ttl'      => 300,
			)
		);
		$this->assertTrue( Settings::set_api_key( self::KEY ) );
		Client::reset_backoff();
		$this->api = new FakeApi();
		$this->api->install();
	}

	/**
	 * Removes the fake API.
	 */
	public function tear_down(): void {
		$this->api->uninstall();
		parent::tear_down();
	}

	/**
	 * Ages every mirror row past {@see \Inmolink\Plugin\Listings::MIRROR_MAX_AGE}.
	 */
	protected function age_mirror(): void {
		global $wpdb;
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery
		$wpdb->query( 'UPDATE ' . Mirror::table() . " SET fetched_at = '2020-01-01 00:00:00'" );
	}
}
