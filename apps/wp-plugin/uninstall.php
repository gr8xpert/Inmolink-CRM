<?php
/**
 * Uninstall: removes the mirror table, options and transients.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin;

if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

require_once __DIR__ . '/src/Autoloader.php';
Autoloader::register( __NAMESPACE__, __DIR__ . '/src' );

Installer::uninstall();
