<?php
/**
 * Settings migration from the legacy plugin (S8-F11) on the ASSUMED fixture (pending H15).
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\Tests\Integration;

use Inmolink\Plugin\Installer;
use Inmolink\Plugin\Migration\LegacySettings;
use Inmolink\Plugin\Settings;
use Inmolink\Plugin\Sync\DeltaSync;
use Inmolink\Plugin\Tests\FakeApi;
use Inmolink\Plugin\Tests\TestCase;

/**
 * A fresh v2 install on a site that still has the legacy plugin's options.
 */
final class LegacyMigrationTest extends TestCase {

	/** The key in tests/fixtures/legacy/options.json. */
	private const LEGACY_KEY = 'inl_test_skzyxwvutsrq_zyxwvutsrqponmlkjihgfedcba765432zyxwvutsrqponmlkjihg';

	/**
	 * The legacy options as stored by the legacy plugin.
	 *
	 * @var array<string,mixed>
	 */
	private array $legacy;

	/**
	 * Removes the v2 configuration TestCase made (a fresh install), stores the legacy options and points the API at the
	 * fake through wp-config (`INMOLINK_API_BASE`).
	 */
	public function set_up(): void {
		parent::set_up();
		delete_option( Settings::OPTION );
		delete_option( Settings::KEY_OPTION );
		$fixture      = json_decode( (string) file_get_contents( dirname( __DIR__ ) . '/fixtures/legacy/options.json' ), true );
		$this->legacy = $fixture['options'];
		foreach ( $this->legacy as $name => $value ) {
			update_option( $name, $value );
		}
		add_filter( 'inmolink_wp_config_constant', array( $this, 'config' ), 10, 2 );
	}

	/**
	 * Removes the filters.
	 */
	public function tear_down(): void {
		remove_filter( 'inmolink_wp_config_constant', array( $this, 'config' ), 10 );
		remove_all_filters( 'inmolink_migrate_legacy_settings' );
		parent::tear_down();
	}

	/**
	 * `INMOLINK_API_BASE` = the fake API.
	 *
	 * @param mixed  $value Value.
	 * @param string $name  Constant.
	 * @return mixed
	 */
	public function config( $value, $name ) {
		return 'INMOLINK_API_BASE' === $name ? FakeApi::BASE : $value;
	}

	/**
	 * Turns the migration on, as `INMOLINK_MIGRATE_LEGACY_SETTINGS` would.
	 */
	private function enable(): void {
		add_filter( 'inmolink_migrate_legacy_settings', '__return_true' );
	}

	/**
	 * The legacy options exactly as they are in the database now.
	 *
	 * @return array<string,mixed>
	 */
	private function legacy_now(): array {
		$out = array();
		foreach ( array_keys( $this->legacy ) as $name ) {
			$out[ $name ] = get_option( $name );
		}
		return $out;
	}

	/**
	 * [S8-F11] a site with the legacy plugin's settings activates v2 and syncs without re-entering the key
	 */
	public function test_s8_f11_legacy_site_activates_and_syncs_without_reentering_key(): void {
		$this->enable();
		$this->assertFalse( Settings::is_configured(), 'a fresh v2 install has no key' );

		Installer::activate();

		$this->assertSame( self::LEGACY_KEY, Settings::api_key() );
		$this->assertTrue( Settings::is_configured() );
		$this->assertSame( array( 'en', 'es-ES' ), Settings::get( 'locales' ) );
		$this->assertSame( 'es-ES', Settings::get( 'default_locale' ) );
		$this->assertSame( 600, Settings::get( 'cache_ttl' ), 'legacy minutes become seconds' );
		$this->assertSame( 'propiedad', Settings::get( 'listing_base' ) );
		$this->assertSame( FakeApi::BASE, Settings::get( 'api_base' ), 'the legacy v1 URL is not migrated' );

		global $wpdb;
		$raw = (string) $wpdb->get_var( $wpdb->prepare( "SELECT option_value FROM {$wpdb->options} WHERE option_name = %s", Settings::KEY_OPTION ) );
		$this->assertStringStartsWith( 'v1:', $raw, 'stored through the encrypted path' );
		$this->assertStringNotContainsString( self::LEGACY_KEY, $raw );

		$this->api->on( '/v2/changes', array( 'fixture' => 'changes.empty.json' ) );
		$this->api->on( '/v2/sitemap', array( 'fixture' => 'sitemap.page.json' ) );
		$run = DeltaSync::from_settings()->run();
		$this->assertSame( 'ok', $run['status'] );
		$requests = $this->api->requests_to( '/v2/changes' );
		$this->assertNotEmpty( $requests );
		$this->assertSame( self::LEGACY_KEY, $requests[0]['headers']['x-api-key'], 'the sync uses the migrated key' );
	}

	/**
	 * [S8-F11] The legacy options are left untouched (a rollback to the legacy plugin still works).
	 */
	public function test_s8_f11_legacy_options_untouched(): void {
		$this->enable();
		$before = $this->legacy_now();
		Installer::activate();
		$this->assertSame( 'migrated', get_option( LegacySettings::MARKER_OPTION )['key'] );
		$this->assertSame( $before, $this->legacy_now() );
		$this->assertSame( $this->legacy, $this->legacy_now() );
	}

	/**
	 * [S8-F11] Existing v2 settings and a key the admin already set are never overwritten.
	 */
	public function test_s8_f11_existing_v2_settings_not_overwritten(): void {
		$this->enable();
		Settings::save(
			array(
				'locales'      => 'en,de',
				'listing_base' => 'homes',
				'cache_ttl'    => 120,
			)
		);
		$this->assertTrue( Settings::set_api_key( self::KEY ) );

		$result = LegacySettings::migrate();

		$this->assertSame( 'migrated', $result['status'] );
		$this->assertFalse( $result['settings'] );
		$this->assertSame( 'kept', $result['key'] );
		$this->assertSame( self::KEY, Settings::api_key() );
		$this->assertSame( array( 'en', 'de' ), Settings::get( 'locales' ) );
		$this->assertSame( 'homes', Settings::get( 'listing_base' ) );
		$this->assertSame( 120, Settings::get( 'cache_ttl' ) );
	}

	/**
	 * [S8-F11] It runs once: a re-activation after the admin cleared the key does not bring the legacy key back.
	 */
	public function test_s8_f11_idempotent(): void {
		$this->enable();
		$this->assertSame( 'migrated', LegacySettings::migrate()['status'] );
		Settings::clear_api_key();
		$this->assertSame( 'already', LegacySettings::migrate()['status'] );
		Installer::activate();
		$this->assertSame( '', Settings::api_key() );
	}

	/**
	 * [S8-F11] Flag off (the default while the mapping is ASSUMED): activation changes nothing.
	 */
	public function test_s8_f11_flag_off_is_a_no_op(): void {
		$this->assertFalse( LegacySettings::enabled() );
		$this->assertSame( 'ASSUMED', LegacySettings::map()['status'] );
		Installer::activate();
		$this->assertFalse( get_option( Settings::OPTION ) );
		$this->assertFalse( get_option( Settings::KEY_OPTION ) );
		$this->assertFalse( get_option( LegacySettings::MARKER_OPTION ) );
		$this->assertSame( 'disabled', LegacySettings::migrate()['status'] );
	}

	/**
	 * [S8-F11] A legacy key that is not a v2 secret key is not stored; no legacy options at all is a clean no-op.
	 */
	public function test_s8_f11_invalid_key_and_no_legacy(): void {
		$this->enable();
		$options            = $this->legacy['inmolink_options'];
		$options['api_key'] = 'old-v1-key-1234';
		update_option( 'inmolink_options', $options );
		$this->assertSame( 'invalid', LegacySettings::migrate()['key'] );
		$this->assertSame( '', Settings::api_key() );

		delete_option( LegacySettings::MARKER_OPTION );
		foreach ( array_keys( $this->legacy ) as $name ) {
			delete_option( $name );
		}
		$this->assertSame( 'no_legacy', LegacySettings::migrate()['status'] );
		$this->assertFalse( get_option( LegacySettings::MARKER_OPTION ) );
	}
}
