<?php
/**
 * Settings page and key storage.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\Tests\Integration;

use Inmolink\Plugin\Admin\SettingsPage;
use Inmolink\Plugin\Mirror\Mirror;
use Inmolink\Plugin\Settings;
use Inmolink\Plugin\Sync\DeltaSync;
use Inmolink\Plugin\Tests\FakeApi;
use Inmolink\Plugin\Tests\TestCase;

/**
 * The secret key is encrypted, autoload-off and never printed; inputs are sanitized; actions need the capability and
 * a nonce.
 */
final class SettingsTest extends TestCase {

	/**
	 * [S8-03] The secret key is stored encrypted, not autoloaded, and decrypts back.
	 */
	public function test_s8_03_api_key_stored_encrypted_autoload_off(): void {
		global $wpdb;
		$raw = $wpdb->get_row( $wpdb->prepare( "SELECT option_value, autoload FROM {$wpdb->options} WHERE option_name = %s", Settings::KEY_OPTION ), ARRAY_A );

		$this->assertIsArray( $raw );
		$this->assertStringNotContainsString( self::KEY, $raw['option_value'] );
		$this->assertStringStartsWith( 'v1:', $raw['option_value'] );
		$this->assertContains( $raw['autoload'], array( 'no', 'off' ) );
		$this->assertSame( self::KEY, Settings::api_key() );

		$settings = $wpdb->get_var( $wpdb->prepare( "SELECT autoload FROM {$wpdb->options} WHERE option_name = %s", Settings::OPTION ) );
		$this->assertContains( $settings, array( 'no', 'off' ) );
	}

	/**
	 * [S8-03] Publishable or malformed keys are refused; an empty key field keeps the stored key.
	 */
	public function test_s8_03_key_validation_and_write_only_field(): void {
		$page = new SettingsPage();
		$base = array(
			'api_base' => 'https://api.inmolink.test',
			'locales'  => 'en',
		);

		$this->assertSame( 'key_invalid', $page->save( $base + array( 'api_key' => 'inl_test_pkabcdefghij_abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrst' ) ) );
		$this->assertSame( self::KEY, Settings::api_key(), 'a publishable key never replaces the secret one' );

		$this->assertSame( 'saved', $page->save( $base + array( 'api_key' => '' ) ) );
		$this->assertSame( self::KEY, Settings::api_key(), 'empty keeps the stored key' );

		$this->assertSame( 'saved', $page->save( $base + array( 'clear_key' => '1' ) ) );
		$this->assertSame( '', Settings::api_key() );
		$this->assertFalse( Settings::is_configured() );
	}

	/**
	 * [S8-03] The settings page never prints the key.
	 */
	public function test_s8_03_settings_page_never_echoes_key(): void {
		wp_set_current_user( self::factory()->user->create( array( 'role' => 'administrator' ) ) );
		ob_start();
		( new SettingsPage() )->render();
		$html = (string) ob_get_clean();

		$this->assertStringContainsString( 'name="inmolink[api_key]" value=""', $html );
		$this->assertStringNotContainsString( self::KEY, $html );
		$this->assertStringNotContainsString( substr( self::KEY, -20 ), $html );
		$this->assertStringContainsString( 'name="_wpnonce"', $html );
	}

	/**
	 * [S8-03] The page and its actions need manage_options and a valid nonce.
	 */
	public function test_s8_03_capability_and_nonce_checks(): void {
		wp_set_current_user( self::factory()->user->create( array( 'role' => 'editor' ) ) );
		try {
			ob_start();
			( new SettingsPage() )->render();
			$this->fail( 'an editor must not see the page' );
		} catch ( \WPDieException $e ) {
			$this->assertStringContainsString( 'permission', $e->getMessage() );
		} finally {
			ob_end_clean();
		}

		wp_set_current_user( self::factory()->user->create( array( 'role' => 'administrator' ) ) );
		$_POST['inmolink'] = array( 'api_base' => 'https://evil.example' );
		$_REQUEST['_wpnonce'] = 'not-a-nonce';
		try {
			( new SettingsPage() )->on_save();
			$this->fail( 'a save without a valid nonce must die' );
		} catch ( \WPDieException $e ) {
			$this->assertSame( FakeApi::BASE, Settings::get( 'api_base' ), 'nothing saved' );
		} finally {
			unset( $_POST['inmolink'], $_REQUEST['_wpnonce'] );
		}
	}

	/**
	 * [S8-03] Settings are sanitized: https only, valid locales, TTL clamped.
	 */
	public function test_s8_03_settings_sanitized(): void {
		$clean = Settings::sanitize(
			array(
				'api_base'       => 'javascript:alert(1)',
				'locales'        => 'en, es ,xx-yy,EN,de-DE,"><b>',
				'default_locale' => 'fr',
				'cache_ttl'      => '5',
				'stale_days'     => '999',
			)
		);
		$this->assertSame( '', $clean['api_base'] );
		$this->assertSame( array( 'en', 'es', 'de-DE' ), $clean['locales'] );
		$this->assertSame( 'en', $clean['default_locale'] );
		$this->assertSame( Settings::MIN_TTL, $clean['cache_ttl'] );
		$this->assertSame( 90, $clean['stale_days'] );
		$this->assertSame( 'https://api.example.com', Settings::sanitize_base( 'https://api.example.com/' ) );
		$this->assertSame( '', Settings::sanitize_base( 'https://user:pw@api.example.com' ) );
		$this->assertSame( '', Settings::sanitize_base( 'ftp://api.example.com' ) );
		$this->assertSame( '', Settings::sanitize_base( 'http://api.example.com' ), 'no plain http: the key travels in a header' );
		$this->assertSame( 'http://localhost:3001', Settings::sanitize_base( 'http://localhost:3001' ) );
	}

	/**
	 * [S8-03] A new endpoint or key resets the sync cursor and empties the mirror (no other site's data as fallback).
	 */
	public function test_s8_03_new_endpoint_resets_sync_state(): void {
		update_option( DeltaSync::STATE_OPTION, array( 'cursor' => 'cur_old' ), false );
		( new Mirror() )->upsert( 'INM-1001', 'en', array( 'ref' => 'INM-1001', 'title' => 'Old site' ), null );
		( new SettingsPage() )->save(
			array(
				'api_base' => 'https://other.inmolink.test',
				'locales'  => 'en',
			)
		);
		$this->assertNull( DeltaSync::state()['cursor'] );
		$this->assertSame( 0, ( new Mirror() )->count() );
	}

	/**
	 * [S8-03] The mirror table is created by dbDelta, with a unique (ref, lang) key, and install is repeatable.
	 */
	public function test_s8_03_mirror_table_installed(): void {
		global $wpdb;
		Mirror::install();
		$table = Mirror::table();
		$this->assertSame( $table, $wpdb->get_var( $wpdb->prepare( 'SHOW TABLES LIKE %s', $table ) ) );
		$index = $wpdb->get_results( "SHOW INDEX FROM {$table} WHERE Key_name = 'ref_lang'", ARRAY_A );
		$this->assertCount( 2, $index );
		$this->assertSame( '0', (string) $index[0]['Non_unique'] );
		$this->assertSame( Mirror::SCHEMA_VERSION, get_option( Mirror::VERSION_OPTION ) );
	}
}
