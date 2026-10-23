<?php
/**
 * Acceptance: a test site auto-updates from version N to N+1 (signed packages only).
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\Tests\Integration;

use Inmolink\Plugin\Tests\FakeApi;
use Inmolink\Plugin\Tests\TestCase;
use Inmolink\Plugin\Updates\Updater;

/**
 * The update checker against a stubbed update server, a real signed zip, and WordPress's own upgrader.
 */
final class UpdaterTest extends TestCase {

	private const BASENAME = 'inmolink/inmolink.php';

	/**
	 * The zip served as the new version.
	 *
	 * @var string
	 */
	private string $zip;

	/**
	 * The updater under test (registered on WordPress's hooks).
	 *
	 * @var Updater
	 */
	private Updater $updater;

	/**
	 * Installs version 0.1.0 of a plugin at inmolink/inmolink.php and builds a signed 0.2.0 package.
	 */
	public function set_up(): void {
		parent::set_up();
		require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';
		require_once ABSPATH . 'wp-admin/includes/class-pclzip.php';
		require_once ABSPATH . 'wp-admin/includes/plugin.php';

		self::write_plugin( WP_PLUGIN_DIR . '/inmolink', '0.1.0' );
		$this->zip = self::build_zip( '0.2.0' );
		delete_site_transient( Updater::INFO_TRANSIENT );
		$this->updater = new Updater( self::BASENAME, '0.1.0' );
		$this->updater->register();
		// WordPress's own update checks after an upgrade would call wordpress.org (blocked in tests).
		remove_action( 'upgrader_process_complete', 'wp_version_check' );
		remove_action( 'upgrader_process_complete', 'wp_update_plugins' );
		remove_action( 'upgrader_process_complete', 'wp_update_themes' );
	}

	/**
	 * Removes the installed test plugin.
	 */
	public function tear_down(): void {
		remove_filter( 'pre_set_site_transient_update_plugins', array( $this->updater, 'filter_update_transient' ) );
		remove_filter( 'upgrader_pre_download', array( $this->updater, 'pre_download' ), 10 );
		self::remove_dir( WP_PLUGIN_DIR . '/inmolink' );
		wp_delete_file( $this->zip );
		parent::tear_down();
	}

	/**
	 * Writes a minimal plugin folder.
	 *
	 * @param string $dir     Folder.
	 * @param string $version Version header.
	 */
	private static function write_plugin( string $dir, string $version ): void {
		wp_mkdir_p( $dir );
		file_put_contents( $dir . '/inmolink.php', "<?php\n/**\n * Plugin Name: Inmolink\n * Version: {$version}\n */\n" );
	}

	/**
	 * A real zip of the plugin at a version (`inmolink/inmolink.php`).
	 *
	 * @param string $version Version.
	 */
	private static function build_zip( string $version ): string {
		$src = get_temp_dir() . 'inmolink-src-' . wp_generate_password( 8, false );
		self::write_plugin( $src . '/inmolink', $version );
		$zip = get_temp_dir() . 'inmolink-' . $version . '-' . wp_generate_password( 8, false ) . '.zip';
		$pcl = new \PclZip( $zip );
		$pcl->create( $src . '/inmolink', PCLZIP_OPT_REMOVE_PATH, $src );
		self::remove_dir( $src );
		return $zip;
	}

	/**
	 * Deletes a folder tree.
	 *
	 * @param string $dir Folder.
	 */
	private static function remove_dir( string $dir ): void {
		if ( ! is_dir( $dir ) ) {
			return;
		}
		foreach ( new \RecursiveIteratorIterator( new \RecursiveDirectoryIterator( $dir, \FilesystemIterator::SKIP_DOTS ), \RecursiveIteratorIterator::CHILD_FIRST ) as $f ) {
			$f->isDir() ? rmdir( $f->getPathname() ) : unlink( $f->getPathname() );
		}
		rmdir( $dir );
	}

	/**
	 * Serves release metadata (signed over `$signed_version` and the zip's hash) and the given package bytes.
	 *
	 * @param string      $version        Offered version.
	 * @param string      $bytes          Package bytes served.
	 * @param string|null $signed_version Version the signature covers (default: the offered one).
	 * @param string|null $signed_bytes   Bytes the hash and signature cover (default: the served ones).
	 */
	private function serve( string $version, string $bytes, ?string $signed_version = null, ?string $signed_bytes = null ): void {
		$sha = hash( 'sha256', $signed_bytes ?? $bytes );
		$sig = sodium_crypto_sign_detached( Updater::signing_message( $signed_version ?? $version, $sha ), INMOLINK_TEST_SIGNING_SECRET );
		$this->api->on(
			'/v2/plugin/update',
			array(
				'body' => array(
					'slug'        => 'inmolink',
					'version'     => $version,
					'sha256'      => $sha,
					'signature'   => base64_encode( $sig ), // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode
					'sizeBytes'   => strlen( $bytes ),
					'requires'    => '6.4',
					'requiresPhp' => '8.1',
					'tested'      => '6.8',
					'releasedAt'  => '2026-10-23T10:00:00.000Z',
					'changelog'   => "Signed updates.\n<script>alert(1)</script>",
					'package'     => '/v2/plugin/package/' . $version,
				),
			)
		);
		$this->api->on( '/v2/plugin/package/' . $version, array( 'raw' => $bytes ) );
	}

	/**
	 * Runs WordPress's update check and its upgrader for the test plugin.
	 *
	 * @return bool|\WP_Error|null The upgrader's result.
	 */
	private function upgrade() {
		delete_site_transient( Updater::INFO_TRANSIENT );
		$transient          = new \stdClass();
		$transient->checked = array( self::BASENAME => '0.1.0' );
		set_site_transient( 'update_plugins', $transient );

		$level    = ob_get_level();
		$upgrader = new \Plugin_Upgrader( new \Automatic_Upgrader_Skin() );
		try {
			return $upgrader->upgrade( self::BASENAME );
		} finally {
			// The skin leaves its feedback buffer open on errors.
			while ( ob_get_level() > $level ) {
				ob_end_clean();
			}
		}
	}

	/**
	 * The installed test plugin's version.
	 */
	private static function installed_version(): string {
		return get_plugin_data( WP_PLUGIN_DIR . '/inmolink/inmolink.php', false, false )['Version'];
	}

	/**
	 * [S8-05] A test site auto-updates from version N to N+1 with a signed package.
	 */
	public function test_s8_05_site_auto_updates_from_n_to_n_plus_1(): void {
		$this->serve( '0.2.0', (string) file_get_contents( $this->zip ) );

		$this->assertTrue( $this->upgrade() );

		$this->assertSame( '0.2.0', self::installed_version() );
		delete_site_option( 'inmolink_auto_update_init' );
		$this->updater->enable_auto_update_once();
		$this->assertContains( self::BASENAME, (array) get_site_option( 'auto_update_plugins' ), "WordPress's own auto-updates turned on once" );
		$this->assertSame( 'GET', $this->api->requests_to( '/v2/plugin/package/0.2.0' )[0]['method'] );
	}

	/**
	 * [S8-05] WordPress's automatic updater installs the signed release in the background (auto-updates on).
	 */
	public function test_s8_05_background_auto_update(): void {
		$this->serve( '0.2.0', (string) file_get_contents( $this->zip ) );
		delete_site_option( 'inmolink_auto_update_init' );
		$this->updater->enable_auto_update_once();
		// The WordPress test suite switches background updates off; this test is about them.
		add_filter( 'automatic_updater_disabled', '__return_false', 99 );
		add_filter( 'plugins_auto_update_enabled', '__return_true', 99 );
		$transient          = new \stdClass();
		$transient->checked = array( self::BASENAME => '0.1.0' );
		set_site_transient( 'update_plugins', $transient );
		$item = get_site_transient( 'update_plugins' )->response[ self::BASENAME ];

		$level = ob_get_level();
		try {
			$result = ( new \WP_Automatic_Updater() )->update( 'plugin', $item );
		} finally {
			while ( ob_get_level() > $level ) {
				ob_end_clean();
			}
		}
		$this->assertTrue( $result );
		$this->assertSame( '0.2.0', self::installed_version() );
	}

	/**
	 * [S8-05] The update offer carries the version, package URL and requirements; no offer for an equal version.
	 */
	public function test_s8_05_update_offer(): void {
		$this->serve( '0.2.0', (string) file_get_contents( $this->zip ) );
		$transient          = new \stdClass();
		$transient->checked = array( self::BASENAME => '0.1.0' );
		$offer              = $this->updater->filter_update_transient( $transient );
		$this->assertSame( '0.2.0', $offer->response[ self::BASENAME ]->new_version );
		$this->assertSame( 'https://api.inmolink.test/v2/plugin/package/0.2.0', $offer->response[ self::BASENAME ]->package );
		$this->assertSame( '8.1', $offer->response[ self::BASENAME ]->requires_php );

		$details = $this->updater->plugins_api( false, 'plugin_information', (object) array( 'slug' => 'inmolink' ) );
		$this->assertStringNotContainsString( '<script>', $details->sections['changelog'] );

		$same               = new Updater( self::BASENAME, '0.2.0' );
		$transient          = new \stdClass();
		$transient->checked = array( self::BASENAME => '0.2.0' );
		$this->assertArrayNotHasKey( self::BASENAME, (array) ( $same->filter_update_transient( $transient )->response ?? array() ) );
	}

	/**
	 * [S8-05] A tampered package is refused and the installed version stays.
	 */
	public function test_s8_05_tampered_package_is_refused(): void {
		$good = (string) file_get_contents( $this->zip );
		$this->serve( '0.2.0', $good . 'tampered', null, $good );

		$this->assertNotTrue( $this->upgrade() );
		$this->assertSame( '0.1.0', self::installed_version(), 'WordPress installed nothing' );
		$error = $this->updater->pre_download( false, FakeApi::BASE . '/v2/plugin/package/0.2.0' );
		$this->assertWPError( $error );
		$this->assertSame( 'inmolink_update_hash', $error->get_error_code() );
	}

	/**
	 * [S8-05] A package signed for another version (a replayed older release) or with another key is refused.
	 */
	public function test_s8_05_wrong_signature_is_refused(): void {
		$this->serve( '0.2.0', (string) file_get_contents( $this->zip ), '0.0.9' );
		$this->assertNotTrue( $this->upgrade() );
		$this->assertSame( '0.1.0', self::installed_version() );
		$error = $this->updater->pre_download( false, FakeApi::BASE . '/v2/plugin/package/0.2.0' );
		$this->assertWPError( $error );
		$this->assertSame( 'inmolink_update_signature', $error->get_error_code() );

		$other = sodium_crypto_sign_keypair();
		$file  = $this->zip;
		$sha   = hash_file( 'sha256', $file );
		$sig   = base64_encode( sodium_crypto_sign_detached( Updater::signing_message( '0.2.0', $sha ), sodium_crypto_sign_secretkey( $other ) ) ); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode
		$this->assertSame( 'inmolink_update_signature', Updater::verify_file( $file, '0.2.0', $sha, $sig )->get_error_code() );
	}
}
