<?php
/**
 * JSON-LD validity and white-label safety.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\Tests\Integration;

use Inmolink\Plugin\Seo\JsonLd;
use Inmolink\Plugin\Tests\TestCase;

/**
 * schema.org JSON-LD from API fields only.
 */
final class JsonLdTest extends TestCase {

	/**
	 * A fixture as an array.
	 *
	 * @param string $name Fixture file.
	 * @return array<string,mixed>
	 */
	private function fixture( string $name ): array {
		return json_decode( (string) file_get_contents( dirname( __DIR__ ) . '/fixtures/' . $name ), true );
	}

	/**
	 * Decodes the JSON inside a `<script type="application/ld+json">`.
	 *
	 * @param string $html Script element.
	 * @return array<string,mixed>
	 */
	private function decode( string $html ): array {
		$this->assertMatchesRegularExpression( '#^<script type="application/ld\+json">(.*)</script>\s*$#s', $html );
		preg_match( '#^<script type="application/ld\+json">(.*)</script>#s', $html, $m );
		$data = json_decode( $m[1], true );
		$this->assertIsArray( $data, 'valid JSON' );
		return $data;
	}

	/**
	 * Every key anywhere in a JSON-LD document.
	 *
	 * @param array<string,mixed> $data Document.
	 * @return string[]
	 */
	private function keys( array $data ): array {
		$out = array();
		array_walk_recursive(
			$data,
			static function ( $v, $k ) use ( &$out ): void {
				$out[] = (string) $k;
			}
		);
		foreach ( $data as $k => $v ) {
			$out[] = (string) $k;
			if ( is_array( $v ) ) {
				$out = array_merge( $out, $this->keys( $v ) );
			}
		}
		return array_unique( $out );
	}

	/**
	 * [S8-04] Listing JSON-LD is valid schema.org built from API fields only.
	 */
	public function test_s8_04_listing_jsonld_is_valid(): void {
		$item = $this->fixture( 'listing.INM-1001.json' );
		$data = $this->decode( JsonLd::script( JsonLd::listing( $item, 'https://example.org/property/INM-1001/villa-sol/' ) ) );

		$this->assertSame( 'https://schema.org', $data['@context'] );
		$this->assertSame( 'RealEstateListing', $data['@type'] );
		$this->assertSame( 'Villa Sol', $data['name'] );
		$this->assertSame( 'https://example.org/property/INM-1001/villa-sol/', $data['url'] );
		$this->assertSame( 'Offer', $data['offers']['@type'] );
		$this->assertSame( 1250000, $data['offers']['price'] );
		$this->assertSame( 'EUR', $data['offers']['priceCurrency'] );
		$this->assertSame( 'https://schema.org/InStock', $data['offers']['availability'] );
		$this->assertSame( 'Costa Homes', $data['offers']['offeredBy']['name'], 'the presenting (site) agency' );
		$this->assertSame( 4, $data['about']['numberOfBedrooms'] );
		$this->assertSame( 'MTK', $data['about']['floorSize']['unitCode'] );
		$this->assertSame( 'Marbella', $data['about']['address']['addressLocality'] );
		$this->assertArrayNotHasKey( 'geo', $data['about'], 'APPROX coordinates are not published' );
		$this->assertCount( 2, $data['image'], 'images, not the video' );
		$this->assertStringContainsString( 'South-facing with sea views.', $data['description'] );
	}

	/**
	 * [S8-04] JSON-LD never carries owner, commission or contact fields, and cannot break out of its script element.
	 */
	public function test_s8_04_jsonld_white_label_and_escaping(): void {
		$item          = $this->fixture( 'listing.INM-1001.json' );
		$item['title'] = 'Villa </script><script>alert(1)</script> & co';
		$html          = JsonLd::script( JsonLd::listing( $item, 'https://example.org/x/' ) );

		$this->assertSame( 1, substr_count( $html, '</script>' ), 'the title cannot close the element' );
		$data = $this->decode( $html );
		$this->assertSame( 'Villa & co', $data['name'], 'markup (and script contents) stripped' );
		foreach ( $this->keys( $data ) as $key ) {
			$this->assertDoesNotMatchRegularExpression( '/commission|owner|email|phone|whatsapp/i', $key );
		}
		$this->assertStringNotContainsString( 'info@costahomes.example', $html );
	}

	/**
	 * [S8-04] Development and results JSON-LD are valid; price on request has no offer.
	 */
	public function test_s8_04_development_and_list_jsonld(): void {
		$dev = $this->decode( JsonLd::script( JsonLd::development( $this->fixture( 'development.DEV-77.json' ), 'https://example.org/development/DEV-77/' ) ) );
		$this->assertSame( 'Residence', $dev['@type'] );
		$this->assertSame( 'AggregateOffer', $dev['offers']['@type'] );
		$this->assertSame( 450000, $dev['offers']['lowPrice'] );
		$this->assertSame( 980000, $dev['offers']['highPrice'] );
		$this->assertSame( 12, $dev['offers']['offerCount'] );
		$this->assertSame( 36.51, $dev['geo']['latitude'], 'EXACT coordinates are published' );

		$list = $this->decode( JsonLd::script( JsonLd::item_list( array( 'https://example.org/a/', 'https://example.org/b/' ) ) ) );
		$this->assertSame( 'ItemList', $list['@type'] );
		$this->assertSame( 2, $list['itemListElement'][1]['position'] );

		$item                       = $this->fixture( 'listing.INM-1002.json' );
		$item['price']['onRequest'] = true;
		$this->assertArrayNotHasKey( 'offers', JsonLd::listing( $item, 'https://example.org/y/' ) );
	}
}
