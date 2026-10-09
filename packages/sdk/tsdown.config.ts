import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  fixedExtension: false,
  platform: 'neutral',
  dts: true,
});
