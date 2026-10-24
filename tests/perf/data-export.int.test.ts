import { PageQuery } from '@inmolink/contracts';
import { withMemberCtx } from '@inmolink/core';
import * as compliance from '@inmolink/core/modules/compliance';
import { dataExportJobs } from '@inmolink/core/modules/compliance/worker';
import { createFounder, type Founder } from '@inmolink/core/test';
import { closeDb, withSystem } from '@inmolink/db';
import { setupTestDb } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { configureStorage, createMemoryStore } from '@inmolink/platform/storage';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Data export at scale (S10-08): a 100k-contact export is a worker job — the request only queues it, and the API
 * keeps answering while the job streams the file (one short transaction per page, nothing held across the run, the
 * file never in memory as a whole beyond the upload). In the `perf` project: the 100k seed is too heavy for the core
 * int forks on Windows.
 */

const CONTACTS = 100_000;
const log = createLogger({ service: 'data-export-perf', level: 'silent' });
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('compliance.dataExport.perf', fn);
const store = createMemoryStore();
let founder: Founder;

const as = <T>(fn: Parameters<typeof withMemberCtx<T>>[1]) =>
  withMemberCtx({ userId: founder.userId, agencyId: founder.agencyId, requestId: newId(), locale: 'en' }, fn);

beforeAll(async () => {
  await setupTestDb('worker');
  configureStorage(store);
  founder = await createFounder();
  await system(async (tx) => {
    await tx.execute(sql`insert into contacts (id, agency_id, first_name, last_name, tags, consent_processing)
      select gen_random_uuid(), ${founder.agencyId}, 'Contact', 'Number ' || g, array['buyer', 'perf'], true
        from generate_series(1, ${CONTACTS}) g`);
    await tx.execute(sql`insert into contact_emails (id, agency_id, contact_id, email)
      select gen_random_uuid(), agency_id, id, 'perf-' || id || '@example.com' from contacts
       where agency_id = ${founder.agencyId}`);
  });
}, 300_000);

afterAll(async () => {
  await system(async (tx) => {
    await tx.execute(sql`delete from data_export_jobs where agency_id = ${founder.agencyId}`);
  });
  // in batches: each contact's FK cascade probes every monthly `activities` partition, so one 100k-row delete
  // outlives the statement timeout (CI 04e7af0)
  for (;;) {
    const deleted = await system(async (tx) => {
      const res = await tx.execute(sql`delete from contacts where id in (
          select id from contacts where agency_id = ${founder.agencyId} limit 5000)`);
      return res.rowCount ?? 0;
    });
    if (deleted === 0) break;
  }
  await closeDb();
}, 300_000);

describe('data export at scale', () => {
  it('[S10-08] a 100k-contact export completes as a job without blocking the API', async () => {
    const requestStart = performance.now();
    const { export: queued } = await as((ctx) =>
      // the 2FA step-up (S11-F14) is the api's and has its own tests; the scale test measures the export
      compliance.createDataExport(ctx, { kind: 'CONTACTS', format: 'xlsx' }, { verifyStepUp: async () => {} }),
    );
    const requestMs = performance.now() - requestStart;
    expect(queued.status).toBe('QUEUED');
    // the request only records the export: no file, a few statements
    expect(requestMs).toBeLessThan(1_000);
    expect(store.objects.size).toBe(0);

    const rssBefore = process.memoryUsage().rss;
    let rssPeak = rssBefore;
    const apiLatencies: number[] = [];
    let running = true;
    // the dashboard API meanwhile: the export list, answered from its own short transaction
    const api = (async () => {
      while (running) {
        const t = performance.now();
        await as((ctx) => compliance.listDataExports(ctx, PageQuery.parse({})));
        apiLatencies.push(performance.now() - t);
        rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    })();

    const jobStart = performance.now();
    const result = await dataExportJobs.runDataExport.spec.run(
      { agencyId: founder.agencyId, exportId: queued.id },
      { log, jobId: queued.id, attempt: 1, progress: async () => {}, signal: new AbortController().signal },
    );
    const jobMs = performance.now() - jobStart;
    running = false;
    await api;

    expect(result).toEqual({ status: 'SUCCEEDED' });
    const done = await as((ctx) => compliance.getDataExport(ctx, queued.id, { download: true }));
    expect(done.counts).toEqual({ contacts: CONTACTS });
    expect(done.fileBytes).toBeGreaterThan(0);
    expect(done.download).not.toBeNull();
    expect(jobMs).toBeLessThan(180_000);

    // the API kept answering during the run
    expect(apiLatencies.length).toBeGreaterThan(5);
    const sorted = [...apiLatencies].sort((x, y) => x - y);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    expect(p95).toBeLessThan(300);
    // streamed: memory grows by the stored file (the memory store keeps it) and a page, never by the rows
    const stored = store.objects.get(`private/${compliance.dataExportKey(founder.agencyId, queued.id)}`)?.body;
    expect(stored?.byteLength).toBe(done.fileBytes);
    expect(rssPeak - rssBefore).toBeLessThan(256 * 1024 * 1024);
    console.info(
      `[S10-08] request ${requestMs.toFixed(0)} ms; job ${(jobMs / 1000).toFixed(1)} s for ${CONTACTS} contacts, ` +
        `${((done.fileBytes ?? 0) / 1048576).toFixed(1)} MB; API p95 ${p95.toFixed(0)} ms over ${apiLatencies.length} calls; ` +
        `RSS +${((rssPeak - rssBefore) / 1048576).toFixed(0)} MB`,
    );
  });
});
