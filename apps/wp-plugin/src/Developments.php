<?php
/**
 * New-build developments through the cache.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin;

use Inmolink\Plugin\Api\Client;
use Inmolink\Plugin\Cache\Cache;
use Inmolink\Plugin\Cache\Result;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * `/v2/developments`, `/v2/developments/{ref}` and its units, from the transient cache with the stale fallback.
 */
class Developments {

	private const UUID   = '/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/';
	private const REF    = Listings::REF_PATTERN;
	private const CURSOR = '/^[A-Za-z0-9_-]{1,200}$/';

	/**
	 * Creates the service.
	 *
	 * @param Cache $cache Transient cache.
	 */
	public function __construct( private readonly Cache $cache ) {}

	/**
	 * The service wired from the settings.
	 */
	public static function from_settings(): self {
		return new self( new Cache( Client::from_settings() ) );
	}

	/**
	 * A page of developments.
	 *
	 * @param array<string,mixed> $args `lang`, `locations` (UUID list or CSV), `limit` (1–100), `cursor`.
	 */
	public function list( array $args ): ?Result {
		$query = array( 'lang' => Settings::resolve_locale( isset( $args['lang'] ) && is_string( $args['lang'] ) ? $args['lang'] : null ) );
		$raw   = $args['locations'] ?? array();
		$ids   = array_values( array_filter( array_map( 'trim', is_array( $raw ) ? array_map( 'strval', $raw ) : explode( ',', (string) $raw ) ), static fn ( string $v ): bool => 1 === preg_match( self::UUID, $v ) ) );
		if ( array() !== $ids ) {
			$query['locations'] = array_slice( array_values( array_unique( $ids ) ), 0, 50 );
		}
		if ( isset( $args['limit'] ) && is_numeric( $args['limit'] ) ) {
			$query['limit'] = max( 1, min( 100, (int) $args['limit'] ) );
		}
		$cursor = isset( $args['cursor'] ) && is_string( $args['cursor'] ) ? $args['cursor'] : '';
		if ( preg_match( self::CURSOR, $cursor ) ) {
			$query['cursor'] = $cursor;
		}
		return $this->cache->get( '/v2/developments', $query, ! isset( $query['cursor'] ) );
	}

	/**
	 * One development.
	 *
	 * @param string $ref    Development reference.
	 * @param string $locale API locale.
	 */
	public function detail( string $ref, string $locale ): ?Result {
		if ( ! preg_match( self::REF, $ref ) ) {
			return null;
		}
		return $this->cache->get( '/v2/developments/' . rawurlencode( $ref ), array( 'lang' => Settings::resolve_locale( $locale ) ) );
	}

	/**
	 * The first page of a development's units.
	 *
	 * @param string $ref    Development reference.
	 * @param string $locale API locale.
	 */
	public function units( string $ref, string $locale ): ?Result {
		if ( ! preg_match( self::REF, $ref ) ) {
			return null;
		}
		return $this->cache->get(
			'/v2/developments/' . rawurlencode( $ref ) . '/units',
			array(
				'lang'  => Settings::resolve_locale( $locale ),
				'limit' => 100,
			)
		);
	}
}
