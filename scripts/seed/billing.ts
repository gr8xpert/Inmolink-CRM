import * as billing from '@inmolink/core/modules/billing';
import { withSystem } from '@inmolink/db';
import { newId } from '@inmolink/platform/ids';
import { sql } from 'drizzle-orm';
import { readCatalog } from '../ops/billing-catalog';
import type { Seeder, SeedResult } from './seeders';

/**
 * The plan catalog (S13-01): reference data, not demo data — the bundled `scripts/ops/billing-catalog.json`, the same
 * for the dev and the scale seed, written idempotently. Production runs `pnpm billing:catalog`.
 */
async function sync(): Promise<SeedResult> {
  return withSystem('seed.billing.catalog', async (tx) => {
    const count = async () =>
      Number((await tx.execute<{ n: number }>(sql`select count(*)::int as n from billing_prices`)).rows[0]?.n ?? 0);
    const before = await count();
    await billing.upsertCatalog(tx, readCatalog(), newId);
    const total = await count();
    return { inserted: total - before, total };
  });
}

export const billingSeeder: Seeder = { name: 'billing.catalog', dev: sync, scale: sync };
