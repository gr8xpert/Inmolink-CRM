<?php
/**
 * The health page and the Site Health test.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\Tests\Integration;

use Inmolink\Plugin\Admin\Health;
use Inmolink\Plugin\Api\Client;
use Inmolink\Plugin\Mirror\Mirror;
use Inmolink\Plugin\Sync\DeltaSync;
use Inmolink\Plugin\Tests\TestCase;
use const Inmolink\Plugin\VERSION;

/**
 * API status, cache age, mirror counts, version and last sync.
 */
final class HealthTest extends TestCase {

	/**
	 * [S8-05] The health report: version, API status, last sync, mirror counts and ages per locale.
	 */
	public function test_s8_05_health_report(): void {
		update_option( DeltaSync::STATE_OPTION, array( 'last_success' => time() - 120, 'last_run' => time() - 60, 'last_error' => '' ), false );
		( new Mirror() )->upsert( 'INM-1001', 'en', array( 'slug' => 'villa-sol' ), null );
		( new Mirror() )->upsert( 'INM-1002', 'en', array( 'slug' => 'casa-luna' ), null );

		$r = Health::report();
		$this->assertSame( VERSION, $r['version'] );
		$this->assertTrue( $r['configured'] );
		$this->assertTrue( $r['api_reachable'] );
		$this->assertFalse( $r['sync_stale'] );
		$this->assertSame( 2, $r['mirror']['en']['rows'] );
		$this->assertGreaterThan( time() - 60, $r['mirror']['en']['newest'] );
		$this->assertTrue( $r['update_key'] );

		$this->assertSame( 'good', Health::site_status()['status'] );
		set_transient( Client::DOWN_TRANSIENT, time(), 60 );
		$this->assertFalse( Health::report()['api_reachable'] );
		$this->assertSame( 'recommended', Health::site_status()['status'] );
	}

	/**
	 * [S8-05] The page needs manage_options and shows no secret.
	 */
	public function test_s8_05_health_page(): void {
		wp_set_current_user( self::factory()->user->create( array( 'role' => 'administrator' ) ) );
		ob_start();
		Health::render();
		$html = (string) ob_get_clean();
		$this->assertStringContainsString( VERSION, $html );
		$this->assertStringNotContainsString( self::KEY, $html );
		$this->assertArrayHasKey( 'inmolink_health', Health::site_status_tests( array() )['direct'] );

		wp_set_current_user( self::factory()->user->create( array( 'role' => 'editor' ) ) );
		$this->expectException( \WPDieException::class );
		ob_start();
		try {
			Health::render();
		} finally {
			ob_end_clean();
		}
	}
}
