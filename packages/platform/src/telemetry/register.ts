/**
 * Preload for Node apps: `node --import @inmolink/platform/telemetry/register dist/main.js`
 * (`tsx --import …` in dev). Installs the ESM loader hook, so modules imported from ESM are patchable,
 * then registers the instrumentations — before `main.ts` loads `pg`, `ioredis` or `http`.
 * It reads no configuration; `main.ts` calls `startTelemetry()` once its config is loaded.
 */
import { register } from 'node:module';
import { registerDefaultInstrumentations } from './instrumentations';

register('@opentelemetry/instrumentation/hook.mjs', import.meta.url, {
  // Only the patched libraries go through import-in-the-middle; everything else loads untouched.
  // (Global fetch is traced through diagnostics_channel, http through node:http — no hook needed.)
  data: { include: ['pg', 'pg-pool', 'ioredis'] },
});
registerDefaultInstrumentations();
