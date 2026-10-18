import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/values.ts', 'src/developments-csv.ts'],
  format: 'esm',
  fixedExtension: false,
  platform: 'neutral',
  dts: true,
});
