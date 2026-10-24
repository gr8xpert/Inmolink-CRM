import { inflateRawSync } from 'node:zlib';
import { CreateContactBody, CreateDataExportBody, CreateLeadBody, PageQuery } from '@inmolink/contracts';
import { closeDb, withSystem } from '@inmolink/db';
import { setupTestDb } from '@inmolink/db/testing';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { UnrecoverableError } from '@inmolink/platform/queue';
import { readSheetRows } from '@inmolink/platform/sheet';
import { configureStorage, createMemoryStore, type ObjectStore } from '@inmolink/platform/storage';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder, impersonatedCtx } from '../../../testing/factories';
import * as crm from '../../crm';
import * as taxonomy from '../../taxonomy';
import * as compliance from '../index';
import {
  configureDataExport,
  configureDataExportNotice,
  dataExportNoticeRecipients,
  EXPORT_PAGE_ROWS,
  renderDataExportNotice,
  runDataExport,
  sweepDataExports,
} from '../worker';

/**
 * Data export (S10-08): the request only queues; the worker job streams contacts, leads and listings as CSV / XLSX
 * (or the account ZIP) to storage, formula injection handled; a short signed link, on request, while the export lives
 * (7 days); the admins are told by e-mail.
 */

const RUN = newId().slice(-8).toLowerCase();
const code = (s: string) => `${s}-${RUN}`;
const tr = (name: string, slug: string) => [{ locale: 'en', name, slug: code(slug) }];
const log = createLogger({ service: 'data-export-test', level: 'silent' });
const job = (lastAttempt = true) => ({ log, signal: new AbortController().signal, lastAttempt });
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('compliance.dataExport.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);
const store = createMemoryStore();

/** Test hooks into the store's uploads: fail a write, or act just before `complete` returns. */
const hooks: { onWrite?: () => void; beforeComplete?: () => Promise<void> } = {};
const hookedStore: ObjectStore = {
  ...store,
  upload(bucket, key, options) {
    const inner = store.upload(bucket, key, options);
    return {
      async write(chunk) {
        hooks.onWrite?.();
        await inner.write(chunk);
      },
      async complete() {
        const result = await inner.complete();
        await hooks.beforeComplete?.();
        return result;
      },
      abort: () => inner.abort(),
    };
  },
};

let a: Founder;
let b: Founder;
let agentId: string;
let listingId: string;

const as = <T>(m: { userId: string; agencyId: string }, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);
const createResult = (m: { userId: string; agencyId: string }, body: Record<string, unknown>, key?: string) =>
  as(m, (ctx) =>
    compliance.createDataExport(ctx, CreateDataExportBody.parse(body), key ? { idempotencyKey: key } : {}),
  );
const create = async (m: { userId: string; agencyId: string }, body: Record<string, unknown>) =>
  (await createResult(m, body)).export;
const get = (m: Founder, id: string, download = false) =>
  as(m, (ctx) => compliance.getDataExport(ctx, id, { download }));

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (isAppError(err)) return err.code;
    throw err;
  }
  return 'accepted';
}

const file = (agencyId: string, exportId: string) =>
  store.objects.get(`private/${compliance.dataExportKey(agencyId, exportId)}`)?.body;

const sheet = async (bytes: Uint8Array): Promise<string[][]> => {
  const out: string[][] = [];
  for await (const r of readSheetRows(bytes)) out.push(r.cells);
  return out;
};

/** A ZIP's entries by name (central directory; stored or inflated). */
function unzip(zip: Buffer): Map<string, Buffer> {
  const eocd = zip.length - 22;
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i += 1) {
    const method = zip.readUInt16LE(p + 10);
    const compressed = zip.readUInt32LE(p + 20);
    const nameLength = zip.readUInt16LE(p + 28);
    const offset = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLength).toString('utf8');
    const local = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    const raw = zip.subarray(local, local + compressed);
    out.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw));
    p += 46 + nameLength;
  }
  return out;
}

/** Runs an export to the end and returns its finished state, with a download link. */
async function exportOf(m: Founder, body: Record<string, unknown>) {
  const queued = await create(m, body);
  expect(await runDataExport({ agencyId: m.agencyId, exportId: queued.id }, job())).toEqual({ status: 'SUCCEEDED' });
  return get(m, queued.id, true);
}

beforeAll(async () => {
  await setupTestDb('worker');
  configureStorage(hookedStore);
  configureDataExport({ mediaBaseUrl: 'https://media.example.com/' });
  configureDataExportNotice({ webUrl: 'https://app.example.com/' });
  [a, b] = await Promise.all([createFounder(), createFounder()]);
  agentId = newId();
  await system(async (tx) => {
    await tx.execute(sql`insert into users (id, email, password_hash, name, locale, status)
      values (${agentId}, ${`export-agent-${agentId}@example.com`}, 'x', 'Agent', 'es', 'ACTIVE')`);
    await tx.execute(sql`insert into agency_members (agency_id, user_id, role, name, email)
      values (${a.agencyId}, ${agentId}, 'AGENT', 'Agent', ${`export-agent-${agentId}@example.com`})`);
  });
  const ids = await system(async (tx) => {
    const location = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('dx'),
      translations: tr(`Exportland ${RUN}`, 'exportland'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: code('dx-houses'),
      sort: 0,
      translations: tr(`Houses ${RUN}`, 'dx-houses'),
    });
    const type = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: code('dx-villa'),
      sort: 0,
      translations: tr(`Villa ${RUN}`, 'dx-villa'),
    });
    return { location, type };
  });
  const [listing] = await rows<{ id: string }>(sql`
    insert into properties (id, agency_id, owner_user_id, ref, status, visibility, transaction_type, price_cents,
                            bedrooms, built_m2, commission_bp, property_type_id, location_id)
    values (gen_random_uuid(), ${a.agencyId}, ${a.userId}, ${`-${code('REF')}`}, 'ACTIVE'::listing_status,
            'PRIVATE'::visibility, 'SALE', 35000050, 3, 120.5, 500, ${ids.type}, ${ids.location})
    returning id`);
  listingId = (listing as { id: string }).id;
  await rows(sql`insert into property_media (id, property_id, agency_id, kind, video_provider, video_id, position)
    values (gen_random_uuid(), ${listingId}, ${a.agencyId}, 'VIDEO', 'youtube', 'dQw4w9WgXcQ', 0) returning id`);
}, 120_000);

afterAll(async () => {
  await system(async (tx) => {
    for (const agencyId of [a.agencyId, b.agencyId]) {
      await tx.execute(sql`delete from data_export_jobs where agency_id = ${agencyId}`);
      await tx.execute(sql`delete from properties where agency_id = ${agencyId}`);
    }
  });
  await closeDb();
}, 120_000);

describe('the request', () => {
  it('[S10-08] creating an export only queues it: audited, an outbox event, no file until the job runs', async () => {
    const queued = await create(a, { kind: 'CONTACTS', format: 'csv' });
    expect(queued).toMatchObject({ kind: 'CONTACTS', format: 'csv', status: 'QUEUED', download: null });
    expect(file(a.agencyId, queued.id)).toBeUndefined();
    const [event] = await rows<{ payload: { exportId: string } }>(
      sql`select payload from outbox_events where agency_id = ${a.agencyId} and type = 'compliance.dataExport.requested'
          and payload->>'exportId' = ${queued.id}`,
    );
    expect(event?.payload.exportId).toBe(queued.id);
    const audits = await rows<{ type: string }>(
      sql`select type from audit_logs where agency_id = ${a.agencyId} and target_id = ${queued.id}`,
    );
    expect(audits.map((r) => r.type)).toEqual(['compliance.dataExport.requested']);
    // one export per agency at a time
    expect(await refusal(create(a, { kind: 'LEADS' }))).toBe('DATA_EXPORT_IN_PROGRESS');
    await runDataExport({ agencyId: a.agencyId, exportId: queued.id }, job());
  });

  it('[S10-08] an Idempotency-Key replays the first export for the same body and refuses another body', async () => {
    const key = `dx-key-${RUN}-0001`;
    const first = await createResult(b, { kind: 'LEADS', format: 'xlsx' }, key);
    expect(first.replayed).toBe(false);
    const again = await createResult(b, { kind: 'LEADS', format: 'xlsx' }, key);
    expect(again).toMatchObject({ replayed: true, export: { id: first.export.id } });
    expect(await refusal(createResult(b, { kind: 'CONTACTS' }, key))).toBe('IDEMPOTENCY_KEY_REUSED');
    const [{ n } = { n: 0 }] = await rows<{ n: number }>(
      sql`select count(*)::int as n from data_export_jobs where agency_id = ${b.agencyId}`,
    );
    expect(n).toBe(1);
    await runDataExport({ agencyId: b.agencyId, exportId: first.export.id }, job());
  });

  it('[S10-08] only the agency’s admins export: an agent is refused, another agency never sees the export', async () => {
    expect(await refusal(create({ userId: agentId, agencyId: a.agencyId }, { kind: 'CONTACTS' }))).toBe('FORBIDDEN');
    const done = await exportOf(a, { kind: 'LISTINGS', format: 'csv' });
    expect(await refusal(get(b, done.id))).toBe('DATA_EXPORT_NOT_FOUND');
    const list = await as(b, (ctx) => compliance.listDataExports(ctx, PageQuery.parse({})));
    expect(list.items.map((e) => e.id)).not.toContain(done.id);
    // staff impersonating the admin see the status, never a download link
    const status = await as(a, async (ctx) => compliance.getDataExport(await impersonatedCtx(ctx, newId()), done.id));
    expect(status.download).toBeNull();
    expect(
      await refusal(
        as(a, async (ctx) =>
          compliance.getDataExport(await impersonatedCtx(ctx, newId()), done.id, { download: true }),
        ),
      ),
    ).toBe('FORBIDDEN');
  });

  it('[S10-08] the admins are alerted by e-mail: who asked for what, no data and no download link', async () => {
    const done = await exportOf(a, { kind: 'CONTACTS', format: 'xlsx' });
    const message = await renderDataExportNotice({ agencyId: a.agencyId, exportId: done.id, userId: a.userId });
    expect(message?.subject).toMatch(/Contact/); // the founder's locale (en or es)
    expect(message?.text).toContain('https://app.example.com/');
    expect(message?.text).toMatch(/7 (days|días)/);
    expect(message?.text).not.toContain(compliance.dataExportKey(a.agencyId, done.id));
    // the alert goes to the agency's admins only, never to an agent
    const recipients = await dataExportNoticeRecipients({ agencyId: a.agencyId, exportId: done.id });
    expect(recipients).toContain(a.userId);
    expect(recipients).not.toContain(agentId);
    expect(await dataExportNoticeRecipients({ agencyId: b.agencyId, exportId: done.id })).toEqual([]);
  });
});

describe('the job', () => {
  it('[S10-08] cells starting with = + - @ are escaped: a quote in CSV, a quotePrefix style in XLSX', async () => {
    const contact = await as(a, (ctx) =>
      crm.createContact(
        ctx,
        CreateContactBody.parse({
          firstName: '=HYPERLINK("http://evil.example","x")',
          lastName: '@SUM(A1)',
          emails: [`dx-${RUN}@example.com`],
          tags: ['+1', '-2', 'plain'],
        }),
      ),
    );
    await as(a, (ctx) =>
      crm.createLead(ctx, CreateLeadBody.parse({ contactId: contact.contact.id, message: '=cmd|" /C calc"!A0' })),
    );
    const done = await exportOf(a, { kind: 'CONTACTS', format: 'csv' });
    const table = await sheet(file(a.agencyId, done.id) as Uint8Array);
    const header = table[0] as string[];
    const row = table.find((r) => r[header.indexOf('id')] === contact.contact.id) as string[];
    expect(row[header.indexOf('first_name')]).toBe('\'=HYPERLINK("http://evil.example","x")');
    expect(row[header.indexOf('last_name')]).toBe("'@SUM(A1)");
    expect(row[header.indexOf('emails')]).toBe(`dx-${RUN}@example.com`);
    expect(row[header.indexOf('tags')]).toBe("'+1; -2; plain");
    expect(row[header.indexOf('created_at')]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    const leads = await exportOf(a, { kind: 'LEADS', format: 'xlsx' });
    const workbook = file(a.agencyId, leads.id) as Uint8Array;
    const leadTable = await sheet(workbook);
    const leadRow = leadTable.find((r) => r.includes(contact.contact.id)) as string[];
    // the value as typed, shown as text by its style
    expect(leadRow[(leadTable[0] as string[]).indexOf('message')]).toBe('=cmd|" /C calc"!A0');
    const xml = unzip(Buffer.from(workbook)).get('xl/worksheets/sheet1.xml')?.toString('utf8') ?? '';
    expect(xml).toContain('s="2" t="inlineStr"><is><t xml:space="preserve">=cmd|&quot; /C calc&quot;!A0</t>');
    expect(xml).not.toContain('<f>');
  });

  it('[S10-08] contacts are read in keyset pages (ties on the creation time included) and only the agency’s own', async () => {
    const n = EXPORT_PAGE_ROWS + 50;
    // one statement: every row shares created_ms, so the pages are told apart by the id alone
    await rows(sql`insert into contacts (id, agency_id, first_name, last_name)
      select gen_random_uuid(), ${a.agencyId}, 'Bulk', 'Contact ' || g from generate_series(1, ${n}) g`);
    await rows(
      sql`insert into contacts (id, agency_id, first_name) values (gen_random_uuid(), ${b.agencyId}, ${code('other')})`,
    );
    const [{ total } = { total: 0 }] = await rows<{ total: number }>(
      sql`select count(*)::int as total from contacts where agency_id = ${a.agencyId} and deleted_at is null`,
    );
    const progress: object[] = [];
    const queued = await create(a, { kind: 'CONTACTS', format: 'xlsx' });
    await runDataExport(
      { agencyId: a.agencyId, exportId: queued.id },
      { ...job(), progress: async (v: object) => void progress.push(v) },
    );
    const done = await get(a, queued.id);
    expect(done.counts).toEqual({ contacts: total });
    expect(progress[0]).toEqual({ table: 'contacts', rows: EXPORT_PAGE_ROWS });
    const table = await sheet(file(a.agencyId, done.id) as Uint8Array);
    const ids = table.slice(1).map((r) => r[0]);
    expect(ids).toHaveLength(total);
    expect(new Set(ids).size).toBe(total);
    expect(table.some((r) => r.includes(code('other')))).toBe(false);
  });

  it('[S10-08] the account ZIP holds every table and the media manifest (workbooks stored, not deflated twice)', async () => {
    const done = await exportOf(a, { kind: 'ACCOUNT', format: 'csv' });
    expect(done.fileName).toMatch(/^inmolink-account-\d{4}-\d{2}-\d{2}\.zip$/);
    const entries = unzip(Buffer.from(file(a.agencyId, done.id) as Uint8Array));
    expect([...entries.keys()]).toEqual(['contacts.csv', 'leads.csv', 'listings.csv', 'media.csv', 'manifest.json']);
    const listings = await sheet(entries.get('listings.csv') as Buffer);
    const header = listings[0] as string[];
    const listing = listings.find((r) => r[0] === listingId) as string[];
    expect(listing[header.indexOf('ref')]).toBe(`'-${code('REF')}`); // a reference starting with '-' is escaped too
    expect(listing[header.indexOf('price')]).toBe('350000.5');
    expect(listing[header.indexOf('commission_bp')]).toBe('500');
    const media = await sheet(entries.get('media.csv') as Buffer);
    expect(media.slice(1)).toContainEqual([
      listingId,
      `'-${code('REF')}`,
      '1',
      'VIDEO',
      'false',
      '',
      '',
      '',
      '',
      '',
      'youtube',
      'dQw4w9WgXcQ',
    ]);
    const manifest = JSON.parse((entries.get('manifest.json') as Buffer).toString('utf8'));
    expect(manifest).toMatchObject({
      exportId: done.id,
      format: 'csv',
      files: { listings: { file: 'listings.csv', rows: 1 } },
    });
    expect(done.counts).toMatchObject({ listings: 1, media: 1 });

    const xlsx = await exportOf(a, { kind: 'ACCOUNT', format: 'xlsx' });
    const zip = Buffer.from(file(a.agencyId, xlsx.id) as Uint8Array);
    const local = zip.indexOf(Buffer.from('listings.xlsx')) - 30;
    expect(zip.readUInt16LE(local + 8)).toBe(0); // stored
    const inner = unzip(zip).get('listings.xlsx') as Buffer;
    expect((await sheet(inner)).find((r) => r[0] === listingId)?.[1]).toBe(`-${code('REF')}`);
  });

  it('[S10-08] a permanent error fails the export at once (no 24 h block), whatever the attempt', async () => {
    const queued = await create(b, { kind: 'CONTACTS' });
    hooks.onWrite = () => {
      throw new UnrecoverableError('store refused');
    };
    try {
      await expect(runDataExport({ agencyId: b.agencyId, exportId: queued.id }, job(false))).rejects.toBeInstanceOf(
        UnrecoverableError,
      );
    } finally {
      hooks.onWrite = undefined;
    }
    expect(await get(b, queued.id)).toMatchObject({ status: 'FAILED', errorCode: 'INTERNAL' });
    // the agency can export again at once
    const next = await create(b, { kind: 'CONTACTS' });
    expect(next.status).toBe('QUEUED');
    await runDataExport({ agencyId: b.agencyId, exportId: next.id }, job());
  });

  it('[S10-08] a superseded attempt records nothing and deletes the file it uploaded', async () => {
    const queued = await create(b, { kind: 'LEADS' });
    // another claim takes the export over while this attempt uploads
    hooks.beforeComplete = async () => {
      await rows(sql`update data_export_jobs set attempts = attempts + 1 where id = ${queued.id}`);
    };
    try {
      expect(await runDataExport({ agencyId: b.agencyId, exportId: queued.id }, job())).toEqual({ status: 'STALE' });
    } finally {
      hooks.beforeComplete = undefined;
    }
    expect(file(b.agencyId, queued.id)).toBeUndefined();
    expect(await get(b, queued.id)).toMatchObject({ status: 'RUNNING', fileBytes: null });
    // the attempt holding the claim (a retry) finishes it
    expect(await runDataExport({ agencyId: b.agencyId, exportId: queued.id }, job())).toEqual({ status: 'SUCCEEDED' });
  });
});

describe('download and expiry', () => {
  it('[S10-08] a short signed link only with download=1 (audited) until it expires 7 days later; the sweep deletes it', async () => {
    const queued = await create(a, { kind: 'LISTINGS', format: 'xlsx' });
    await runDataExport({ agencyId: a.agencyId, exportId: queued.id }, job());
    const status = await get(a, queued.id);
    expect(status).toMatchObject({ status: 'SUCCEEDED', download: null });
    const done = await get(a, queued.id, true);
    const finished = new Date(done.finishedAt as string).getTime();
    expect(new Date(done.expiresAt as string).getTime() - finished).toBe(7 * 24 * 3_600_000);
    expect(done.download?.url).toContain(compliance.dataExportKey(a.agencyId, done.id));
    expect(done.download?.url).toContain(`expires=${compliance.DATA_EXPORT_LINK_SECONDS}`);
    const audits = await rows<{ type: string }>(
      sql`select type from audit_logs where agency_id = ${a.agencyId} and target_id = ${done.id} order by occurred_at`,
    );
    expect(audits.map((r) => r.type)).toEqual(['compliance.dataExport.requested', 'compliance.dataExport.downloaded']);
    // the list never carries a link
    const list = await as(a, (ctx) => compliance.listDataExports(ctx, PageQuery.parse({ limit: 100 })));
    expect(list.items.find((e) => e.id === done.id)).toMatchObject({ status: 'SUCCEEDED', download: null });

    // a week later: the sweep deletes the file and the export is expired, with no link
    await sweepDataExports({ now: new Date(finished + 7 * 24 * 3_600_000 + 1_000) });
    expect(file(a.agencyId, done.id)).toBeUndefined();
    const expired = await get(a, done.id, true);
    expect(expired).toMatchObject({ status: 'EXPIRED', download: null });
  });

  it('[S10-08] a run that never finished is failed by the sweep, so the agency can export again', async () => {
    const queued = await create(b, { kind: 'CONTACTS' });
    await rows(sql`update data_export_jobs set created_at = now() - interval '2 days' where id = ${queued.id}`);
    const result = await sweepDataExports();
    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(await get(b, queued.id)).toMatchObject({ status: 'FAILED', errorCode: 'TIMEOUT' });
    expect(await runDataExport({ agencyId: b.agencyId, exportId: queued.id }, job())).toEqual({ status: 'SKIPPED' });
    const again = await create(b, { kind: 'CONTACTS' });
    expect(again.status).toBe('QUEUED');
    await runDataExport({ agencyId: b.agencyId, exportId: again.id }, job());
  });

  it('[S10-08] reused Idempotency-Key after 24 h → IDEMPOTENCY_KEY_REUSED', async () => {
    const key = `dx-key-old-${RUN}`;
    const first = await createResult(b, { kind: 'LEADS', format: 'xlsx' }, key);
    await system((tx) =>
      tx.execute(
        sql`update data_export_jobs set created_at = now() - interval '48 hours' where id = ${first.export.id}`,
      ),
    );
    await runDataExport({ agencyId: b.agencyId, exportId: first.export.id }, job());
    // the 24 h replay window has passed but the key's unique index has not: a refusal, not a 500
    expect(await refusal(createResult(b, { kind: 'LEADS', format: 'xlsx' }, key))).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});
