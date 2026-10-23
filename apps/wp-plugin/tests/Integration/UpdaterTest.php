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
	 * @param string|null $served_changelog Changelog served when it differs from the signed one (default: as signed).
	 */
	private function serve( string $version, string $bytes, ?string $signed_version = null, ?string $signed_bytes = null, ?string $served_changelog = null ): void {
		$sha       = hash( 'sha256', $signed_bytes ?? $bytes );
		$changelog = "Signed updates.\n<script>alert(1)</script>";
		$meta      = array(
			'version'     => $signed_version ?? $version,
			'sha256'      => $sha,
			'requires'    => '6.4',
			'requiresPhp' => '8.1',
			'tested'      => '6.8',
			'releasedAt'  => '2026-10-23T10:00:00.000Z',
			'changelog'   => $changelog,
		);
		$sig       = sodium_crypto_sign_detached( Updater::signing_message( $meta ), INMOLINK_TEST_SIGNING_SECRET );
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
					'changelog'   => $served_changelog ?? $changelog,
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
		$this->assertSame( 'inmolink_update_unknown', $error->get_error_code(), 'a signature that does not cover the metadata is refused before any download' );

		$other = sodium_crypto_sign_keypair();
		$file  = $this->zip;
		$meta  = array(
			'version'     => '0.2.0',
			'sha256'      => hash_file( 'sha256', $file ),
			'requires'    => '6.4',
			'requiresPhp' => '8.1',
			'tested'      => '6.8',
			'releasedAt'  => '2026-10-23T10:00:00.000Z',
			'changelog'   => 'x',
		);
		$meta['signature'] = base64_encode( sodium_crypto_sign_detached( Updater::signing_message( $meta ), sodium_crypto_sign_secretkey( $other ) ) ); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode
		$this->assertSame( 'inmolink_update_signature', Updater::verify_file( $file, $meta )->get_error_code() );
	}

	/**
	 * Metadata for a release signed with the test key.
	 *
	 * @param string $version     Version.
	 * @param string $released_at Release date.
	 * @param array<string,string> $over Field overrides (signed as given).
	 * @return array<string,string>
	 */
	private function signed_meta( string $version, string $released_at, array $over = array() ): array {
		$meta              = array_merge(
			array(
				'version'     => $version,
				'sha256'      => hash( 'sha256', $version ),
				'requires'    => '6.4',
				'requiresPhp' => '8.1',
				'tested'      => '6.8',
				'releasedAt'  => $released_at,
				'changelog'   => 'Notes',
			),
			$over
		);
		$meta['signature'] = base64_encode( sodium_crypto_sign_detached( Updater::signing_message( $meta ), INMOLINK_TEST_SIGNING_SECRET ) ); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode
		$meta['package']   = '/v2/plugin/package/' . $version;
		return $meta;
	}

	/**
	 * [S9-F3] Cross-language vector: the same fields give the same bytes as the TypeScript signing code, and its
	 * signature (made with a fixed test key in service.test.ts) verifies here.
	 */
	public function test_s9_f3_signing_message_matches_the_typescript_vector(): void {
		$message = Updater::signing_message(
			array(
				'version'     => '1.2.3',
				'sha256'      => str_repeat( 'ab', 32 ),
				'requires'    => '6.4',
				'requiresPhp' => '8.1',
				'tested'      => '6.8',
				'releasedAt'  => '2026-10-23T10:00:00.000Z',
				'changelog'   => "Línea 1\n日本語 — ñ 😀\n\n\"quoted\" <b>",
			)
		);
		$this->assertSame( '696e6d6f6c696e6b2d77702d706c7567696e2f76320a353a312e322e332c36343a616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261622c333a362e342c333a382e312c333a362e382c32343a323032362d31302d32335431303a30303a30302e3030305a2c34343a4cc3ad6e656120310ae697a5e69cace8aa9e20e2809420c3b120f09f98800a0a2271756f74656422203c623e2c', bin2hex( $message ) );
		// phpcs:disable WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_decode -- fixed test vector.
		$this->assertTrue( sodium_crypto_sign_verify_detached( base64_decode( 'A/d4bTu14ziH7t81U4xMWluxqxCYajJ99lvpQt8Dmf5KWViQk9W14vgbHvm30CIlOpYU5WX250lHeclkXcBdAQ==' ), $message, base64_decode( 'A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=' ) ) );
		// phpcs:enable
	}

	/**
	 * [S9-F3] A present-but-malformed signed field (even one that is signed as served, like a trailing newline) rejects
	 * the manifest.
	 */
	public function test_s9_f3_malformed_signed_field_rejects_the_manifest(): void {
		foreach ( array(
			'requires'   => "6.4\n",
			'tested'     => 'latest',
			'releasedAt' => "2026-10-23T10:00:00.000Z\n",
		) as $field => $bad ) {
			$meta           = $this->signed_meta( '0.2.0', '2026-10-23T10:00:00.000Z', array( $field => $bad ) );
			$this->api->on( '/v2/plugin/update', array( 'body' => $meta + array( 'slug' => 'inmolink' ) ) );
			$this->assertNull( $this->updater->info( true ), $field );
		}
	}

	/**
	 * [S9-F3] The replay floor includes the installed version: a signed manifest older than what runs offers nothing.
	 */
	public function test_s9_f3_floor_is_the_installed_version(): void {
		$installed = new Updater( self::BASENAME, '0.5.0' );
		$this->api->on( '/v2/plugin/update', array( 'body' => $this->signed_meta( '0.4.0', '2026-09-01T10:00:00.000Z' ) + array( 'slug' => 'inmolink' ) ) );
		$this->assertNull( $installed->info( true ) );
		$this->assertSame( '0.4.0 < 0.5.0', \Inmolink\Plugin\Admin\Health::report()['update_replay'] );
	}

	/**
	 * [S9-F3] A manifest whose changelog (or requirements, or date) was altered after signing offers no update.
	 */
	public function test_s9_f3_altered_changelog_offers_no_update(): void {
		$bytes = (string) file_get_contents( $this->zip );
		$this->serve( '0.2.0', $bytes, null, null, 'Totally legit notes. Click <a href="https://evil.example">here</a>.' );
		$transient          = new \stdClass();
		$transient->checked = array( self::BASENAME => '0.1.0' );
		$offer              = $this->updater->filter_update_transient( $transient );
		$this->assertArrayNotHasKey( self::BASENAME, (array) ( $offer->response ?? array() ) );
		$this->assertNull( $this->updater->plugins_api( null, 'plugin_information', (object) array( 'slug' => 'inmolink' ) ) );
		$this->assertNotTrue( $this->upgrade() );
		$this->assertSame( '0.1.0', self::installed_version() );

		// The untouched manifest is offered.
		delete_site_transient( Updater::INFO_TRANSIENT );
		$this->serve( '0.2.0', $bytes );
		$transient          = new \stdClass();
		$transient->checked = array( self::BASENAME => '0.1.0' );
		$this->assertSame( '0.2.0', $this->updater->filter_update_transient( $transient )->response[ self::BASENAME ]->new_version );
	}

	/**
	 * [S9-F3] [S8-F27] A replayed older (validly signed) manifest offers no update once a newer version was seen, and
	 * the health page flags it.
	 */
	public function test_s9_f3_replayed_older_manifest_is_refused_and_flagged(): void {
		$this->api->on( '/v2/plugin/update', array( 'body' => $this->signed_meta( '0.3.0', '2026-10-23T10:00:00.000Z' ) + array( 'slug' => 'inmolink' ) ) );
		$this->assertSame( '0.3.0', $this->updater->info( true )['version'] );
		$this->assertSame( '', \Inmolink\Plugin\Admin\Health::report()['update_replay'] );

		// An attacker replays the older signed manifest: no update for a site on 0.1.0, and a flag.
		$this->api->on( '/v2/plugin/update', array( 'body' => $this->signed_meta( '0.2.0', '2026-09-01T10:00:00.000Z' ) + array( 'slug' => 'inmolink' ) ) );
		$this->assertNull( $this->updater->info( true ) );
		$transient          = new \stdClass();
		$transient->checked = array( self::BASENAME => '0.1.0' );
		$this->assertArrayNotHasKey( self::BASENAME, (array) ( $this->updater->filter_update_transient( $transient )->response ?? array() ) );
		$this->assertSame( '0.2.0 < 0.3.0', \Inmolink\Plugin\Admin\Health::report()['update_replay'] );

		// The real latest clears the flag.
		$this->api->on( '/v2/plugin/update', array( 'body' => $this->signed_meta( '0.3.0', '2026-10-23T10:00:00.000Z' ) + array( 'slug' => 'inmolink' ) ) );
		$this->assertSame( '0.3.0', $this->updater->info( true )['version'] );
		$this->assertSame( '', \Inmolink\Plugin\Admin\Health::report()['update_replay'] );
	}

	/**
	 * [S8-05] A package from anywhere else offered for this plugin (e.g. wordpress.org for a same-named plugin) is
	 * refused — single, bulk and automatic updates alike — while other plugins' downloads are left alone.
	 */
	public function test_s8_05_foreign_package_for_our_plugin_is_refused(): void {
		$foreign = 'https://downloads.wordpress.org/plugin/inmolink.9.9.9.zip';
		foreach ( array(
			array( 'plugin' => self::BASENAME ),
			array( 'plugins' => array( 'other/other.php', self::BASENAME ) ),
		) as $extra ) {
			$error = $this->updater->pre_download( false, $foreign, null, $extra );
			$this->assertWPError( $error );
			$this->assertSame( 'inmolink_update_foreign', $error->get_error_code() );
		}
		$skin         = new \Automatic_Upgrader_Skin();
		$skin->plugin = self::BASENAME;
		$this->assertWPError( $this->updater->pre_download( false, $foreign, new \Plugin_Upgrader( $skin ), array() ) );
		$this->assertSame( 'untouched', $this->updater->pre_download( 'untouched', 'https://downloads.wordpress.org/plugin/akismet.zip', null, array( 'plugin' => 'akismet/akismet.php' ) ) );

		// End to end: a foreign offer written straight into the transient (bypassing our filter) installs nothing.
		$transient           = new \stdClass();
		$transient->checked  = array( self::BASENAME => '0.1.0' );
		$transient->response = array(
			self::BASENAME => (object) array(
				'slug'        => 'inmolink',
				'plugin'      => self::BASENAME,
				'new_version' => '9.9.9',
				'package'     => $foreign,
			),
		);
		update_site_option( '_site_transient_update_plugins', $transient );
		wp_cache_delete( 'update_plugins', 'site-transient' );
		$level = ob_get_level();
		try {
			$result = ( new \Plugin_Upgrader( new \Automatic_Upgrader_Skin() ) )->upgrade( self::BASENAME );
		} finally {
			while ( ob_get_level() > $level ) {
				ob_end_clean();
			}
		}
		$this->assertNotTrue( $result );
		$this->assertSame( '0.1.0', self::installed_version() );
	}

	/**
	 * [S8-05] Offers for this plugin from other sources are removed from the update transient (also with no release).
	 */
	public function test_s8_05_foreign_transient_entries_are_removed(): void {
		$this->api->on( '/v2/plugin/update', array( 'status' => 404 ) );
		$transient            = new \stdClass();
		$transient->checked   = array( self::BASENAME => '0.1.0' );
		$transient->response  = array(
			self::BASENAME   => (object) array( 'package' => 'https://downloads.wordpress.org/plugin/inmolink.zip' ),
			'other/other.php' => (object) array( 'package' => 'https://downloads.wordpress.org/plugin/other.zip' ),
		);
		$transient->no_update = array( self::BASENAME => (object) array( 'package' => 'https://downloads.wordpress.org/plugin/inmolink.zip' ) );

		$filtered = $this->updater->filter_update_transient( $transient );
		$this->assertArrayNotHasKey( self::BASENAME, $filtered->response );
		$this->assertArrayNotHasKey( self::BASENAME, $filtered->no_update );
		$this->assertArrayHasKey( 'other/other.php', $filtered->response, 'other plugins untouched' );
	}

	/**
	 * [S8-05] The plugin header names its update server (`Update URI`), so WordPress never asks wordpress.org about it.
	 */
	public function test_s8_05_update_uri_header(): void {
		$data = get_plugin_data( \Inmolink\Plugin\PLUGIN_FILE, false, false );
		$this->assertSame( 'https://feed.inmolink.es', $data['UpdateURI'] );
		$this->assertSame( \Inmolink\Plugin\Settings::DEFAULT_API_BASE, $data['UpdateURI'] );
	}
}
