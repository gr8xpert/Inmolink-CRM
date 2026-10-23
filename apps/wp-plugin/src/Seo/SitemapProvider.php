<?php
/**
 * WordPress core sitemap provider for listing pages.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\Seo;

use Inmolink\Plugin\I18n\Locale;
use Inmolink\Plugin\Routing\Urls;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * `wp-sitemap-inmolink-{language}-{n}.xml`: the site's listing, unit and development pages from `/v2/sitemap` ({@see SitemapIndex}),
 * one subtype per site language, with `lastmod`.
 */
class SitemapProvider extends \WP_Sitemaps_Provider {

	public const NAME = 'inmolink';

	/**
	 * Creates the provider.
	 *
	 * @param SitemapIndex $index The cached index.
	 */
	public function __construct( private readonly SitemapIndex $index ) {
		$this->name        = self::NAME;
		$this->object_type = self::NAME;
	}

	/**
	 * Registers the provider with WordPress sitemaps.
	 */
	public static function register(): void {
		add_action(
			'wp_sitemaps_init',
			static function ( $server ): void {
				if ( $server instanceof \WP_Sitemaps && $server->sitemaps_enabled() ) {
					$server->registry->add_provider( self::NAME, new self( SitemapIndex::from_settings() ) );
				}
			}
		);
	}

	/**
	 * One subtype per site language.
	 *
	 * @return array<string,object>
	 */
	public function get_object_subtypes() {
		$out = array();
		foreach ( Locale::routable() as $lang => $locale ) {
			// Core's sitemap URLs only match lower-case subtypes (`es-es`, not `es-ES`).
			$key         = self::subtype( (string) $lang );
			$out[ $key ] = (object) array(
				'name'   => $key,
				'locale' => $locale,
			);
		}
		return $out;
	}

	/**
	 * The URLs of one sitemap page.
	 *
	 * @param int    $page_num       Page number.
	 * @param string $object_subtype Site language.
	 * @return array<int,array<string,string>>
	 */
	public function get_url_list( $page_num, $object_subtype = '' ) {
		$locale = $this->locale( (string) $object_subtype );
		$urls   = array();
		foreach ( $this->index->entries( $locale, (int) $page_num ) as $entry ) {
			$url = array( 'loc' => Urls::for_item( $entry, $locale ) );
			$ts  = strtotime( $entry['updatedAt'] );
			if ( false !== $ts ) {
				$url['lastmod'] = gmdate( 'Y-m-d\TH:i:s\Z', $ts );
			}
			$urls[] = $url;
		}
		return $urls;
	}

	/**
	 * Number of pages.
	 *
	 * @param string $object_subtype Site language.
	 */
	public function get_max_num_pages( $object_subtype = '' ) {
		return $this->index->pages( $this->locale( (string) $object_subtype ) );
	}

	/**
	 * The API locale of a subtype (the current language when none is given).
	 *
	 * @param string $subtype Site language.
	 */
	private function locale( string $subtype ): string {
		foreach ( Locale::routable() as $lang => $locale ) {
			if ( '' !== $subtype && self::subtype( (string) $lang ) === $subtype ) {
				return $locale;
			}
		}
		return Locale::current();
	}

	/**
	 * A site language as a sitemap subtype.
	 *
	 * @param string $lang Site language code.
	 */
	public static function subtype( string $lang ): string {
		return (string) preg_replace( '/[^a-z0-9_-]/', '', strtolower( str_replace( '_', '-', $lang ) ) );
	}
}
