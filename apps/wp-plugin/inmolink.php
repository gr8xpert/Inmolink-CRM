<?php
/**
 * Plugin Name: Inmolink
 * Description: Inmolink listings for WordPress, served from the Inmolink website API v2 with a local cache and a stale fallback.
 * Version: 0.2.0
 * Requires at least: 6.4
 * Tested up to: 6.8
 * Requires PHP: 8.1
 * Update URI: https://feed.inmolink.es
 * Author: Inmolink
 * License: GPL-2.0-or-later
 * Text Domain: inmolink
 * Domain Path: /languages
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

const VERSION     = '0.2.0';
const PLUGIN_FILE = __FILE__;

require_once __DIR__ . '/src/Autoloader.php';
Autoloader::register( __NAMESPACE__, __DIR__ . '/src' );

register_activation_hook( __FILE__, array( Installer::class, 'activate' ) );
register_deactivation_hook( __FILE__, array( Installer::class, 'deactivate' ) );

Plugin::instance()->boot();
