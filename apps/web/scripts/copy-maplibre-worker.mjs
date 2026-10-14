// Copies MapLibre's worker (and the shared chunk it imports by relative path) to `public/maplibre/`, so the
// staff taxonomy map can `setWorkerUrl('/maplibre/maplibre-gl-worker.mjs')` (S2-04). Next bundles cannot
// resolve the worker themselves. Runs before `dev` and `build`; the copies are git-ignored.
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const dist = dirname(require.resolve('maplibre-gl/dist/maplibre-gl.mjs'));
const out = join(import.meta.dirname, '..', 'public', 'maplibre');
mkdirSync(out, { recursive: true });
for (const file of ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs'])
  copyFileSync(join(dist, file), join(out, file));
