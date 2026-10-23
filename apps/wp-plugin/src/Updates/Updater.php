<?php
/**
 * Signed self-updates from the Inmolink update server.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\Updates;

use Inmolink\Plugin\Settings;
use const Inmolink\Plugin\PLUGIN_FILE;
use const Inmolink\Plugin\VERSION;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Offers new versions from `{API base}/v2/plugin/update` to WordPress (`pre_set_site_transient_update_plugins`,
 * `plugins_api`) and, before WordPress unpacks a package, downloads it itself and checks its SHA-256 and its Ed25519
 * signature over `inmolink-wp-plugin\n{version}\n{sha256}` with the pinned public key ({@see PUBLIC_KEY}, or
 * `INMOLINK_UPDATE_PUBLIC_KEY` in wp-config.php). A package that fails either check is refused, so a compromised
 * update channel or storage cannot ship code. No public key pinned → no updates are installed. Never phones home with
 * visitor data: the request carries only the plugin version.
 */
class Updater {

	public const SLUG = 'inmolink';
	/**
	 * The release signing public key (Ed25519, raw 32 bytes, base64). Empty until the signing key is generated
	 * (HUMAN-ACTIONS H18); `pnpm ops:wp-plugin-release` prints the value to pin here.
	 */
	public const PUBLIC_KEY      = '';
	public const INFO_TRANSIENT  = 'inmolink_update_info';
	public const INFO_TTL        = 12 * HOUR_IN_SECONDS;
	public const FAILURE_TTL     = HOUR_IN_SECONDS;
	private const VERSION_FORMAT = '/^\d{1,4}\.\d{1,4}\.\d{1,4}$/';

	/**
	 * Creates the updater.
	 *
	 * @param string $basename        The plugin's basename (`inmolink/inmolink.php`).
	 * @param string $current_version The installed version.
	 */
	public function __construct(
		private readonly string $basename,
		private readonly string $current_version
	) {}

	/**
	 * The updater for this plugin.
	 */
	public static function for_plugin(): self {
		return new self( plugin_basename( PLUGIN_FILE ), VERSION );
	}

	/**
	 * Hooks into WordPress updates.
	 */
	public function register(): void {
		add_filter( 'pre_set_site_transient_update_plugins', array( $this, 'filter_update_transient' ) );
		add_filter( 'plugins_api', array( $this, 'plugins_api' ), 10, 3 );
		add_filter( 'upgrader_pre_download', array( $this, 'pre_download' ), 10, 4 );
		add_filter( 'upgrader_source_selection', array( $this, 'source_selection' ), 10, 4 );
	}

	/**
	 * The pinned public key (raw 32 bytes), or '' when none is pinned.
	 */
	public static function public_key(): string {
		$b64 = defined( 'INMOLINK_UPDATE_PUBLIC_KEY' ) && is_string( INMOLINK_UPDATE_PUBLIC_KEY ) ? INMOLINK_UPDATE_PUBLIC_KEY : self::PUBLIC_KEY;
		// phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_decode -- a public key, not obfuscation.
		$raw = base64_decode( $b64, true );
		return false !== $raw && SODIUM_CRYPTO_SIGN_PUBLICKEYBYTES === strlen( $raw ) ? $raw : '';
	}

	/**
	 * The update server's base URL (the API base).
	 */
	private static function base(): string {
		return (string) Settings::get( 'api_base' );
	}

	/**
	 * The latest release's metadata (cached), or null when unknown.
	 *
	 * @param bool $refresh Ignore the cache.
	 * @return array{version:string,sha256:string,signature:string,package:string,requires:string,requiresPhp:string,tested:string,releasedAt:string,changelog:string}|null
	 */
	public function info( bool $refresh = false ): ?array {
		$cached = get_site_transient( self::INFO_TRANSIENT );
		if ( ! $refresh && is_array( $cached ) ) {
			return isset( $cached['version'] ) ? self::validate( $cached ) : null;
		}
		$base = self::base();
		if ( '' === $base ) {
			return null;
		}
		$response = wp_safe_remote_get(
			$base . '/v2/plugin/update',
			array(
				'timeout'             => 10,
				'redirection'         => 0,
				'limit_response_size' => 65536,
				'reject_unsafe_urls'  => ! Settings::allow_local_api(),
				'headers'             => array(
					'Accept'     => 'application/json',
					'User-Agent' => 'Inmolink-WordPress/' . $this->current_version,
				),
			)
		);
		$body     = ! is_wp_error( $response ) && 200 === (int) wp_remote_retrieve_response_code( $response )
			? json_decode( (string) wp_remote_retrieve_body( $response ), true )
			: null;
		$info     = is_array( $body ) ? self::validate( $body ) : null;
		set_site_transient( self::INFO_TRANSIENT, $info ?? array( 'failed' => time() ), null !== $info ? self::INFO_TTL : self::FAILURE_TTL );
		return $info;
	}

	/**
	 * Keeps only well-formed metadata.
	 *
	 * @param array<string,mixed> $body Decoded JSON.
	 * @return array{version:string,sha256:string,signature:string,package:string,requires:string,requiresPhp:string,tested:string,releasedAt:string,changelog:string}|null
	 */
	private static function validate( array $body ): ?array {
		foreach ( array( 'version', 'sha256', 'signature', 'package' ) as $field ) {
			if ( ! isset( $body[ $field ] ) || ! is_string( $body[ $field ] ) ) {
				return null;
			}
		}
		if ( ! preg_match( self::VERSION_FORMAT, $body['version'] ) || ! preg_match( '/^[0-9a-f]{64}$/', $body['sha256'] )
			|| '/v2/plugin/package/' . $body['version'] !== $body['package'] || ( $body['slug'] ?? self::SLUG ) !== self::SLUG ) {
			return null;
		}
		$text = static fn ( string $k, string $pattern ): string => isset( $body[ $k ] ) && is_string( $body[ $k ] ) && preg_match( $pattern, $body[ $k ] ) ? $body[ $k ] : '';
		$req  = '/^\d{1,2}\.\d{1,2}(\.\d{1,2})?$/';
		return array(
			'version'     => $body['version'],
			'sha256'      => $body['sha256'],
			'signature'   => $body['signature'],
			'package'     => $body['package'],
			'requires'    => $text( 'requires', $req ),
			'requiresPhp' => $text( 'requiresPhp', $req ),
			'tested'      => $text( 'tested', $req ),
			'releasedAt'  => $text( 'releasedAt', '/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/' ),
			'changelog'   => mb_substr( $text( 'changelog', '/^[\s\S]*$/u' ), 0, 4000 ),
		);
	}

	/**
	 * The absolute package URL of a release.
	 *
	 * @param array{package:string} $info Release metadata.
	 */
	private static function package_url( array $info ): string {
		return self::base() . $info['package'];
	}

	/**
	 * `pre_set_site_transient_update_plugins`: offers the latest version when it is newer.
	 *
	 * @param mixed $transient The update transient.
	 * @return mixed
	 */
	public function filter_update_transient( $transient ) {
		if ( ! is_object( $transient ) || empty( $transient->checked ) || '' === self::public_key() ) {
			return $transient;
		}
		$info = $this->info();
		if ( null === $info ) {
			return $transient;
		}
		$item = (object) array(
			'id'           => self::SLUG,
			'slug'         => self::SLUG,
			'plugin'       => $this->basename,
			'new_version'  => $info['version'],
			'url'          => '',
			'package'      => self::package_url( $info ),
			'tested'       => $info['tested'],
			'requires'     => $info['requires'],
			'requires_php' => $info['requiresPhp'],
		);
		if ( version_compare( $info['version'], $this->current_version, '>' ) ) {
			$transient->response                    = is_array( $transient->response ?? null ) ? $transient->response : array();
			$transient->response[ $this->basename ] = $item;
		} else {
			$transient->no_update                    = is_array( $transient->no_update ?? null ) ? $transient->no_update : array();
			$transient->no_update[ $this->basename ] = $item;
		}
		return $transient;
	}

	/**
	 * `plugins_api`: the "View details" modal.
	 *
	 * @param mixed  $result Result so far.
	 * @param string $action API action.
	 * @param object $args   Arguments.
	 * @return mixed
	 */
	public function plugins_api( $result, $action, $args ) {
		if ( 'plugin_information' !== $action || ! is_object( $args ) || self::SLUG !== ( $args->slug ?? '' ) ) {
			return $result;
		}
		$info = $this->info();
		if ( null === $info ) {
			return $result;
		}
		return (object) array(
			'name'          => 'Inmolink',
			'slug'          => self::SLUG,
			'version'       => $info['version'],
			'requires'      => $info['requires'],
			'requires_php'  => $info['requiresPhp'],
			'tested'        => $info['tested'],
			'last_updated'  => $info['releasedAt'],
			'download_link' => self::package_url( $info ),
			'sections'      => array(
				'changelog' => wpautop( esc_html( $info['changelog'] ) ),
			),
		);
	}

	/**
	 * `upgrader_pre_download`: for our package, downloads it and verifies hash and signature before WordPress uses
	 * it. Any failure refuses the update.
	 *
	 * @param mixed  $reply      Short-circuit value.
	 * @param string $package    Package URL.
	 * @param mixed  $upgrader   Upgrader.
	 * @param array  $hook_extra Extra arguments.
	 * @return mixed A local file path, a WP_Error, or `$reply` for other packages.
	 */
	public function pre_download( $reply, $package, $upgrader = null, $hook_extra = array() ) {
		unset( $upgrader, $hook_extra );
		$prefix = self::base() . '/v2/plugin/package/';
		if ( ! is_string( $package ) || '' === self::base() || 0 !== strpos( $package, $prefix ) ) {
			return $reply;
		}
		$info = $this->info();
		if ( null === $info || self::package_url( $info ) !== $package ) {
			// The offer may predate a newer release: ask the server once more.
			$info = $this->info( true );
		}
		if ( null === $info || self::package_url( $info ) !== $package ) {
			return new \WP_Error( 'inmolink_update_unknown', __( 'Unknown Inmolink package.', 'inmolink' ) );
		}
		if ( ! version_compare( $info['version'], $this->current_version, '>' ) ) {
			return new \WP_Error( 'inmolink_update_downgrade', __( 'Refusing to install an older or equal Inmolink version.', 'inmolink' ) );
		}
		require_once ABSPATH . 'wp-admin/includes/file.php';
		$file = download_url( $package, 120 );
		if ( is_wp_error( $file ) ) {
			return $file;
		}
		$error = self::verify_file( $file, $info['version'], $info['sha256'], $info['signature'] );
		if ( null !== $error ) {
			wp_delete_file( $file );
			return $error;
		}
		return $file;
	}

	/**
	 * Checks a downloaded package: its SHA-256 and the signature over slug, version and hash.
	 *
	 * @param string $file      Local file.
	 * @param string $version   Release version.
	 * @param string $sha256    Expected SHA-256 (hex).
	 * @param string $signature Signature (base64).
	 * @return \WP_Error|null Null when the package is authentic.
	 */
	public static function verify_file( string $file, string $version, string $sha256, string $signature ): ?\WP_Error {
		$key = self::public_key();
		if ( '' === $key ) {
			return new \WP_Error( 'inmolink_update_unsigned', __( 'No Inmolink update key is pinned: updates are disabled.', 'inmolink' ) );
		}
		$actual = hash_file( 'sha256', $file );
		if ( false === $actual || ! hash_equals( $sha256, $actual ) ) {
			return new \WP_Error( 'inmolink_update_hash', __( 'The Inmolink package does not match its checksum.', 'inmolink' ) );
		}
		// phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_decode -- a signature, not obfuscation.
		$sig = base64_decode( $signature, true );
		if ( false === $sig || SODIUM_CRYPTO_SIGN_BYTES !== strlen( $sig )
			|| ! sodium_crypto_sign_verify_detached( $sig, self::signing_message( $version, $actual ), $key ) ) {
			return new \WP_Error( 'inmolink_update_signature', __( 'The Inmolink package signature is not valid.', 'inmolink' ) );
		}
		return null;
	}

	/**
	 * The signed message (contracts `pluginSigningMessage`).
	 *
	 * @param string $version Version.
	 * @param string $sha256  SHA-256 hex.
	 */
	public static function signing_message( string $version, string $sha256 ): string {
		return "inmolink-wp-plugin\n" . $version . "\n" . $sha256;
	}

	/**
	 * `upgrader_source_selection`: the package unpacks to `inmolink/`; a site that installed the plugin under another
	 * folder keeps that folder (and stays active).
	 *
	 * @param mixed $source        Unpacked source folder.
	 * @param mixed $remote_source Working folder.
	 * @param mixed $upgrader      Upgrader.
	 * @param array $hook_extra    Extra arguments (`plugin`).
	 * @return mixed
	 */
	public function source_selection( $source, $remote_source, $upgrader = null, $hook_extra = array() ) {
		unset( $upgrader );
		if ( ! is_string( $source ) || ! is_string( $remote_source ) || ( $hook_extra['plugin'] ?? '' ) !== $this->basename ) {
			return $source;
		}
		$folder = dirname( $this->basename );
		if ( '.' === $folder || basename( untrailingslashit( $source ) ) === $folder ) {
			return $source;
		}
		$target = trailingslashit( $remote_source ) . $folder . '/';
		global $wp_filesystem;
		if ( ! $wp_filesystem || ! $wp_filesystem->move( $source, $target, true ) ) {
			return new \WP_Error( 'inmolink_update_folder', __( 'Could not prepare the Inmolink update folder.', 'inmolink' ) );
		}
		return $target;
	}

	/**
	 * Turns WordPress's own automatic updates on for this plugin once, at activation; the site's toggle in the
	 * plugins list decides from then on.
	 */
	public function enable_auto_update_once(): void {
		if ( get_site_option( 'inmolink_auto_update_init' ) ) {
			return;
		}
		$list = (array) get_site_option( 'auto_update_plugins', array() );
		if ( ! in_array( $this->basename, $list, true ) ) {
			$list[] = $this->basename;
			update_site_option( 'auto_update_plugins', $list );
		}
		update_site_option( 'inmolink_auto_update_init', 1 );
	}
}
