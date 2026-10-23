<?php
/**
 * Shortcode → block mapping table (S8-04).
 *
 * Each entry: shortcode tag => array(
 *   'block'       => block name,
 *   'attributes'  => shortcode attribute (lower case) => block attribute, or
 *                    array( 'to' => block attribute, 'values' => array( legacy value => block value ) ),
 *   'provisional' => true while the entry is not confirmed against the legacy inventory (H15),
 *   'source'      => where the entry comes from.
 * )
 *
 * H15 (legacy plugin source + the shortcodes used on client sites) is still missing, and neither PLAN.md nor the docs
 * name any legacy shortcode. The `inmolink_*` entries below are therefore the v2 plugin's own shortcodes, all marked
 * provisional. To add the legacy ones from H15, append entries under "Legacy (H15)" — e.g.
 *
 *     'old_property_list' => array(
 *         'block'       => 'inmolink/results',
 *         'attributes'  => array(
 *             'type'  => array( 'to' => 'transaction', 'values' => array( 'sale' => 'SALE', 'rent' => 'RENT_LONG_TERM' ) ),
 *             'items' => 'limit',
 *         ),
 *         'provisional' => false,
 *         'source'      => 'H15',
 *     ),
 *
 * and add the tag to the parity test fixture (tests/Integration/ShortcodesTest.php). Sites can also extend the table
 * with the `inmolink_shortcode_map` filter.
 *
 * @package Inmolink
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

return array(
	// v2 shortcodes (provisional: names to confirm or replace once H15 arrives).
	'inmolink_search'       => array(
		'block'       => 'inmolink/search',
		'attributes'  => array(
			'results_url' => 'resultsUrl',
			'fields'      => 'fields',
		),
		'provisional' => true,
		'source'      => 'v2 default (no legacy name known; H15)',
	),
	'inmolink_results'      => array(
		'block'       => 'inmolink/results',
		'attributes'  => array(
			'transaction' => 'transaction',
			'types'       => 'types',
			'locations'   => 'locations',
			'features'    => 'features',
			'kind'        => 'kind',
			'development' => 'development',
			'sort'        => 'sort',
			'limit'       => 'limit',
			'price_min'   => 'priceMin',
			'price_max'   => 'priceMax',
			'beds_min'    => 'bedsMin',
			'use_query'   => 'useQuery',
		),
		'provisional' => true,
		'source'      => 'v2 default (no legacy name known; H15)',
	),
	'inmolink_listing'      => array(
		'block'       => 'inmolink/detail',
		'attributes'  => array( 'ref' => 'ref' ),
		'provisional' => true,
		'source'      => 'v2 default (no legacy name known; H15)',
	),
	'inmolink_developments' => array(
		'block'       => 'inmolink/developments',
		'attributes'  => array(
			'locations' => 'locations',
			'limit'     => 'limit',
		),
		'provisional' => true,
		'source'      => 'v2 default (no legacy name known; H15)',
	),
	'inmolink_map'          => array(
		'block'       => 'inmolink/map',
		'attributes'  => array(
			'transaction' => 'transaction',
			'types'       => 'types',
			'locations'   => 'locations',
			'limit'       => 'limit',
			'use_query'   => 'useQuery',
		),
		'provisional' => true,
		'source'      => 'v2 default (no legacy name known; H15)',
	),

	'inmolink_lead_form'    => array(
		'block'       => 'inmolink/lead-form',
		'attributes'  => array(
			'ref'  => 'ref',
			'kind' => 'kind',
		),
		'provisional' => true,
		'source'      => 'v2 default (no legacy name known; H15)',
	),

	// Legacy (H15): none known yet.
);
