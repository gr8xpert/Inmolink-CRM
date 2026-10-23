import * as exportsModule from '@inmolink/core/modules/exports';
import { withSystem } from '@inmolink/db';
import { sql } from 'drizzle-orm';
import type { Seeder, SeedResult } from './seeders';

/**
 * The portal catalog (S9-01): Kyero, thinkSPAIN, A Place in the Sun, generic XML, idealista and Fotocasa. Reference
 * data, not demo data: the same rows for the dev and the scale seed, written idempotently (an upsert), so a fresh
 * stack can connect a portal. Production runs `pnpm exports:sync-channels` (docs/runbooks/deploy.md).
 */
async function sync(): Promise<SeedResult> {
  return withSystem('seed.exports.portal_channels', async (tx) => {
    const count = async () =>
      Number((await tx.execute<{ n: number }>(sql`select count(*)::int as n from portal_channels`)).rows[0]?.n ?? 0);
    const before = await count();
    await exportsModule.syncPortalChannels(tx);
    const total = await count();
    return { inserted: total - before, total };
  });
}

export const exportsSeeder: Seeder = {
  name: 'exports.portal_channels',
  dev: sync,
  scale: sync,
};
