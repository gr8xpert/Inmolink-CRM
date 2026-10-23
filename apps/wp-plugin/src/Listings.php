<?php
/**
 * Listing search and detail, through the cache layers.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin;

use Inmolink\Plugin\Api\Client;
use Inmolink\Plugin\Api\Response;
use Inmolink\Plugin\Cache\Cache;
use Inmolink\Plugin\Cache\Result;
use Inmolink\Plugin\Mirror\Mirror;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * What templates (and later blocks and shortcodes) call: search pages from the transient cache, detail pages from
 * the mirror table, each falling back to its stale copy when the API cannot be reached.
 */
class Listings {

	/** A mirror row older than this is revalidated on view (a safety net; the delta sync normally keeps it fresh). */
	public const MIRROR_MAX_AGE = DAY_IN_SECONDS;

	private const UUID    = '/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/';
	private const CURSOR  = '/^[A-Za-z0-9_-]{1,200}$/';
	private const REF     = '/^\S{1,64}$/';
	private const SORTS   = array( 'newest', 'price_asc', 'price_desc', 'beds_desc', 'area_desc' );
	private const STATUS  = array( 'ACTIVE', 'UNDER_OFFER', 'AVAILABLE', 'RESERVED' );
	private const TXN     = array( 'SALE', 'RENT_LONG_TERM', 'RENT_SHORT_TERM' );
	private const KINDS   = array( 'LISTING', 'UNIT' );
	private const FACETS  = array( 'propertyTypeId', 'locationIds', 'featureIds', 'beds', 'transactionType' );
	private const INT_MAX = 9007199254740991;

	/**
	 * Creates the service.
	 *
	 * @param Client $client API client.
	 * @param Cache  $cache  Transient cache.
	 * @param Mirror $mirror Mirror table.
	 */
	public function __construct(
		private readonly Client $client,
		private readonly Cache $cache,
		private readonly Mirror $mirror
	) {}

	/**
	 * The service wired from the settings.
	 */
	public static function from_settings(): self {
		$client = Client::from_settings();
		return new self( $client, new Cache( $client ), new Mirror() );
	}

	/**
	 * A search page (`GET /v2/listings`), cached for the settings' TTL.
	 *
	 * @param array<string,mixed> $args Raw search arguments (shortcode attributes, query vars); unknown or invalid
	 *                                  values are dropped.
	 */
	public function search( array $args ): ?Result {
		$query = self::search_query( $args );
		// Free-text searches and deep pages are not kept as stale fallbacks (unbounded key space).
		return $this->cache->get( '/v2/listings', $query, ! isset( $query['q'] ) && ! isset( $query['cursor'] ) );
	}

	/**
	 * A detail page (`GET /v2/listings/{ref}`) from the mirror table; fetched (and mirrored) when missing or old.
	 *
	 * @param string      $ref  Reference.
	 * @param string|null $lang Locale (defaults to the site's).
	 */
	public function detail( string $ref, ?string $lang = null ): ?Result {
		if ( ! preg_match( self::REF, $ref ) ) {
			return null;
		}
		$lang = Settings::resolve_locale( $lang );
		$row  = $this->mirror->find( $ref, $lang );
		$now  = time();

		if ( null !== $row && $row['fetched_at'] > $now - self::MIRROR_MAX_AGE ) {
			return new Result( $row['payload'], $row['fetched_at'], false );
		}

		$response = $this->client->get( '/v2/listings/' . rawurlencode( $ref ), array( 'lang' => $lang ), $row['etag'] ?? null );

		if ( $response->ok() ) {
			$this->mirror->upsert( $ref, $lang, $response->body, $response->etag );
			return new Result( $response->body, $now, false );
		}
		if ( Response::NOT_MODIFIED === $response->kind && null !== $row ) {
			$this->mirror->touch( $ref, $lang );
			return new Result( $row['payload'], $now, false );
		}
		if ( Response::NOT_FOUND === $response->kind ) {
			$this->mirror->delete( $ref, $lang );
			return null;
		}
		return null !== $row ? new Result( $row['payload'], $row['fetched_at'], true ) : null;
	}

	/**
	 * Sanitizes search arguments into a `/v2/listings` query (the contract's `WebsiteListingQuery` rules).
	 *
	 * @param array<string,mixed> $args Raw arguments.
	 * @return array<string,mixed>
	 */
	public static function search_query( array $args ): array {
		$q = array( 'lang' => Settings::resolve_locale( self::str( $args, 'lang' ) ) );

		$text = self::str( $args, 'q' );
		if ( null !== $text ) {
			$text = mb_substr( trim( sanitize_text_field( $text ) ), 0, 100 );
			if ( '' !== $text ) {
				$q['q'] = $text;
			}
		}
		foreach ( array(
			'kind'        => self::KINDS,
			'transaction' => self::TXN,
			'sort'        => self::SORTS,
		) as $name => $allowed ) {
			$value = self::str( $args, $name );
			if ( null !== $value && in_array( $value, $allowed, true ) ) {
				$q[ $name ] = $value;
			}
		}
		foreach ( array(
			'status' => self::STATUS,
			'facets' => self::FACETS,
		) as $name => $allowed ) {
			$list = array_values( array_intersect( self::list_of( $args, $name ), $allowed ) );
			if ( array() !== $list ) {
				$q[ $name ] = array_values( array_unique( $list ) );
			}
		}
		foreach ( array(
			'types'     => 50,
			'locations' => 50,
			'features'  => 20,
		) as $name => $max ) {
			$ids = array_values( array_filter( self::list_of( $args, $name ), static fn ( string $v ): bool => 1 === preg_match( self::UUID, $v ) ) );
			if ( array() !== $ids ) {
				$q[ $name ] = array_slice( array_values( array_unique( $ids ) ), 0, $max );
			}
		}
		$dev_id = self::str( $args, 'developmentId' );
		if ( null !== $dev_id && preg_match( self::UUID, $dev_id ) ) {
			$q['developmentId'] = $dev_id;
		}
		$dev = self::str( $args, 'development' );
		if ( null !== $dev && preg_match( self::REF, $dev ) ) {
			$q['development'] = $dev;
		}
		foreach ( array(
			'priceMin' => self::INT_MAX,
			'priceMax' => self::INT_MAX,
			'bedsMin'  => 50,
			'bathsMin' => 50,
			'limit'    => 100,
		) as $name => $max ) {
			if ( isset( $args[ $name ] ) && is_numeric( $args[ $name ] ) ) {
				$q[ $name ] = max( 'limit' === $name ? 1 : 0, min( $max, (int) $args[ $name ] ) );
			}
		}
		foreach ( array( 'areaMin', 'areaMax' ) as $name ) {
			if ( isset( $args[ $name ] ) && is_numeric( $args[ $name ] ) ) {
				$q[ $name ] = max( 0, min( 1000000, (float) $args[ $name ] ) );
			}
		}
		$bbox = self::list_of( $args, 'bbox' );
		if ( 4 === count( $bbox ) && 4 === count( array_filter( $bbox, 'is_numeric' ) ) ) {
			$b = array_map( 'floatval', $bbox );
			if ( abs( $b[0] ) <= 90 && abs( $b[2] ) <= 90 && abs( $b[1] ) <= 180 && abs( $b[3] ) <= 180 ) {
				$q['bbox'] = $b;
			}
		}
		$cursor = self::str( $args, 'cursor' );
		if ( null !== $cursor && preg_match( self::CURSOR, $cursor ) ) {
			$q['cursor'] = $cursor;
		}
		return $q;
	}

	/**
	 * A scalar argument as a string.
	 *
	 * @param array<string,mixed> $args Arguments.
	 * @param string              $name Name.
	 */
	private static function str( array $args, string $name ): ?string {
		return isset( $args[ $name ] ) && is_scalar( $args[ $name ] ) ? (string) $args[ $name ] : null;
	}

	/**
	 * A list argument (array or comma-separated string) as trimmed strings.
	 *
	 * @param array<string,mixed> $args Arguments.
	 * @param string              $name Name.
	 * @return list<string>
	 */
	private static function list_of( array $args, string $name ): array {
		if ( ! isset( $args[ $name ] ) ) {
			return array();
		}
		$raw = is_array( $args[ $name ] ) ? $args[ $name ] : explode( ',', (string) $args[ $name ] );
		$out = array();
		foreach ( $raw as $item ) {
			if ( is_scalar( $item ) && '' !== trim( (string) $item ) ) {
				$out[] = trim( (string) $item );
			}
		}
		return $out;
	}
}
