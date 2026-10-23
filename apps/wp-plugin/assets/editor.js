/**
 * Inmolink blocks in the editor (S8-04). No build step: plain ES5 against the WordPress globals.
 * Every block is dynamic (rendered by PHP); the editor shows a server-side preview and one sidebar control per
 * attribute declared in the block's block.json.
 */
( function ( wp ) {
	'use strict';
	if ( ! wp || ! wp.blocks || ! wp.element ) {
		return;
	}
	var el = wp.element.createElement;
	var __ = wp.i18n.__;
	var InspectorControls = wp.blockEditor.InspectorControls;
	var useBlockProps = wp.blockEditor.useBlockProps;
	var PanelBody = wp.components.PanelBody;
	var TextControl = wp.components.TextControl;
	var ToggleControl = wp.components.ToggleControl;
	var ServerSideRender = wp.serverSideRender;
	var NAMES = [ 'search', 'results', 'detail', 'developments', 'map', 'lead-form' ];

	function label( name ) {
		return name.replace( /([A-Z])/g, ' $1' ).replace( /^./, function ( c ) {
			return c.toUpperCase();
		} );
	}

	function control( name, schema, value, set ) {
		var props = { key: name, label: label( name ) };
		if ( schema.type === 'boolean' ) {
			props.checked = !! value;
			props.onChange = function ( v ) {
				set( name, !! v );
			};
			return el( ToggleControl, props );
		}
		props.value = value === undefined || value === null ? '' : String( value );
		if ( schema.type === 'number' ) {
			props.type = 'number';
			props.onChange = function ( v ) {
				set( name, v === '' ? 0 : Number( v ) );
			};
		} else {
			props.onChange = function ( v ) {
				set( name, v );
			};
		}
		return el( TextControl, props );
	}

	NAMES.forEach( function ( short ) {
		var name = 'inmolink/' + short;
		var type = wp.blocks.getBlockType( name );
		if ( type ) {
			return;
		}
		wp.blocks.registerBlockType( name, {
			edit: function ( props ) {
				var blockType = wp.blocks.getBlockType( name );
				var schema = ( blockType && blockType.attributes ) || {};
				var set = function ( key, value ) {
					var patch = {};
					patch[ key ] = value;
					props.setAttributes( patch );
				};
				var controls = Object.keys( schema )
					.filter( function ( key ) {
						return key !== 'lock' && key !== 'metadata' && key !== 'className' && key !== 'align';
					} )
					.map( function ( key ) {
						return control( key, schema[ key ], props.attributes[ key ], set );
					} );
				return el(
					'div',
					useBlockProps(),
					el( InspectorControls, null, el( PanelBody, { title: __( 'Settings', 'inmolink' ) }, controls ) ),
					el( ServerSideRender, { block: name, attributes: props.attributes } )
				);
			},
			save: function () {
				return null;
			},
		} );
	} );
} )( window.wp );
