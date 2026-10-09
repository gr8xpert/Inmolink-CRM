import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/migrate.ts'],
  format: 'esm',
  fixedExtension: false,
  platform: 'node',
  dts: true,
});
