import type { UserConfig } from 'tsdown';

/**
 * The JS widget (S8-06): one self-contained minified script for any web page, no runtime dependencies. tsdown names
 * an IIFE `<entry>.iife.js`, so the file is `inmolink-widget.iife.js`.
 */
export const widgetConfig: UserConfig = {
  entry: { 'inmolink-widget': 'src/widget/index.ts' },
  outDir: 'dist-widget',
  format: 'iife',
  globalName: 'InmolinkWidget',
  platform: 'browser',
  target: 'es2020',
  minify: true,
  dts: false,
  fixedExtension: true,
  deps: { alwaysBundle: [/.*/] },
  // Workspace packages from their source: a CI checkout has no `dist` of `@inmolink/i18n`, and an unresolved import is
  // left external, i.e. a global the page does not have.
  inputOptions: { resolve: { conditionNames: ['@inmolink/source', 'import', 'module', 'default'] } },
};

export const WIDGET_FILE = 'inmolink-widget.iife.js';
