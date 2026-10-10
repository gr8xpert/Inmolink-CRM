import { defineConfig } from 'tsdown';

export default defineConfig({
  // `schema/*` entries: repos import only their own module's tables (`@inmolink/db/schema/<module>`).
  entry: ['src/index.ts', 'src/migrate.ts', 'src/schema/*.ts'],
  format: 'esm',
  fixedExtension: false,
  platform: 'node',
  dts: true,
});
