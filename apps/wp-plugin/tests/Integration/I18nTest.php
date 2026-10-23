<?php
/**
 * Translations: the admin page, the block editor's labels and the shipped catalogues.
 *
 * @package Inmolink
 */

namespace Inmolink\Plugin\Tests\Integration;

use Inmolink\Plugin\Admin\SettingsPage;
use Inmolink\Plugin\Blocks\Blocks;
use Inmolink\Plugin\Plugin;
use Inmolink\Plugin\Tests\TestCase;
use const Inmolink\Plugin\PLUGIN_FILE;

/**
 * Spanish is hand-written; NL/DE/FR/SV are drafts (keys only) that fall back to English.
 */
final class I18nTest extends TestCase {

	/**
	 * The plugin's languages folder.
	 */
	private function languages(): string {
		return dirname( PLUGIN_FILE ) . '/languages';
	}

	/**
	 * Back to English.
	 */
	public function tear_down(): void {
		restore_current_locale();
		unload_textdomain( 'inmolink' );
		parent::tear_down();
	}

	/**
	 * Switches the request to Spanish and loads the plugin's catalogue as `load_plugin_textdomain()` would from the
	 * plugin folder (the suite loads the plugin from outside wp-content/plugins, where that path is not resolvable).
	 */
	private function use_spanish(): void {
		switch_to_locale( 'es_ES' );
		unload_textdomain( 'inmolink' );
		$this->assertTrue( load_textdomain( 'inmolink', $this->languages() . '/inmolink-es_ES.mo', 'es_ES' ) );
	}

	/**
	 * The Spanish JSON of the editor script.
	 *
	 * @return array<string,mixed>
	 */
	private function spanish_json(): array {
		$files = glob( $this->languages() . '/inmolink-es_ES-*.json' );
		$this->assertNotEmpty( $files, 'a Spanish JSON file for assets/editor.js ships' );
		$decoded = json_decode( (string) file_get_contents( $files[0] ), true );
		$this->assertIsArray( $decoded );
		return $decoded;
	}

	/**
	 * [S8-F15] The text domain is loaded on `init`, from a languages folder that exists (the Domain Path header).
	 */
	public function test_s8_f15_text_domain_loaded_from_existing_domain_path(): void {
		$this->assertNotFalse( has_action( 'init', array( Plugin::class, 'init' ) ) );
		$header = get_file_data(
			PLUGIN_FILE,
			array(
				'domain' => 'Text Domain',
				'path'   => 'Domain Path',
			)
		);
		$this->assertSame( 'inmolink', $header['domain'] );
		$this->assertDirectoryExists( dirname( PLUGIN_FILE ) . $header['path'] );
	}

	/**
	 * [S8-F15] The settings page renders in Spanish.
	 */
	public function test_s8_f15_admin_page_renders_in_spanish(): void {
		wp_set_current_user( self::factory()->user->create( array( 'role' => 'administrator' ) ) );
		$this->use_spanish();
		ob_start();
		( new SettingsPage() )->render();
		$html = (string) ob_get_clean();
		$this->assertStringContainsString( 'URL de la API', $html );
		$this->assertStringContainsString( 'Clave secreta de la API', $html );
		$this->assertStringContainsString( 'Probar la conexión', $html );
		$this->assertStringNotContainsString( 'Secret API key', $html );
	}

	/**
	 * [S8-F15] Without a translation the English source shows (the NL/DE/FR/SV drafts ship no .mo).
	 */
	public function test_s8_f15_drafts_fall_back_to_english(): void {
		unload_textdomain( 'inmolink' );
		$this->assertFileDoesNotExist( $this->languages() . '/inmolink-nl_NL.mo' );
		$this->assertSame( 'Secret API key', __( 'Secret API key', 'inmolink' ) );
	}

	/**
	 * [S8-F15] The catalogues ship: a .pot, ES and four drafts, each with exactly the keys of the .pot; ES is complete.
	 */
	public function test_s8_f15_catalogues_in_sync_with_pot(): void {
		$pot = $this->msgids( $this->languages() . '/inmolink.pot' );
		$this->assertGreaterThan( 100, count( $pot ) );
		foreach ( array( 'es_ES', 'nl_NL', 'de_DE', 'fr_FR', 'sv_SE' ) as $locale ) {
			$po = $this->languages() . "/inmolink-{$locale}.po";
			$this->assertFileExists( $po, $locale );
			$this->assertSame( $pot, $this->msgids( $po ), "{$locale} has exactly the keys of the .pot" );
		}
		$this->assertFileExists( $this->languages() . '/inmolink-es_ES.mo' );
		$es = (string) file_get_contents( $this->languages() . '/inmolink-es_ES.po' );
		$es = (string) preg_replace( '/\A.*?\n\n/s', '', $es, 1 );
		$this->assertDoesNotMatchRegularExpression( '/^msgstr(\[\d\])? ""$(?!\n")/m', $es, 'every Spanish string is translated' );
	}

	/**
	 * The msgids (with context) of a .po/.pot file, header excluded.
	 *
	 * @param string $file File.
	 * @return string[]
	 */
	private function msgids( string $file ): array {
		$out = array();
		preg_match_all( '/^(?:msgctxt "(.*)"\n)?msgid "(.+)"$/m', (string) file_get_contents( $file ), $m, PREG_SET_ORDER );
		foreach ( $m as $row ) {
			$out[] = $row[1] . '|' . $row[2];
		}
		sort( $out );
		return $out;
	}

	/**
	 * [S8-F22] The editor script has its translations registered, and the Spanish JSON carries the sidebar texts.
	 */
	public function test_s8_f22_block_sidebar_translations_registered(): void {
		$this->use_spanish();
		$script = wp_scripts()->registered['inmolink-blocks-editor'];
		$this->assertSame( 'inmolink', $script->textdomain, 'wp_set_script_translations() was called' );
		$this->assertSame( $this->languages(), $script->translations_path );

		$json = $this->spanish_json();
		$this->assertSame( 'assets/editor.js', $json['source'] );
		$messages = $json['locale_data']['messages'];
		$this->assertSame( array( 'Dormitorios mínimos' ), $messages['Minimum bedrooms'] );
		$this->assertSame( array( 'Ajustes' ), $messages['Settings'] );
	}

	/**
	 * [S8-F22] Every attribute of every block has an entry in the editor's label map, and every label is in the
	 * Spanish JSON: a new attribute cannot ship untranslated.
	 */
	public function test_s8_f22_every_attribute_has_a_translated_label(): void {
		$js = (string) file_get_contents( dirname( PLUGIN_FILE ) . '/assets/editor.js' );
		preg_match_all( "/^\t\t(\w+): __\( '((?:[^'\\\\]|\\\\.)*)', 'inmolink' \),$/m", $js, $m, PREG_SET_ORDER );
		$labels = array();
		foreach ( $m as $row ) {
			$labels[ $row[1] ] = stripslashes( $row[2] );
		}
		$messages = $this->spanish_json()['locale_data']['messages'];

		foreach ( Blocks::NAMES as $name ) {
			$block = json_decode( (string) file_get_contents( dirname( PLUGIN_FILE ) . '/blocks/' . $name . '/block.json' ), true );
			foreach ( array_keys( $block['attributes'] ) as $attribute ) {
				$this->assertArrayHasKey( $attribute, $labels, "{$name}.{$attribute} has a label" );
				$this->assertNotEmpty( $messages[ $labels[ $attribute ] ][0] ?? '', "{$name}.{$attribute} is translated to Spanish" );
			}
		}
	}

	/**
	 * [S8-F22] Block titles come from block.json through the text domain.
	 */
	public function test_s8_f22_block_titles_translate(): void {
		$this->use_spanish();
		$registry = \WP_Block_Type_Registry::get_instance();
		$registry->unregister( 'inmolink/search' );
		register_block_type(
			dirname( PLUGIN_FILE ) . '/blocks/search',
			array( 'render_callback' => array( Blocks::class, 'render_search' ) )
		);
		$this->assertSame( 'Búsqueda de inmuebles', $registry->get_registered( 'inmolink/search' )->title );
	}
}
