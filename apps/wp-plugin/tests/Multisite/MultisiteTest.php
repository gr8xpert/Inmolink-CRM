<?php
/**
 * S8-F16: the plugin on a WordPress network.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\Tests\Multisite;

use Inmolink\Plugin\Admin\SettingsPage;
use Inmolink\Plugin\Api\Client;
use Inmolink\Plugin\Cache\Cache;
use const Inmolink\Plugin\PLUGIN_FILE;
use Inmolink\Plugin\Installer;
use Inmolink\Plugin\Mirror\Mirror;
use Inmolink\Plugin\Settings;
use Inmolink\Plugin\Sync\DeltaSync;
use Inmolink\Plugin\Tests\TestCase;
use Inmolink\Plugin\Updates\Updater;

/**
 * Runs with `phpunit.multisite.xml.dist` (WP_TESTS_MULTISITE).
 */
final class MultisiteTest extends TestCase {

	/**
	 * Whether a site's mirror table exists (a SELECT: the test case turns tables into temporary ones, which
	 * SHOW TABLES does not list).
	 *
	 * @param int $blog_id Site id.
	 */
	private function table_exists( int $blog_id ): bool {
		global $wpdb;
		switch_to_blog( $blog_id );
		$table = Mirror::table();
		$wpdb->suppress_errors( true );
		$count = $wpdb->get_var( "SELECT COUNT(*) FROM {$table}" ); // phpcs:ignore WordPress.DB
		$wpdb->suppress_errors( false );
		restore_current_blog();
		return null !== $count;
	}

	/**
	 * [S8-F16] Uninstall on a two-site network removes both sites' tables and options.
	 */
	public function test_s8_f16_uninstall_removes_every_sites_data(): void {
		$this->assertTrue( is_multisite() );
		$sites = array( self::factory()->blog->create(), self::factory()->blog->create() );
		foreach ( $sites as $id ) {
			switch_to_blog( $id );
			Mirror::install();
			Settings::save( array( 'api_base' => 'https://api.inmolink.test', 'locales' => 'en' ) );
			update_option( DeltaSync::STATE_OPTION, array( 'cursor' => 'cur_' . $id ), false );
			update_option( Cache::GENERATION_OPTION, 7, true );
			set_transient( Cache::PREFIX . 'abc', array( 'body' => array() ), 300 );
			set_transient( Client::PROBE_TRANSIENT, array( 'ok' => true ), 300 );
			set_transient( Client::DOWN_TRANSIENT . '_' . Client::SYNC, 'retry_after', 300 );
			restore_current_blog();
			$this->assertTrue( $this->table_exists( $id ), "site $id has its table before uninstall" );
		}

		update_site_option( Updater::HIGHEST_OPTION, '9.9.9' );
		update_site_option( Updater::REPLAY_OPTION, array( 'offered' => '0.1.0', 'highest' => '9.9.9' ) );
		update_site_option( 'inmolink_auto_update_init', 1 );
		set_site_transient( Updater::INFO_TRANSIENT, array( 'version' => '9.9.9' ), 300 );

		Installer::uninstall();
		wp_cache_flush(); // Uninstall deletes rows directly; the process ends right after, a test must forget its in-memory copies.

		foreach ( $sites as $id ) {
			$this->assertFalse( $this->table_exists( $id ), "site $id table removed" );
			switch_to_blog( $id );
			$this->assertFalse( get_option( Settings::OPTION ), "site $id settings removed" );
			$this->assertFalse( get_option( DeltaSync::STATE_OPTION ), "site $id sync state removed" );
			$this->assertFalse( get_option( Cache::GENERATION_OPTION ), "site $id cache generation removed" );
			$this->assertFalse( get_transient( Cache::PREFIX . 'abc' ), "site $id cached answers removed" );
			$this->assertFalse( get_transient( Client::PROBE_TRANSIENT ), "site $id probe removed" );
			$this->assertFalse( get_transient( Client::DOWN_TRANSIENT . '_' . Client::SYNC ), "site $id sync back-off removed" );
			restore_current_blog();
		}
		$this->assertFalse( get_site_option( Updater::HIGHEST_OPTION ), 'network: highest release' );
		$this->assertFalse( get_site_option( Updater::REPLAY_OPTION ), 'network: replay flag' );
		$this->assertFalse( get_site_option( 'inmolink_auto_update_init' ), 'network: auto-update marker' );
		$this->assertFalse( get_site_transient( Updater::INFO_TRANSIENT ), 'network: update info' );
	}

	/**
	 * [S8-F16] A site created while the plugin is network-active gets its table.
	 */
	public function test_s8_f16_new_site_gets_its_table_when_network_active(): void {
		$basename = plugin_basename( PLUGIN_FILE );
		update_site_option( 'active_sitewide_plugins', array( $basename => time() ) );
		$id = self::factory()->blog->create();
		$this->assertTrue( $this->table_exists( $id ) );

		update_site_option( 'active_sitewide_plugins', array() );
		$other = self::factory()->blog->create();
		$this->assertFalse( $this->table_exists( $other ), 'not network-active: left alone' );
	}

	/**
	 * [S8-F16] Changing the API URL needs network-level rights; other settings still save.
	 */
	public function test_s8_f16_api_url_needs_network_rights(): void {
		$site_admin = self::factory()->user->create( array( 'role' => 'administrator' ) );
		wp_set_current_user( $site_admin );
		$this->assertFalse( is_super_admin() );
		$this->assertFalse( SettingsPage::can_change_api_base() );

		$notice = ( new SettingsPage() )->save(
			array(
				'api_base'  => 'https://other.inmolink.test',
				'locales'   => 'en,es',
				'cache_ttl' => 600,
			)
		);
		$this->assertSame( 'base_network_only', $notice );
		$this->assertSame( \Inmolink\Plugin\Tests\FakeApi::BASE, Settings::get( 'api_base' ), 'the URL is unchanged' );
		$this->assertSame( 600, Settings::get( 'cache_ttl' ), 'the rest saved' );

		grant_super_admin( $site_admin );
		wp_set_current_user( $site_admin );
		$this->assertTrue( SettingsPage::can_change_api_base() );
		( new SettingsPage() )->save( array( 'api_base' => 'https://other.inmolink.test', 'locales' => 'en' ) );
		$this->assertSame( 'https://other.inmolink.test', Settings::get( 'api_base' ) );
	}
}
