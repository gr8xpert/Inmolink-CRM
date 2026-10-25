import { CreateContactBody, CreateLeadBody } from '@inmolink/contracts';
import { closeDb } from '@inmolink/db';
import { adminQuery, setupTestDb } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as crm from '../index';
import { sweepDelayOf } from '../jobs';

/** S13-F15: an agency whose leads predate the report rollups gets them from the nightly sweep. */

const log = createLogger({ service: 'crm-rollups-backfill-test', level: 'silent' });
const jobCtx = () => ({
  log,
  jobId: 'test',
  attempt: 1,
  progress: async () => {},
  signal: new AbortController().signal,
});

let r: Founder;
const as = <T>(fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: r.userId, agencyId: r.agencyId, requestId: newId(), locale: 'en' }, fn);

const rollupRows = async () => ({
  stages: (await adminQuery('select 1 from crm_stage_counts where agency_id = $1', [r.agencyId])).length,
  days: (await adminQuery('select 1 from crm_response_rollups where agency_id = $1', [r.agencyId])).length,
});

beforeAll(async () => {
  await setupTestDb('worker');
  r = await createFounder();
  for (let i = 0; i < 3; i++) {
    const { contact } = await as((ctx) =>
      crm.createContact(ctx, CreateContactBody.parse({ firstName: 'Old', emails: [`old-${newId()}@example.com`] })),
    );
    await as((ctx) => crm.createLead(ctx, CreateLeadBody.parse({ contactId: contact.id, source: 'PORTAL' })));
  }
  // pre-0137 data: old leads (older than the rebuild's lag cutoff) with no rollup rows at all
  await adminQuery(
    "update lead_stage_history set changed_at = date_trunc('milliseconds', now() - interval '3 days') where agency_id = $1",
    [r.agencyId],
  );
  await adminQuery("update leads set stage_entered_at = now() - interval '3 days' where agency_id = $1", [r.agencyId]);
  await adminQuery('delete from crm_stage_counts where agency_id = $1', [r.agencyId]);
  await adminQuery('delete from crm_response_rollups where agency_id = $1', [r.agencyId]);
  await adminQuery('delete from crm_stage_move_rollups where agency_id = $1', [r.agencyId]);
});

afterAll(async () => {
  await closeDb();
});

describe('rollup backfill', () => {
  it('[S13-F15] an agency with old leads and no rollups gets them from the sweep', async () => {
    expect(await rollupRows()).toEqual({ stages: 0, days: 0 });
    const rebuild = vi.spyOn(crm.crmJobs.rebuildReportRollups, 'enqueueMany').mockResolvedValue([]);
    const full = vi.spyOn(crm.crmJobs.refreshStageCounts, 'enqueueMany').mockResolvedValue([]);
    try {
      const out = (await crm.crmJobs.sweepStageCounts.spec.run({}, jobCtx())) as { rebuilds: number };
      expect(out.rebuilds).toBeGreaterThanOrEqual(1);
      expect(rebuild.mock.calls.flatMap((c) => c[0])).toContainEqual({
        payload: { agencyId: r.agencyId },
        options: { delayMs: sweepDelayOf(r.agencyId) },
      });
    } finally {
      rebuild.mockRestore();
      full.mockRestore();
    }
    // the queued job rebuilds both rollups, and a rerun changes nothing
    await crm.crmJobs.rebuildReportRollups.spec.run({ agencyId: r.agencyId }, jobCtx());
    const first = await rollupRows();
    expect(first.stages).toBeGreaterThan(0);
    expect(first.days).toBeGreaterThan(0);
    await crm.crmJobs.rebuildReportRollups.spec.run({ agencyId: r.agencyId }, jobCtx());
    expect(await rollupRows()).toEqual(first);
  });

  it('[S13-F15] an agency that has rollups is not queued for the whole rebuild', async () => {
    const rebuild = vi.spyOn(crm.crmJobs.rebuildReportRollups, 'enqueueMany').mockResolvedValue([]);
    const full = vi.spyOn(crm.crmJobs.refreshStageCounts, 'enqueueMany').mockResolvedValue([]);
    try {
      await crm.crmJobs.sweepStageCounts.spec.run({}, jobCtx());
      const ids = rebuild.mock.calls.flatMap((c) => c[0]).map((j) => j.payload.agencyId);
      expect(ids).not.toContain(r.agencyId);
    } finally {
      rebuild.mockRestore();
      full.mockRestore();
    }
  });
});
