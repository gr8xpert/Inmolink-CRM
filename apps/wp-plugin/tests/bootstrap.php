<?php
/**
 * PHPUnit bootstrap: the WordPress test suite (wp-phpunit) with the plugin loaded as a must-use plugin.
 *
 * @package Inmolink
 */

$inmolink_root = dirname( __DIR__ );

require $inmolink_root . '/vendor/autoload.php';

putenv( 'WP_PHPUNIT__TESTS_CONFIG=' . __DIR__ . '/wp-tests-config.php' );

// A release signing key pair for the update tests: the plugin pins the public half, the tests sign with the secret.
$inmolink_signing = sodium_crypto_sign_keypair();
// phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode -- a test public key.
define( 'INMOLINK_UPDATE_PUBLIC_KEY', base64_encode( sodium_crypto_sign_publickey( $inmolink_signing ) ) );
define( 'INMOLINK_TEST_SIGNING_SECRET', sodium_crypto_sign_secretkey( $inmolink_signing ) );
@mkdir( sys_get_temp_dir() . '/inmolink-wp-content/plugins', 0777, true ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
define( 'WP_TESTS_PHPUNIT_POLYFILLS_PATH', $inmolink_root . '/vendor/yoast/phpunit-polyfills' );

$inmolink_tests_dir = getenv( 'WP_PHPUNIT__DIR' );
require $inmolink_tests_dir . '/includes/functions.php';

tests_add_filter(
	'muplugins_loaded',
	static function () use ( $inmolink_root ): void {
		require $inmolink_root . '/inmolink.php';
		\Inmolink\Plugin\Installer::activate();
	}
);

require $inmolink_tests_dir . '/includes/bootstrap.php';
require __DIR__ . '/Support/FakeApi.php';
require __DIR__ . '/Support/TestCase.php';
