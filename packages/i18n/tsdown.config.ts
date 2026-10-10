import { defineConfig } from 'tsdown';

export default defineConfig({
  // `index` is platform-neutral code; `server` bundles the catalogs (catalogs.generated.ts); `tools`
  // reads and writes `../messages` on disk (scripts and tests only).
  entry: ['src/index.ts', 'src/server.ts', 'src/tools.ts'],
  format: 'esm',
  fixedExtension: false,
  platform: 'node',
  dts: true,
});
