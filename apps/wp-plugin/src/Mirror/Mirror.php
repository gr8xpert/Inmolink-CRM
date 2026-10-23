<?php
/**
 * Local mirror table of listing detail pages.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\Mirror;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * `{prefix}inmolink_listings`: one row per (reference, locale) holding the `/v2/listings/{ref}` body. Detail pages
 * render from it; the delta sync keeps it current; when the API is down it is what visitors see.
 *
 * Every write is an idempotent upsert or delete keyed by (ref, lang), so replaying changes leaves the same state.
 */
class Mirror {

	public const SCHEMA_VERSION = '1';
	public const VERSION_OPTION = 'inmolink_mirror_schema';
	/** Largest number of references per `IN (…)` list. */
	private const CHUNK = 500;

	/**
	 * The table name.
	 */
	public static function table(): string {
		global $wpdb;
		return $wpdb->prefix . 'inmolink_listings';
	}

	/**
	 * Creates or upgrades the table with dbDelta.
	 */
	public static function install(): void {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		$table   = self::table();
		$charset = $wpdb->get_charset_collate();
		// dbDelta format: two spaces after PRIMARY KEY, one column per line.
		dbDelta(
			"CREATE TABLE {$table} (
  id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  ref varchar(64) NOT NULL,
  lang varchar(5) NOT NULL,
  kind varchar(10) NOT NULL,
  slug varchar(191) NOT NULL DEFAULT '',
  payload longtext NOT NULL,
  etag varchar(128) DEFAULT NULL,
  changed_at datetime DEFAULT NULL,
  fetched_at datetime NOT NULL,
  sweep int(10) unsigned NOT NULL DEFAULT 0,
  PRIMARY KEY  (id),
  UNIQUE KEY ref_lang (ref,lang),
  KEY slug_lang (slug(180),lang)
) {$charset};"
		);
		update_option( self::VERSION_OPTION, self::SCHEMA_VERSION, true ); // Autoloaded: read on every request by maybe_upgrade().
	}

	/**
	 * Runs {@see install()} when the stored schema version is older.
	 */
	public static function maybe_upgrade(): void {
		if ( self::SCHEMA_VERSION !== get_option( self::VERSION_OPTION ) ) {
			self::install();
		}
	}

	/**
	 * Drops the table (uninstall).
	 */
	public static function drop(): void {
		global $wpdb;
		$table = self::table();
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.DirectDatabaseQuery.SchemaChange, WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- plugin table, name from $wpdb->prefix.
		$wpdb->query( "DROP TABLE IF EXISTS {$table}" );
		delete_option( self::VERSION_OPTION );
	}

	/**
	 * Marks every row for revalidation on its next view (changes may have been missed).
	 */
	public function expire_all(): void {
		global $wpdb;
		$table = self::table();
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- plugin table, name from $wpdb->prefix.
		$wpdb->query( "UPDATE {$table} SET fetched_at = '1970-01-02 00:00:00'" );
	}

	/**
	 * Deletes the rows of locales no longer configured.
	 *
	 * @param string[] $locales Configured locales.
	 */
	public function keep_locales( array $locales ): void {
		global $wpdb;
		if ( array() === $locales ) {
			return;
		}
		$table = self::table();
		$in    = implode( ',', array_fill( 0, count( $locales ), '%s' ) );
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.PreparedSQL.InterpolatedNotPrepared, WordPress.DB.PreparedSQLPlaceholders.UnfinishedPrepare, WordPress.DB.PreparedSQLPlaceholders.ReplacementsWrongNumber -- plugin table; placeholders built above.
		$wpdb->query( $wpdb->prepare( "DELETE FROM {$table} WHERE lang NOT IN ({$in})", ...array_values( $locales ) ) );
	}

	/**
	 * Deletes every row (new API key or endpoint).
	 */
	public function truncate(): void {
		global $wpdb;
		$table = self::table();
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- plugin table, name from $wpdb->prefix.
		$wpdb->query( "DELETE FROM {$table}" );
	}

	/**
	 * Inserts or replaces the row for (ref, lang).
	 *
	 * @param string              $ref        Reference.
	 * @param string              $lang       Locale.
	 * @param array<string,mixed> $payload    The `/v2/listings/{ref}` body.
	 * @param string|null         $etag       Its ETag.
	 * @param string|null         $changed_at The change feed's `changedAt` that triggered the fetch (ISO), if any.
	 */
	public function upsert( string $ref, string $lang, array $payload, ?string $etag, ?string $changed_at = null ): void {
		global $wpdb;
		$table   = self::table();
		$kind    = isset( $payload['kind'] ) && is_string( $payload['kind'] ) ? substr( $payload['kind'], 0, 10 ) : 'LISTING';
		$slug    = isset( $payload['slug'] ) && is_string( $payload['slug'] ) ? substr( $payload['slug'], 0, 191 ) : '';
		$changed = null !== $changed_at ? gmdate( 'Y-m-d H:i:s', (int) strtotime( $changed_at ) ) : null;
		// prepare() turns null into '' — NULLs are written as literals instead.
		$etag_sql    = null === $etag ? 'NULL' : '%s';
		$changed_sql = null === $changed ? 'NULL' : '%s';
		$args        = array_values(
			array_filter(
				array( $ref, $lang, $kind, $slug, (string) wp_json_encode( $payload ), $etag, $changed, gmdate( 'Y-m-d H:i:s' ) ),
				static fn ( $v ): bool => null !== $v
			)
		);
		// phpcs:disable WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.PreparedSQL.InterpolatedNotPrepared, WordPress.DB.PreparedSQLPlaceholders.UnfinishedPrepare, WordPress.DB.PreparedSQLPlaceholders.ReplacementsWrongNumber -- plugin table; values prepared (NULLs as literals).
		$wpdb->query(
			$wpdb->prepare(
				"INSERT INTO {$table} (ref, lang, kind, slug, payload, etag, changed_at, fetched_at)
				VALUES (%s, %s, %s, %s, %s, {$etag_sql}, {$changed_sql}, %s)
				ON DUPLICATE KEY UPDATE kind = VALUES(kind), slug = VALUES(slug), payload = VALUES(payload),
					etag = VALUES(etag), changed_at = COALESCE(VALUES(changed_at), changed_at), fetched_at = VALUES(fetched_at)",
				...$args
			)
		);
		// phpcs:enable
	}

	/**
	 * Marks a row as confirmed current (a 304).
	 *
	 * @param string $ref  Reference.
	 * @param string $lang Locale.
	 */
	public function touch( string $ref, string $lang ): void {
		global $wpdb;
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching -- plugin table.
		$wpdb->update(
			self::table(),
			array( 'fetched_at' => gmdate( 'Y-m-d H:i:s' ) ),
			array(
				'ref'  => $ref,
				'lang' => $lang,
			)
		);
	}

	/**
	 * The row for (ref, lang).
	 *
	 * @param string $ref  Reference.
	 * @param string $lang Locale.
	 * @return array{ref:string,lang:string,kind:string,slug:string,payload:array<string,mixed>,etag:?string,fetched_at:int}|null
	 */
	public function find( string $ref, string $lang ): ?array {
		global $wpdb;
		$table = self::table();
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- plugin table; values prepared.
		$row = $wpdb->get_row( $wpdb->prepare( "SELECT ref, lang, kind, slug, payload, etag, fetched_at FROM {$table} WHERE ref = %s AND lang = %s", $ref, $lang ), ARRAY_A );
		return is_array( $row ) ? self::hydrate( $row ) : null;
	}

	/**
	 * The row for a slug in a locale (pretty URLs).
	 *
	 * @param string $slug Slug.
	 * @param string $lang Locale.
	 * @return array{ref:string,lang:string,kind:string,slug:string,payload:array<string,mixed>,etag:?string,fetched_at:int}|null
	 */
	public function find_by_slug( string $slug, string $lang ): ?array {
		global $wpdb;
		$table = self::table();
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- plugin table; values prepared.
		$row = $wpdb->get_row( $wpdb->prepare( "SELECT ref, lang, kind, slug, payload, etag, fetched_at FROM {$table} WHERE slug = %s AND lang = %s LIMIT 1", $slug, $lang ), ARRAY_A );
		return is_array( $row ) ? self::hydrate( $row ) : null;
	}

	/**
	 * Deletes a reference in one locale, or in every locale.
	 *
	 * @param string      $ref  Reference.
	 * @param string|null $lang Locale, or null for all.
	 */
	public function delete( string $ref, ?string $lang = null ): void {
		global $wpdb;
		$where = null === $lang ? array( 'ref' => $ref ) : array(
			'ref'  => $ref,
			'lang' => $lang,
		);
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching -- plugin table.
		$wpdb->delete( self::table(), $where );
	}

	/**
	 * Marks the rows of these references with a sweep number (scope rebuild, mark phase).
	 *
	 * @param string[] $refs  References still on the site.
	 * @param int      $sweep Sweep number.
	 */
	public function mark( array $refs, int $sweep ): void {
		global $wpdb;
		$table = self::table();
		foreach ( array_chunk( array_values( array_unique( $refs ) ), self::CHUNK ) as $chunk ) {
			$in = implode( ',', array_fill( 0, count( $chunk ), '%s' ) );
			// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.PreparedSQL.InterpolatedNotPrepared, WordPress.DB.PreparedSQLPlaceholders.UnfinishedPrepare, WordPress.DB.PreparedSQLPlaceholders.ReplacementsWrongNumber -- plugin table; placeholders built above.
			$wpdb->query( $wpdb->prepare( "UPDATE {$table} SET sweep = %d WHERE ref IN ({$in})", $sweep, ...$chunk ) );
		}
	}

	/**
	 * Deletes the rows not marked with this sweep number (scope rebuild, sweep phase). Rows fetched since the
	 * rebuild started are current by definition and kept.
	 *
	 * @param int $sweep   Sweep number.
	 * @param int $started Unix time the rebuild started.
	 * @return int Rows deleted.
	 */
	public function sweep( int $sweep, int $started ): int {
		global $wpdb;
		$table = self::table();
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- plugin table; values prepared.
		return (int) $wpdb->query( $wpdb->prepare( "DELETE FROM {$table} WHERE sweep <> %d AND fetched_at < %s", $sweep, gmdate( 'Y-m-d H:i:s', $started ) ) );
	}

	/**
	 * Number of rows.
	 */
	public function count(): int {
		global $wpdb;
		$table = self::table();
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- plugin table.
		return (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$table}" );
	}

	/**
	 * Every row as (ref, lang, sha1 of payload), ordered — a state fingerprint for tests and the health view.
	 *
	 * @return list<array{ref:string,lang:string,hash:string}>
	 */
	public function snapshot(): array {
		global $wpdb;
		$table = self::table();
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- plugin table.
		$rows = $wpdb->get_results( "SELECT ref, lang, SHA1(payload) AS hash FROM {$table} ORDER BY ref, lang", ARRAY_A );
		return is_array( $rows ) ? array_map(
			static fn ( array $r ): array => array(
				'ref'  => (string) $r['ref'],
				'lang' => (string) $r['lang'],
				'hash' => (string) $r['hash'],
			),
			$rows
		) : array();
	}

	/**
	 * Decodes a database row.
	 *
	 * @param array<string,mixed> $row Raw row.
	 * @return array{ref:string,lang:string,kind:string,slug:string,payload:array<string,mixed>,etag:?string,fetched_at:int}|null
	 */
	private static function hydrate( array $row ): ?array {
		$payload = json_decode( (string) $row['payload'], true );
		if ( ! is_array( $payload ) ) {
			return null;
		}
		return array(
			'ref'        => (string) $row['ref'],
			'lang'       => (string) $row['lang'],
			'kind'       => (string) $row['kind'],
			'slug'       => (string) $row['slug'],
			'payload'    => $payload,
			'etag'       => null !== $row['etag'] ? (string) $row['etag'] : null,
			'fetched_at' => (int) strtotime( $row['fetched_at'] . ' UTC' ),
		);
	}
}
