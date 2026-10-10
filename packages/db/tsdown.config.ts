import { defineConfig } from 'tsdown';

export default defineConfig({
  // `cli/deploy`: deploys run `node packages/db/dist/cli/deploy.js` (migrations + RLS + guard) from the worker image (S0-15).
  // `schema/*` entries: repos import only their own module's tables (`@inmolink/db/schema/<module>`).
  entry: ['src/index.ts', 'src/migrate.ts', 'src/cli/deploy.ts', 'src/schema/*.ts'],
  format: 'esm',
  fixedExtension: false,
  platform: 'node',
  dts: true,
});
