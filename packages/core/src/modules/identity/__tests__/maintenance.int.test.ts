import { closeDb, withSystem } from '@inmolink/db';
import { setupTestDb } from '@inmolink/db/testing';
import { restoreClock, useFakeClock } from '@inmolink/platform/clock';
import { newToken } from '@inmolink/platform/crypto';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as identity from '../index';

/** Identity maintenance jobs on the real test database (S1-F4). */

const log = createLogger({ service: 'identity-maintenance-test', level: 'silent' });
const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
const DAY = 24 * 60 * 60_000;

beforeAll(async () => {
  await setupTestDb('worker');
  identity.configureIdentity({ hmacKey: 'test-hmac-key-0123456789abcdef0123456789' });
}, 120_000);

afterEach(() => restoreClock());

afterAll(async () => {
  await closeDb();
});

const runPrune = () =>
  identity.identityJobs.pruneAuthTokens.spec.run(
    {},
    { log, jobId: newId(), attempt: 1, progress: async () => {}, signal: new AbortController().signal },
  );

describe('identity maintenance', () => {
  it('[S1-F4] expired and used tokens older than 7 days are deleted by the job', async () => {
    useFakeClock(NOW);
    const userId = newId();
    const token = (label: string, expiresAt: number, usedAt: number | null) => ({
      id: newId(),
      label,
      expiresAt: new Date(expiresAt),
      usedAt: usedAt === null ? null : new Date(usedAt),
    });
    const tokens = [
      token('expired 8 days ago', NOW - 8 * DAY, null),
      token('used 9 days ago', NOW - 8 * DAY - 12 * 60 * 60_000, NOW - 9 * DAY),
      token('expired 6 days ago', NOW - 6 * DAY, null),
      token('used yesterday, expired today', NOW - 60_000, NOW - DAY),
      token('used 8 days ago, would expire later', NOW + DAY, NOW - 8 * DAY),
      token('still valid', NOW + DAY, null),
    ];
    await withSystem('maintenance test: seed tokens', async (tx) => {
      await tx.execute(
        sql`insert into users (id, email, password_hash, name, locale)
            values (${userId}, ${`prune-${newToken(6).toLowerCase()}@example.com`}, 'x', 'Ana', 'en')`,
      );
      for (const t of tokens) {
        await tx.execute(
          sql`insert into auth_tokens (id, user_id, kind, token_hash, expires_at, used_at)
              values (${t.id}, ${userId}, 'PASSWORD_RESET', ${newToken()}, ${t.expiresAt}, ${t.usedAt})`,
        );
      }
    });

    expect(await runPrune()).toMatchObject({ deleted: expect.any(Number) });
    const left = await withSystem('maintenance test: read tokens', async (tx) => {
      const r = await tx.execute<{ id: string }>(sql`select id from auth_tokens where user_id = ${userId}`);
      return new Set(r.rows.map((row) => row.id));
    });
    expect(tokens.filter((t) => left.has(t.id)).map((t) => t.label)).toEqual([
      'expired 6 days ago',
      'used yesterday, expired today',
      'still valid',
    ]);
    // Idempotent: a second run deletes nothing of this user's.
    await runPrune();
    const again = await withSystem('maintenance test: count', async (tx) => {
      const r = await tx.execute<{ n: number }>(
        sql`select count(*)::int as n from auth_tokens where user_id = ${userId}`,
      );
      return r.rows[0]?.n;
    });
    expect(again).toBe(3);
  });

  it('[S1-F4] the prune job is recurring, in the maintenance pool', () => {
    const job = identity.identityJobs.pruneAuthTokens;
    expect(job.pool).toBe('maintenance');
    expect(job.spec.every).toBe(6 * 60 * 60_000);
  });
});
