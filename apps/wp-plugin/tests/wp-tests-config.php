<?php
/**
 * WordPress test suite configuration (throwaway MariaDB from docker-compose.test.yml).
 *
 * @package Inmolink
 */

define( 'ABSPATH', dirname( __DIR__ ) . '/vendor/roots/wordpress-no-content/' );
// The no-content WordPress build has no wp-content: plugins installed by the update test live in a scratch folder.
define( 'WP_CONTENT_DIR', sys_get_temp_dir() . '/inmolink-wp-content' );
define( 'FS_METHOD', 'direct' );
define( 'WP_DEFAULT_THEME', 'default' );
define( 'WP_DEBUG', true );

define( 'DB_NAME', getenv( 'WP_TESTS_DB_NAME' ) ?: 'wp_tests' );
define( 'DB_USER', getenv( 'WP_TESTS_DB_USER' ) ?: 'root' );
define( 'DB_PASSWORD', getenv( 'WP_TESTS_DB_PASSWORD' ) ?: 'root' );
define( 'DB_HOST', getenv( 'WP_TESTS_DB_HOST' ) ?: '127.0.0.1' );
define( 'DB_CHARSET', 'utf8mb4' );
define( 'DB_COLLATE', '' );

$table_prefix = 'wptests_'; // phpcs:ignore WordPress.WP.GlobalVariablesOverride.Prohibited

define( 'WP_TESTS_DOMAIN', 'example.org' );
define( 'WP_TESTS_EMAIL', 'admin@example.org' );
define( 'WP_TESTS_TITLE', 'Inmolink Tests' );
define( 'WP_PHP_BINARY', 'php' );
define( 'WPLANG', '' );

// Production-like: no local API opt-in (Settings::sanitize_base_for() covers the opted-in branch).
define( 'INMOLINK_ALLOW_LOCAL_API', false );
