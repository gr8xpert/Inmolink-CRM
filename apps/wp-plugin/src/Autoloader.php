<?php
/**
 * Bundled PSR-4 autoloader (no runtime Composer dependency).
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Maps `Inmolink\Plugin\Foo\Bar` to `src/Foo/Bar.php`.
 */
final class Autoloader {

	/**
	 * Registers the autoloader for one namespace prefix.
	 *
	 * @param string $prefix Namespace prefix, without the trailing backslash.
	 * @param string $dir    Directory holding the prefix's classes.
	 */
	public static function register( string $prefix, string $dir ): void {
		$prefix = rtrim( $prefix, '\\' ) . '\\';
		$dir    = rtrim( $dir, '/\\' ) . '/';
		spl_autoload_register(
			static function ( string $class_name ) use ( $prefix, $dir ): void {
				if ( 0 !== strncmp( $class_name, $prefix, strlen( $prefix ) ) ) {
					return;
				}
				$relative = substr( $class_name, strlen( $prefix ) );
				if ( ! preg_match( '/^[A-Za-z0-9_\\\\]+$/', $relative ) ) {
					return;
				}
				$file = $dir . str_replace( '\\', '/', $relative ) . '.php';
				if ( is_file( $file ) ) {
					require_once $file;
				}
			}
		);
	}
}
