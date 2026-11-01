<?php
/**
 * Legacy plugin option → v2 setting mapping table (S8-F11).
 *
 * ASSUMED — pending H15. The legacy plugin's source is not available, so every option name and array key below is a
 * plausible guess, NOT confirmed against a real install. Until H15 confirms them the migration stays off
 * ({@see \Inmolink\Plugin\Migration\LegacySettings::enabled()}): turn it on with
 * `define( 'INMOLINK_MIGRATE_LEGACY_SETTINGS', true );` in wp-config.php or the `inmolink_migrate_legacy_settings`
 * filter only once the names here are right.
 *
 * This is the ONLY place legacy names live. When H15 arrives: replace the `option` / `key` values with the real ones,
 * set `status` to `CONFIRMED`, update tests/fixtures/legacy/options.json to a real (anonymised) export of the legacy
 * options, and flip the default in `LegacySettings::enabled()`.
 *
 * Each field: v2 setting => array(
 *   'option' => legacy option name (`get_option()`),
 *   'key'    => array key inside that option when the legacy plugin stores an array (omit for a scalar option),
 *   'unit'   => 'minutes' when the legacy value is in minutes (v2 stores seconds); omit otherwise.
 * )
 * `api_key` is the secret key (stored encrypted through `Settings::set_api_key()`); the others are `Settings` fields.
 * The legacy API URL is deliberately not mapped: it points at the v1 API, and a v2 key is only ever sent to the pinned
 * production API or `INMOLINK_API_BASE`.
 *
 * @package Inmolink
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

return array(
	'status' => 'ASSUMED',
	'fields' => array(
		'api_key'        => array(
			'option' => 'inmolink_options',
			'key'    => 'api_key',
		),
		'locales'        => array(
			'option' => 'inmolink_options',
			'key'    => 'languages',
		),
		'default_locale' => array(
			'option' => 'inmolink_options',
			'key'    => 'default_language',
		),
		'cache_ttl'      => array(
			'option' => 'inmolink_options',
			'key'    => 'cache_minutes',
			'unit'   => 'minutes',
		),
		'listing_base'   => array(
			'option' => 'inmolink_property_slug',
		),
	),
);
