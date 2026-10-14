/**
 * agencies worker jobs (PATTERNS §12): `defineJob({ name: 'agencies.<verb><Entity>', … })` from
 * `@inmolink/platform/queue`. Idempotent, batched, per-tenant fair share.
 */
import { type Tx, withSystem } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
import { defineJob } from '@inmolink/platform/queue';
import { storage } from '@inmolink/platform/storage';
import { z } from 'zod';
import * as repo from './repo';
import * as settingsRepo from './settings-repo';

/** An object this young may still be between "stored" and "recorded" in an upload: leave it alone. */
export const ORPHAN_MIN_AGE_MS = 24 * 60 * 60_000;
const LIST_PAGE = 500;
/** Pages per prefix and run (100k objects): bounds one run; a larger bucket needs a persisted cursor (S3-03). */
const MAX_PAGES = 200;

/** Private-bucket prefixes this module writes, and the rows that keep their objects. */
const OWNED_PREFIXES: { prefix: string; existing: (tx: Tx, keys: string[]) => Promise<Set<string>> }[] = [
  { prefix: 'verification/', existing: repo.existingStorageKeys },
  // Logo stub until S3-03 (S1-06): replaced logos whose delete failed.
  { prefix: 'agency-logos/', existing: settingsRepo.existingLogoKeys },
];

export const agenciesJobs = {
  /**
   * Maintenance (S1-F7): deletes `verification/<agency>/…` and `agency-logos/<agency>/…` objects that no
   * row points to — a crash between store and record, a failed delete, a deleted agency — once they are
   * 24 h old. Lists the private bucket a page at a time, checks each page against the table in one
   * query, deletes the rest. Idempotent; runs every 6 hours.
   */
  pruneOrphanVerificationDocuments: defineJob({
    name: 'agencies.pruneOrphanVerificationDocuments',
    pool: 'maintenance',
    payload: z.object({}).strict(),
    every: 6 * 60 * 60_000,
    attempts: 3,
    timeoutMs: 5 * 60_000,
    async run(_p, { log, signal }) {
      const cutoff = clock.now().getTime() - ORPHAN_MIN_AGE_MS;
      let scanned = 0;
      let deleted = 0;
      for (const { prefix, existing } of OWNED_PREFIXES) {
        let after: string | undefined;
        for (let page = 0; page < MAX_PAGES && !signal.aborted; page++) {
          const listed = await storage().list('private', prefix, { limit: LIST_PAGE, after });
          const old = listed.objects.filter((o) => o.lastModified.getTime() <= cutoff).map((o) => o.key);
          scanned += listed.objects.length;
          const known = await withSystem('agencies.pruneOrphanVerificationDocuments', (tx) => existing(tx, old));
          for (const key of old) {
            if (known.has(key)) continue;
            await storage().delete('private', key);
            deleted++;
          }
          if (!listed.next) break;
          after = listed.next;
        }
      }
      log.info({ scanned, deleted }, 'orphan private objects pruned');
      return { scanned, deleted };
    },
  }),
};
