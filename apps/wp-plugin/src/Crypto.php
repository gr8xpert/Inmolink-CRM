<?php
/**
 * Encryption of the stored API secret key.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Seals a secret with libsodium (XSalsa20-Poly1305) under a key derived from the site's WordPress salts, so a
 * database dump alone does not reveal the API key. When the salts change the secret cannot be opened any more and
 * reads as unset: the admin enters the key again.
 */
final class Crypto {

	private const PREFIX = 'v1:';

	/**
	 * Encrypts a secret.
	 *
	 * @param string $plain The secret.
	 * @return string `v1:` + base64(nonce . ciphertext).
	 */
	public static function seal( string $plain ): string {
		$nonce = random_bytes( SODIUM_CRYPTO_SECRETBOX_NONCEBYTES );
		$box   = sodium_crypto_secretbox( $plain, $nonce, self::key() );
		// phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode -- binary ciphertext, not obfuscation.
		return self::PREFIX . base64_encode( $nonce . $box );
	}

	/**
	 * Decrypts a secret sealed by {@see seal()}.
	 *
	 * @param string $sealed The stored value.
	 * @return string|null The secret, or null when it cannot be opened (tampered, other salts, not sealed).
	 */
	public static function open( string $sealed ): ?string {
		if ( 0 !== strncmp( $sealed, self::PREFIX, strlen( self::PREFIX ) ) ) {
			return null;
		}
		// phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_decode -- binary ciphertext, not obfuscation.
		$raw = base64_decode( substr( $sealed, strlen( self::PREFIX ) ), true );
		if ( false === $raw || strlen( $raw ) <= SODIUM_CRYPTO_SECRETBOX_NONCEBYTES ) {
			return null;
		}
		$nonce = substr( $raw, 0, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES );
		$box   = substr( $raw, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES );
		$plain = sodium_crypto_secretbox_open( $box, $nonce, self::key() );
		return false === $plain ? null : $plain;
	}

	/**
	 * The 32-byte key, derived from the site's salts.
	 */
	private static function key(): string {
		return sodium_crypto_generichash( wp_salt( 'auth' ) . '|inmolink-api-key', '', SODIUM_CRYPTO_SECRETBOX_KEYBYTES );
	}
}
