import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// S12-01 (ADR 0018)
import { aiJobs } from '@inmolink/core';
import { adminJobs } from '@inmolink/core/modules/admin';
import { chatJobs } from '@inmolink/core/modules/chat';
import { crmJobs } from '@inmolink/core/modules/crm';
import { importsJobs } from '@inmolink/core/modules/imports';
import { notificationsJobs } from '@inmolink/core/modules/notifications';
import { socialJobs } from '@inmolink/core/modules/social';
import { describe, expect, it } from 'vitest';
import { DIGEST_CONCURRENCY, POOL_JOBS, POOL_OPTIONS } from './index';

const poolOf = (name: string) =>
  Object.entries(POOL_JOBS)
    .filter(([, jobs]) => jobs.some((j) => j.name === name))
    .map(([pool]) => pool);

describe('worker pools (S11 review)', () => {
  it('[S13-03] staff bulk operations and their lost-job sweep run in the maintenance pool', () => {
    expect(poolOf(adminJobs.runStaffOperation.name)).toEqual(['maintenance']);
    expect(poolOf(adminJobs.sweepStaffOperations.name)).toEqual(['maintenance']);
  });

  it('[S11-review] each pool lists only its own jobs, each job once', () => {
    for (const [pool, jobs] of Object.entries(POOL_JOBS)) for (const job of jobs) expect(job.pool, job.name).toBe(pool);
    const names = Object.values(POOL_JOBS).flatMap((jobs) => jobs.map((j) => j.name));
    expect(new Set(names).size).toBe(names.length);
  });

  it('[S11-review] digests run in their own pool, with their own slots and no per-process cap to bounce off', () => {
    const digest = notificationsJobs.sendDigest;
    expect(digest.pool).toBe('digest');
    expect(poolOf(digest.name)).toEqual(['digest']);
    expect(POOL_JOBS.digest.map((j) => j.name)).toEqual([digest.name]);
    expect(digest.spec.perProcessConcurrency).toBeUndefined();
    expect(digest.spec.globalConcurrency).toBeUndefined();
    expect(digest.spec.capGroup).toBeUndefined();
    expect(POOL_OPTIONS.digest?.concurrency).toBe(DIGEST_CONCURRENCY);
  });

  it('[S11-review] live pushes run in the realtime pool, never with digests or mail, and nothing there is capped', () => {
    const live = [
      chatJobs.deliverMessage,
      chatJobs.pushRead,
      notificationsJobs.pushRealtime,
      // S12-F2: notifications raised after the commit
      crmJobs.notifyLeadAssigned,
      importsJobs.notifyConnectionPaused,
      // S12-07: a social account to reconnect, announced to the admins.
      socialJobs.notifyReconnect,
    ];
    for (const job of live) {
      expect(job.pool, job.name).toBe('realtime');
      expect(poolOf(job.name), job.name).toEqual(['realtime']);
    }
    expect(POOL_JOBS.realtime.map((j) => j.name).sort()).toEqual(live.map((j) => j.name).sort());
    for (const job of POOL_JOBS.realtime) {
      expect(job.spec.perProcessConcurrency, job.name).toBeUndefined();
      expect(job.spec.globalConcurrency, job.name).toBeUndefined();
      expect(job.spec.concurrencyPerGroup, job.name).toBeUndefined();
    }
    // The delivery pool keeps no per-process-capped job either (a capped job bounces through delayed).
    for (const job of POOL_JOBS.email) expect(job.spec.perProcessConcurrency, job.name).toBeUndefined();
  });

  it('[S12-01] the ai-usage queue holds only the request-path usage jobs; feed_ai reaches that queue alone', () => {
    expect(POOL_JOBS['ai-usage'].map((j) => j.name).sort()).toEqual(['ai.recordUsage', 'ai.refreshSpend']);
    expect(poolOf('ai.recordUsage')).toEqual(['ai-usage']);
    expect(POOL_JOBS.ai.map((j) => j.name)).toContain(aiJobs.retryUsageRecord.name);
    const vars = readFileSync(
      join(import.meta.dirname, '..', '..', '..', '..', 'infra', 'ansible', 'group_vars', 'all.yml'),
      'utf8',
    );
    const acl = /^redis_feed_ai_acl: "([^"]+)"/m.exec(vars)?.[1] ?? '';
    const keys = acl.split(' ').filter((t) => t.startsWith('~'));
    expect(keys).toEqual(['~inl:ai-usage:*', '~inl:fair:ai-usage:*']);
    expect(acl).toContain('-@blocking');
  });
});
