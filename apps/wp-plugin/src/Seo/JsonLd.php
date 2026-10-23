<?php
/**
 * Schema.org JSON-LD for listing, development and results pages.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\Seo;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Builds JSON-LD only from API fields — never from generated text — and only from what the website API already
 * white-labels (the presenting agency is the site's own; no owner agency, owner contacts or commission exist in it).
 * Coordinates are published only when the API marks them EXACT.
 */
final class JsonLd {

	private const CONTEXT = 'https://schema.org';

	/**
	 * A listing (or unit) detail page.
	 *
	 * @param array<string,mixed> $item The `/v2/listings/{ref}` body.
	 * @param string              $url  Canonical URL.
	 * @return array<string,mixed>
	 */
	public static function listing( array $item, string $url ): array {
		$data        = array(
			'@context' => self::CONTEXT,
			'@type'    => 'RealEstateListing',
			'@id'      => $url,
			'url'      => $url,
			'name'     => self::text( $item['title'] ?? '' ),
		);
		$description = self::text( $item['metaDescription'] ?? $item['description'] ?? '' );
		if ( '' !== $description ) {
			$data['description'] = $description;
		}
		$images = self::images( $item );
		if ( array() !== $images ) {
			$data['image'] = $images;
		}

		$place = array(
			'@type' => 'Accommodation',
		);
		foreach ( array(
			'bedrooms'  => 'numberOfBedrooms',
			'bathrooms' => 'numberOfBathroomsTotal',
		) as $field => $prop ) {
			if ( isset( $item[ $field ] ) && is_int( $item[ $field ] ) ) {
				$place[ $prop ] = $item[ $field ];
			}
		}
		$area = $item['builtM2'] ?? $item['internalM2'] ?? null;
		if ( is_int( $area ) || is_float( $area ) ) {
			$place['floorSize'] = array(
				'@type'    => 'QuantitativeValue',
				'value'    => $area,
				'unitCode' => 'MTK',
			);
		}
		$address = self::address( $item );
		if ( null !== $address ) {
			$place['address'] = $address;
		}
		$geo = self::geo( $item );
		if ( null !== $geo ) {
			$place['geo'] = $geo;
		}
		$data['about'] = $place;

		$offer = self::offer( $item );
		if ( null !== $offer ) {
			$data['offers'] = $offer;
		}
		return $data;
	}

	/**
	 * A development detail page.
	 *
	 * @param array<string,mixed> $item The `/v2/developments/{ref}` body.
	 * @param string              $url  Canonical URL.
	 * @return array<string,mixed>
	 */
	public static function development( array $item, string $url ): array {
		$data        = array(
			'@context' => self::CONTEXT,
			'@type'    => 'Residence',
			'@id'      => $url,
			'url'      => $url,
			'name'     => self::text( $item['title'] ?? $item['name'] ?? '' ),
		);
		$description = self::text( $item['metaDescription'] ?? $item['description'] ?? '' );
		if ( '' !== $description ) {
			$data['description'] = $description;
		}
		$address = self::address( $item );
		if ( null !== $address ) {
			$data['address'] = $address;
		}
		$geo = self::geo( $item );
		if ( null !== $geo ) {
			$data['geo'] = $geo;
		}
		$price = isset( $item['price'] ) && is_array( $item['price'] ) ? $item['price'] : array();
		if ( isset( $price['fromCents'] ) && is_int( $price['fromCents'] ) && ! empty( $price['currency'] ) ) {
			$offer = array(
				'@type'         => 'AggregateOffer',
				'priceCurrency' => (string) $price['currency'],
				'lowPrice'      => $price['fromCents'] / 100,
			);
			if ( isset( $price['toCents'] ) && is_int( $price['toCents'] ) ) {
				$offer['highPrice'] = $price['toCents'] / 100;
			}
			if ( isset( $item['units']['available'] ) && is_int( $item['units']['available'] ) ) {
				$offer['offerCount'] = $item['units']['available'];
			}
			$data['offers'] = $offer;
		}
		return $data;
	}

	/**
	 * A results page: the listed items in order.
	 *
	 * @param string[] $urls Item URLs.
	 * @return array<string,mixed>
	 */
	public static function item_list( array $urls ): array {
		$elements = array();
		foreach ( array_values( $urls ) as $i => $url ) {
			$elements[] = array(
				'@type'    => 'ListItem',
				'position' => $i + 1,
				'url'      => $url,
			);
		}
		return array(
			'@context'        => self::CONTEXT,
			'@type'           => 'ItemList',
			'numberOfItems'   => count( $elements ),
			'itemListElement' => $elements,
		);
	}

	/**
	 * A `<script type="application/ld+json">` element; the JSON cannot close the element (`<`, `>`, `&` escaped).
	 *
	 * @param array<string,mixed> $data JSON-LD.
	 */
	public static function script( array $data ): string {
		$json = wp_json_encode( $data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_HEX_TAG | JSON_HEX_AMP );
		return false === $json ? '' : '<script type="application/ld+json">' . $json . '</script>' . "\n";
	}

	/**
	 * The offer, unless the price is on request.
	 *
	 * @param array<string,mixed> $item API item.
	 * @return array<string,mixed>|null
	 */
	private static function offer( array $item ): ?array {
		$price = isset( $item['price'] ) && is_array( $item['price'] ) ? $item['price'] : null;
		if ( null === $price || ! empty( $price['onRequest'] ) || ! isset( $price['amountCents'] ) || ! is_int( $price['amountCents'] ) || empty( $price['currency'] ) ) {
			return null;
		}
		$availability = array(
			'ACTIVE'      => 'https://schema.org/InStock',
			'AVAILABLE'   => 'https://schema.org/InStock',
			'UNDER_OFFER' => 'https://schema.org/LimitedAvailability',
			'RESERVED'    => 'https://schema.org/LimitedAvailability',
			'SOLD'        => 'https://schema.org/SoldOut',
			'RENTED'      => 'https://schema.org/SoldOut',
		);
		$offer        = array(
			'@type'         => 'Offer',
			'price'         => $price['amountCents'] / 100,
			'priceCurrency' => (string) $price['currency'],
		);
		$status       = isset( $item['status'] ) && is_string( $item['status'] ) ? $item['status'] : '';
		if ( isset( $availability[ $status ] ) ) {
			$offer['availability'] = $availability[ $status ];
		}
		if ( isset( $item['transactionType'] ) && is_string( $item['transactionType'] ) && 0 === strpos( $item['transactionType'], 'RENT' ) ) {
			$offer['businessFunction'] = 'http://purl.org/goodrelations/v1#LeaseOut';
		}
		if ( isset( $item['agency']['name'] ) && is_string( $item['agency']['name'] ) && '' !== $item['agency']['name'] ) {
			// The presenting agency: the site's own (the API never sends the owner agency).
			$offer['offeredBy'] = array(
				'@type' => 'RealEstateAgent',
				'name'  => $item['agency']['name'],
			);
		}
		return $offer;
	}

	/**
	 * The postal address from the API place.
	 *
	 * @param array<string,mixed> $item API item.
	 * @return array<string,string>|null
	 */
	private static function address( array $item ): ?array {
		$place   = isset( $item['place'] ) && is_array( $item['place'] ) ? $item['place'] : array();
		$address = array( '@type' => 'PostalAddress' );
		foreach ( array(
			'city'    => 'addressLocality',
			'region'  => 'addressRegion',
			'country' => 'addressCountry',
		) as $level => $prop ) {
			if ( isset( $place[ $level ]['name'] ) && is_string( $place[ $level ]['name'] ) && '' !== $place[ $level ]['name'] ) {
				$address[ $prop ] = $place[ $level ]['name'];
			}
		}
		return count( $address ) > 1 ? $address : null;
	}

	/**
	 * Coordinates, only when exact.
	 *
	 * @param array<string,mixed> $item API item.
	 * @return array<string,mixed>|null
	 */
	private static function geo( array $item ): ?array {
		$geo = isset( $item['geo'] ) && is_array( $item['geo'] ) ? $item['geo'] : null;
		if ( null === $geo || 'EXACT' !== ( $geo['precision'] ?? '' ) || ! is_numeric( $geo['lat'] ?? null ) || ! is_numeric( $geo['lng'] ?? null ) ) {
			return null;
		}
		return array(
			'@type'     => 'GeoCoordinates',
			'latitude'  => (float) $geo['lat'],
			'longitude' => (float) $geo['lng'],
		);
	}

	/**
	 * Image URLs (large, else medium) from the media list, else the cover.
	 *
	 * @param array<string,mixed> $item API item.
	 * @return list<string>
	 */
	private static function images( array $item ): array {
		$media = isset( $item['media'] ) && is_array( $item['media'] ) ? $item['media'] : array();
		if ( array() === $media && isset( $item['cover'] ) && is_array( $item['cover'] ) ) {
			$media = array( $item['cover'] );
		}
		$out = array();
		foreach ( $media as $m ) {
			if ( ! is_array( $m ) || 'VIDEO' === ( $m['kind'] ?? '' ) ) {
				continue;
			}
			$url = $m['urls']['large'] ?? $m['urls']['medium'] ?? null;
			if ( is_string( $url ) && '' !== $url ) {
				$out[] = esc_url_raw( $url );
			}
		}
		return array_slice( array_values( array_unique( $out ) ), 0, 10 );
	}

	/**
	 * Plain text, single-spaced.
	 *
	 * @param mixed $value API text.
	 */
	private static function text( $value ): string {
		return is_string( $value ) ? trim( (string) preg_replace( '/\s+/u', ' ', wp_strip_all_tags( $value ) ) ) : '';
	}
}
