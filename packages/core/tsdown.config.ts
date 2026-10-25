import { defineConfig } from 'tsdown';

export default defineConfig({
  // One public entry per module (`@inmolink/core/modules/<module>`, PATTERNS §0).
  entry: [
    'src/index.ts',
    'src/modules/*/index.ts',
    // A module's worker-only entry (`@inmolink/core/modules/<module>/worker`): every one, so a new one ships too.
    'src/modules/*/worker.ts',
  ],
  format: 'esm',
  fixedExtension: false,
  platform: 'node',
  dts: true,
});
