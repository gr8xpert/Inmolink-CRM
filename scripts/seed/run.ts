import { performance } from 'node:perf_hooks';
import { type DevSeedOptions, type Login, type ScaleSeedOptions, SEEDERS, type SeedResult } from './seeders';

export interface SeedReport {
  seconds: number;
  results: Record<string, SeedResult>;
  logins: Login[];
}

/**
 * Default demo password. Not a secret: the dev seed refuses NODE_ENV=production, and these users
 * exist only on dev, test and (scale) staging databases. Override with SEED_DEMO_PASSWORD.
 */
export const DEFAULT_DEMO_PASSWORD = 'Inmolink-demo-2026';

/**
 * Seeds write fake, verified, active users: never against production data. With NODE_ENV=production
 * only the scale seed runs, and only when all three hold: `--staging`, `DEPLOY_ENV=staging` (set by
 * the staging deploy, not by hand) and a `SEED_SCALE_PASSWORD` other than the committed default.
 */
export function assertSeedTarget(staging?: { allowStaging: boolean; scalePassword: string }): void {
  if (process.env.NODE_ENV !== 'production') return;
  if (!staging?.allowStaging) {
    throw new Error('refusing to seed with NODE_ENV=production (scale seed on staging: pass --staging)');
  }
  if (process.env.DEPLOY_ENV !== 'staging') {
    throw new Error('refusing to seed: NODE_ENV=production and DEPLOY_ENV is not "staging"');
  }
  if (staging.scalePassword === DEFAULT_DEMO_PASSWORD) {
    throw new Error('refusing to seed staging with the committed demo password: set SEED_SCALE_PASSWORD');
  }
}

/** `pnpm db:seed`: 5 demo agencies' data. The DB must be configured (`configureDb`) by the caller. */
export async function runDevSeed(options: DevSeedOptions): Promise<SeedReport> {
  assertSeedTarget();
  const t0 = performance.now();
  const results: Record<string, SeedResult> = {};
  const logins: Login[] = [];
  for (const seeder of SEEDERS) {
    const result = await seeder.dev(options);
    results[seeder.name] = result;
    logins.push(...(result.logins ?? []));
  }
  return { seconds: (performance.now() - t0) / 1000, results, logins };
}

/** `pnpm db:seed:scale`: §4.1 ratios × `agencies`, COPY-based, deterministic per `seed`. */
export async function runScaleSeed(
  options: ScaleSeedOptions,
  hooks: { allowStaging?: boolean; onSeeder?: (name: string) => void } = {},
): Promise<SeedReport> {
  assertSeedTarget({ allowStaging: hooks.allowStaging ?? false, scalePassword: options.scalePassword });
  if (!Number.isInteger(options.agencies) || options.agencies < 1) throw new RangeError('agencies must be ≥ 1');
  if (!Number.isInteger(options.chunk) || options.chunk < 1) throw new RangeError('chunk must be ≥ 1');
  const t0 = performance.now();
  const results: Record<string, SeedResult> = {};
  for (const seeder of SEEDERS) {
    hooks.onSeeder?.(seeder.name);
    results[seeder.name] = await seeder.scale(options);
  }
  return { seconds: (performance.now() - t0) / 1000, results, logins: [] };
}
