<?php
/**
 * S8-F17: warn when the WordPress salts live in the database.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\Tests\Integration;

use Inmolink\Plugin\Admin\SaltNotice;
use Inmolink\Plugin\Tests\TestCase;

/**
 * The notice that tells administrators the API key's encryption salts are not in wp-config.php.
 */
final class SaltNoticeTest extends TestCase {

	/**
	 * Output of the notice for the current user.
	 */
	private function notice(): string {
		ob_start();
		SaltNotice::render();
		return (string) ob_get_clean();
	}

	/**
	 * [S8-F17] Shows with database salts (no constants, or WordPress's placeholder); not with wp-config salts or for
	 * users who cannot manage options.
	 */
	public function test_s8_f17_notice_shows_only_with_database_salts(): void {
		wp_set_current_user( self::factory()->user->create( array( 'role' => 'administrator' ) ) );

		$this->assertTrue( SaltNotice::in_database(), 'the test config defines no salts' );
		$this->assertStringContainsString( 'stored in the database', $this->notice() );

		add_filter(
			'inmolink_wp_config_salts',
			static fn () => array(
				'AUTH_KEY'  => 'put your unique phrase here',
				'AUTH_SALT' => 'k3j4h5k34j5h',
			)
		);
		$this->assertStringContainsString( 'notice-warning', $this->notice(), 'the placeholder counts as unset' );

		remove_all_filters( 'inmolink_wp_config_salts' );
		add_filter(
			'inmolink_wp_config_salts',
			static fn () => array(
				'AUTH_KEY'  => 'a-long-random-key-from-wp-config',
				'AUTH_SALT' => 'a-long-random-salt-from-wp-config',
			)
		);
		$this->assertFalse( SaltNotice::in_database() );
		$this->assertSame( '', $this->notice() );

		// Like wp_salt(): the same value in two of the eight constants counts as unset.
		remove_all_filters( 'inmolink_wp_config_salts' );
		add_filter(
			'inmolink_wp_config_salts',
			static fn () => array(
				'AUTH_KEY'         => 'unique-1-auth-key',
				'SECURE_AUTH_KEY'  => 'unique-2',
				'LOGGED_IN_KEY'    => 'unique-3',
				'NONCE_KEY'        => 'unique-4',
				'AUTH_SALT'        => 'unique-5',
				'SECURE_AUTH_SALT' => 'unique-6',
				'LOGGED_IN_SALT'   => 'unique-7',
				'NONCE_SALT'       => 'unique-8',
			)
		);
		$this->assertFalse( SaltNotice::in_database(), 'eight different values' );
		remove_all_filters( 'inmolink_wp_config_salts' );
		add_filter(
			'inmolink_wp_config_salts',
			static fn () => array(
				'AUTH_KEY'         => 'unique-1-auth-key',
				'SECURE_AUTH_KEY'  => 'unique-2',
				'LOGGED_IN_KEY'    => 'unique-3',
				'NONCE_KEY'        => 'unique-4',
				'AUTH_SALT'        => 'unique-5',
				'SECURE_AUTH_SALT' => 'unique-6',
				'LOGGED_IN_SALT'   => 'unique-7',
				'NONCE_SALT'       => 'unique-5',
			)
		);
		$this->assertTrue( SaltNotice::in_database(), 'AUTH_SALT repeated in NONCE_SALT' );

		remove_all_filters( 'inmolink_wp_config_salts' );
		wp_set_current_user( self::factory()->user->create( array( 'role' => 'editor' ) ) );
		$this->assertSame( '', $this->notice(), 'editors never see it' );
	}
}
