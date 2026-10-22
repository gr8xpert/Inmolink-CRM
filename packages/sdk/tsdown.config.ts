import { defineConfig } from 'tsdown';
import { widgetConfig } from './tsdown.widget.ts';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: 'esm',
    fixedExtension: false,
    platform: 'neutral',
    dts: true,
  },
  widgetConfig,
]);
