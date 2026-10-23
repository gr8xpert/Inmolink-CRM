import { defineConfig } from 'tsdown';

export default defineConfig({
  // One public entry per module (`@inmolink/core/modules/<module>`, PATTERNS §0).
  entry: ['src/index.ts', 'src/modules/*/index.ts', 'src/modules/exports/worker.ts'],
  format: 'esm',
  fixedExtension: false,
  platform: 'node',
  dts: true,
});
