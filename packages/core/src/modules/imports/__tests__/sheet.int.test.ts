import { StartSheetImportBody, XmlMapping, type XmlMappingInput } from '@inmolink/contracts';
import { closeDb, countQueries, withSystem } from '@inmolink/db';
import { setupTestDb } from '@inmolink/db/testing';
import { createKeyring, generateKey } from '@inmolink/platform/crypto';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { readCheckpoint, writeCheckpoint } from '@inmolink/platform/queue';
import { buildXlsx, buildZip, type TestCell } from '@inmolink/platform/sheet/testing';
import { configureStorage, createMemoryStore } from '@inmolink/platform/storage';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as taxonomy from '../../taxonomy';
import * as imports from '../index';

/**
 * CSV / Excel imports end to end (S6-05): an uploaded file is checked and stored, mapped in the mapper's terms,
 * and imported by a run of the `sheet-mapped` connector with a per-row error report.
 */

const RUN = newId().slice(-8).toLowerCase();
const log = createLogger({ service: 'sheet-test', level: (process.env.TEST_LOG as 'warn' | undefined) ?? 'silent' });
const job = () => ({ log, signal: new AbortController().signal, lastAttempt: true });
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('imports.sheet.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);
const tr = (name: string) => [
  { locale: 'en', name: `${name} ${RUN}`, slug: `${name.toLowerCase().replaceAll(/[^a-z]+/g, '-')}-${RUN}` },
];
const store = createMemoryStore();

let owner: Founder;
let agent: Founder;
const as = <T>(who: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: who.userId, agencyId: who.agencyId, requestId: newId(), locale: 'en' }, fn);
const runner =
  (who: Founder) =>
  <T>(fn: (ctx: Ctx) => Promise<T>) =>
    as(who, fn);
const refusal = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (err) {
    const e = err as { code?: string; details?: { reason?: string } };
    return e.details?.reason ? `${e.code}:${e.details.reason}` : (e.code ?? 'unknown');
  }
  return 'no error';
};

const HEADER = ['Ref', 'Type', 'Price', 'Habitaciones', 'Baños', 'Country', 'Notes'];
const MAPPING: XmlMappingInput = {
  schemaVersion: 1,
  recordElement: 'row',
  decimalSeparator: 'point',
  fields: {
    ref: { path: 'Ref' },
    propertyType: { path: 'Type' },
    price: { path: 'Price' },
    bedrooms: { path: 'Habitaciones' },
    bathrooms: { path: 'Banos' },
    country: { path: 'Country' },
    transactionType: { constant: 'SALE' },
  },
  features: [],
  images: [],
  translations: [{ locale: 'en', description: { path: 'Notes' } }],
};

/** 5,000 listings; every price is a formula (cached value = the price); rows 9 (text price), 99 (thousands point), 999 (negative bedrooms) and 4,999 (no reference) are bad. */
function bigWorkbook(prefix: string): Buffer {
  const data: TestCell[][] = [HEADER];
  for (let i = 0; i < 5_000; i++) {
    const price: TestCell = { formula: `D${i + 2}*1000`, value: 100_000 + i };
    data.push([
      i === 4_999 ? null : `${prefix}-${i}`,
      `Villa ${RUN}`,
      i === 9 ? 'abc' : i === 99 ? '250.000' : price,
      i === 999 ? -2 : (i % 5) + 1,
      2,
      `Listland ${RUN}`,
      i === 0 ? '=HYPERLINK("http://evil.example","click")' : `Nice home ${i}`,
    ]);
  }
  return buildXlsx(data);
}

beforeAll(async () => {
  await setupTestDb('worker');
  configureStorage(store);
  imports.configureImports({
    keyring: createKeyring({ keys: { k1: generateKey() }, activeKeyId: 'k1' }),
    withdrawAfterMissedRuns: 3,
  });
  owner = await createFounder();
  agent = { ...owner, userId: newId() };
  await system(async (tx) => {
    await tx.execute(sql`insert into users (id, email, password_hash, name, locale, status)
      values (${agent.userId}, ${`sh-agent-${agent.userId}@example.com`}, 'x', 'Agent', 'es', 'ACTIVE')`);
    await tx.execute(sql`insert into agency_members (agency_id, user_id, role, name, email)
      values (${owner.agencyId}, ${agent.userId}, 'AGENT', 'Agent', ${`sh-agent-${agent.userId}@example.com`})`);
    await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: `sh-c-${RUN}`,
      translations: tr('Listland'),
    });
    const types = await taxonomy.createPropertyTypeGroup(tx, {
      key: `sh-types-${RUN}`,
      sort: 0,
      translations: tr('Sh Types'),
    });
    await taxonomy.createPropertyType(tx, {
      groupId: types,
      key: `sh-villa-${RUN}`,
      sort: 0,
      translations: tr('Villa'),
    });
  });
}, 120_000);

afterAll(async () => {
  await closeDb();
});

const upload = (who: Founder, bytes: Uint8Array) => imports.uploadSheet(runner(who), bytes);

describe('the upload', () => {
  it('[S6-05] reads the header and the first rows, stores the file, and the columns become the mapper paths', async () => {
    const sample = await upload(owner, bigWorkbook('P'));
    expect(sample).toMatchObject({
      recordElement: 'row',
      recordCount: 25,
      truncated: false,
      sheet: { kind: 'xlsx' },
    });
    expect(sample.paths.map((p) => p.path)).toEqual([
      'Ref',
      'Type',
      'Price',
      'Habitaciones',
      'Banos',
      'Country',
      'Notes',
    ]);
    // formula cells come as the values saved with them
    expect(sample.paths.find((p) => p.path === 'Price')?.samples[0]).toBe('100000');
    expect(sample.suggested).toMatchObject({ ref: 'Ref', propertyType: 'Type', price: 'Price' });
    const stored = await store.head('private', `imports/sheets/${owner.agencyId}/${sample.sheet?.fileId}`);
    expect(stored?.sizeBytes).toBeGreaterThan(1_000);
  });

  it('[S6-05] a CSV (semicolons, Windows-1252) is read the same way', async () => {
    const csv = Buffer.from(`Ref;Type;Price;Country\nA1;Villa;250000;Espa\xf1a\nA2;Piso;1.250,50;Listland\n`, 'latin1');
    const sample = await upload(owner, csv);
    expect(sample.sheet?.kind).toBe('csv');
    expect(sample.records.map((r) => r.children.map((c) => c.text))).toEqual([
      ['A1', 'Villa', '250000', 'España'],
      ['A2', 'Piso', '1.250,50', 'Listland'],
    ]);
  });

  it('[S6-05] refuses what is not a CSV or Excel file by its first bytes, whatever its name or declared type', async () => {
    const code = (bytes: Uint8Array) => refusal(upload(owner, bytes));
    expect(await code(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))).toBe('FEED_SAMPLE_INVALID:NOT_TEXT');
    expect(await code(Buffer.from('<html><script>alert(1)</script></html>'))).toBe('FEED_SAMPLE_INVALID:NOT_SHEET');
    expect(await code(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0]))).toBe('FEED_SAMPLE_INVALID:UNSUPPORTED_XLS');
    expect(await code(buildZip([{ name: 'a.txt', data: 'x' }]))).toBe('FEED_SAMPLE_INVALID:NOT_SHEET');
    expect(await code(Buffer.alloc(0))).toBe('FEED_SAMPLE_INVALID:EMPTY');
    expect(await code(Buffer.from('only,a,header\n'))).toBe('FEED_SAMPLE_INVALID:NO_RECORDS');
    expect(await code(Buffer.alloc(25 * 1024 * 1024 + 1, 0x41))).toBe('FEED_SAMPLE_INVALID:TOO_LARGE');
  });

  it('[S6-05] only admins upload and start imports', async () => {
    expect(await refusal(upload(agent, Buffer.from('a,b\n1,2\n')))).toBe('FORBIDDEN');
    const sample = await upload(owner, Buffer.from('Ref,Type\nA1,Villa\n'));
    const body = StartSheetImportBody.parse({ fileId: sample.sheet?.fileId, name: 'x', mapping: MAPPING });
    expect(await refusal(as(agent, (ctx) => imports.startSheetImport(ctx, body)))).toBe('FORBIDDEN');
  });
});

describe('the import', () => {
  it('[S6-05] a 5,000-row XLSX imports with a per-row error report; formula cells are read as their values', async () => {
    const sample = await upload(owner, bigWorkbook('B'));
    const started = await as(owner, (ctx) =>
      imports.startSheetImport(
        ctx,
        StartSheetImportBody.parse({ fileId: sample.sheet?.fileId, name: `Big sheet ${RUN}`, mapping: MAPPING }),
      ),
    );
    const outcome = await imports.executeRun({ runId: started.run.id, agencyId: owner.agencyId }, job());
    expect(outcome).toMatchObject({ kind: 'finished', state: 'SUCCEEDED' });
    const run = await as(owner, (ctx) => imports.getFeedRun(ctx, started.run.id));
    expect(run.counts).toMatchObject({ total: 5_000, valid: 4_996, failed: 4, created: 4_996 });

    // the report names each bad row by its row in the file (the header is row 0, the first listing row 1)
    const errors = await as(owner, (ctx) => imports.listFeedItemErrors(ctx, started.run.id, { limit: 50 }));
    expect(errors.items.map((e) => [e.position, e.itemRef, e.code, e.field])).toEqual([
      [10, `B-9`, 'INVALID_PRICE', 'price'],
      [100, `B-99`, 'INVALID_PRICE', 'price'],
      [1_000, `B-999`, 'INVALID_FIELD', 'bedrooms'],
      [5_000, null, 'MISSING_FIELD', 'ref'],
    ]);

    type Row = { ref: string; price_cents: string | null; source: string; description: string | null };
    const stored = await rows<Row>(sql`
      select pp.external_ref as ref, p.price_cents, p.source,
             (select t.description from property_translations t where t.property_id = p.id and t.locale = 'en') as description
        from properties p join property_privates pp on pp.property_id = p.id
       where p.agency_id = ${owner.agencyId} and pp.import_connection_id = ${started.connectionId}
         and pp.external_ref in ('B-0', 'B-1', 'B-4998') order by pp.external_ref`);
    // the formula cell D*1000 was never evaluated: the cached 100000 + i is the price
    expect(stored.map((r) => [r.ref, r.price_cents, r.source])).toEqual([
      ['B-0', '10000000', 'SHEET_MAPPED'],
      ['B-1', '10000100', 'SHEET_MAPPED'],
      ['B-4998', '10499800', 'SHEET_MAPPED'],
    ]);
    // text that looks like a formula is stored as text, exactly as written
    expect(stored[0]?.description).toBe('=HYPERLINK("http://evil.example","click")');
    const count = await rows<{ n: string }>(sql`
      select count(*) as n from property_privates where agency_id = ${owner.agencyId} and import_connection_id = ${started.connectionId}`);
    expect(Number(count[0]?.n)).toBe(4_996);
  }, 240_000);

  it('[S6-05] a new file for the same connection updates its listings (no duplicates) and a dry run compares with it', async () => {
    const first = await upload(
      owner,
      Buffer.from(
        `Ref,Type,Price,Country\nU-1,Villa ${RUN},100000,Listland ${RUN}\nU-2,Villa ${RUN},200000,Listland ${RUN}\n`,
      ),
    );
    const mapping: XmlMappingInput = { ...MAPPING, translations: [] };
    const a = await as(owner, (ctx) =>
      imports.startSheetImport(
        ctx,
        StartSheetImportBody.parse({ fileId: first.sheet?.fileId, name: `Updates ${RUN}`, mapping }),
      ),
    );
    await imports.executeRun({ runId: a.run.id, agencyId: owner.agencyId }, job());
    const second = await upload(
      owner,
      Buffer.from(
        `Ref,Type,Price,Country\nU-1,Villa ${RUN},150000,Listland ${RUN}\nU-3,Villa ${RUN},300000,Listland ${RUN}\n`,
      ),
    );
    const report = await as(owner, (ctx) =>
      imports.dryRunMapping(ctx, {
        mapping: XmlMapping.parse(mapping),
        records: second.records,
        connectionId: a.connectionId,
      }),
    );
    expect(report).toMatchObject({ total: 2, valid: 2, wouldCreate: 1, wouldUpdate: 1, comparedWithConnection: true });
    const b = await as(owner, (ctx) =>
      imports.startSheetImport(
        ctx,
        StartSheetImportBody.parse({
          fileId: second.sheet?.fileId,
          name: 'ignored',
          mapping,
          connectionId: a.connectionId,
        }),
      ),
    );
    expect(b.connectionId).toBe(a.connectionId);
    await imports.executeRun({ runId: b.run.id, agencyId: owner.agencyId }, job());
    const run = await as(owner, (ctx) => imports.getFeedRun(ctx, b.run.id));
    expect(run.counts).toMatchObject({ total: 2, created: 1, updated: 1 });
    const prices = await rows<{ ref: string; price_cents: string }>(sql`
      select pp.external_ref as ref, p.price_cents from properties p join property_privates pp on pp.property_id = p.id
       where pp.import_connection_id = ${a.connectionId} order by pp.external_ref`);
    expect(prices.map((r) => [r.ref, r.price_cents])).toEqual([
      ['U-1', '15000000'],
      ['U-2', '20000000'],
      ['U-3', '30000000'],
    ]);
  }, 120_000);

  it('[S6-05] a file that is gone, or turned into something else after the upload, fails the run with a code and no retry', async () => {
    const gone = await upload(owner, Buffer.from('Ref,Type\nG-1,Villa\n'));
    const mapping: XmlMappingInput = { ...MAPPING, translations: [] };
    const started = await as(owner, (ctx) =>
      imports.startSheetImport(
        ctx,
        StartSheetImportBody.parse({ fileId: gone.sheet?.fileId, name: `Gone ${RUN}`, mapping }),
      ),
    );
    await store.delete('private', `imports/sheets/${owner.agencyId}/${gone.sheet?.fileId}`);
    expect(await imports.executeRun({ runId: started.run.id, agencyId: owner.agencyId }, job())).toMatchObject({
      state: 'FAILED',
      errorCode: 'FEED_FETCH_FAILED',
    });

    // a stored file that is a zip bomb (declares small, inflates large) never gets past the reader
    const bomb = await upload(owner, Buffer.from('Ref,Type\nG-2,Villa\n'));
    const bombed = buildXlsx([['a']], {
      extra: [{ name: 'xl/worksheets/sheet1.xml', data: Buffer.alloc(4 * 1024 * 1024, 0x20), declaredSize: 100 }],
    });
    await store.put('private', `imports/sheets/${owner.agencyId}/${bomb.sheet?.fileId}`, bombed, {
      contentType: 'x/y',
    });
    const run2 = await as(owner, (ctx) =>
      imports.startSheetImport(
        ctx,
        StartSheetImportBody.parse({ fileId: bomb.sheet?.fileId, name: `Bomb ${RUN}`, mapping }),
      ),
    );
    expect(await imports.executeRun({ runId: run2.run.id, agencyId: owner.agencyId }, job())).toMatchObject({
      state: 'FAILED',
      errorCode: 'FEED_TOO_LARGE',
    });
  });

  it("[S6-05] another agency cannot start an import from this agency's file (the file key carries the agency)", async () => {
    const other = await createFounder();
    const mine = await upload(owner, Buffer.from('Ref,Type\nX-1,Villa\n'));
    const started = await as(other, (ctx) =>
      imports.startSheetImport(
        ctx,
        StartSheetImportBody.parse({
          fileId: mine.sheet?.fileId,
          name: 'stolen',
          mapping: { ...MAPPING, translations: [] },
        }),
      ),
    );
    expect(await imports.executeRun({ runId: started.run.id, agencyId: other.agencyId }, job())).toMatchObject({
      state: 'FAILED',
      errorCode: 'FEED_FETCH_FAILED',
    });
  });

  it('[S6-05] the upload costs a fixed number of queries, whatever the file', async () => {
    const queries = await countQueries(async () => {
      await upload(owner, bigWorkbook('Q'));
    });
    expect(queries).toBeLessThanOrEqual(3);
  });
});

describe('uploaded files do not outlive their use (S7-F1)', () => {
  const key = (who: Founder, fileId: string | undefined) => `imports/sheets/${who.agencyId}/${fileId}`;
  const stored = async (who: Founder, fileId: string | undefined) =>
    (await store.head('private', key(who, fileId))) !== null;
  const csv = (ref: string) => Buffer.from(`Ref,Type,Price,Country\n${ref},Villa ${RUN},100000,Listland ${RUN}\n`);
  const mapping: XmlMappingInput = { ...MAPPING, translations: [] };
  const start = (who: Founder, fileId: string | undefined, connectionId?: string) =>
    as(who, (ctx) =>
      imports.startSheetImport(
        ctx,
        StartSheetImportBody.parse({
          fileId,
          name: `Lifecycle ${RUN}`,
          mapping,
          ...(connectionId ? { connectionId } : {}),
        }),
      ),
    );
  /** What the `imports.sheet.released` subscription does: the job, with the event's payload. */
  const released = async (connectionId: string) => {
    const events = await rows<{ payload: { agencyId: string; fileId: string } }>(sql`
      select payload from outbox_events where type = 'imports.sheet.released'
         and payload->>'connectionId' = ${connectionId} order by created_at, id`);
    const results: { deleted: boolean }[] = [];
    for (const e of events) results.push(await imports.deleteReleasedSheet(e.payload));
    return { fileIds: events.map((e) => e.payload.fileId), results };
  };
  const age = (who: Founder, fileId: string | undefined, days: number) => {
    const object = store.objects.get(`private/${key(who, fileId)}`);
    if (!object) throw new Error('no such object');
    object.lastModified = new Date(Date.now() - days * 86_400_000);
  };
  const idle = (connectionId: string, days: number) =>
    system((tx) =>
      tx.execute(sql`update feed_connections set
          last_run_at = now() - make_interval(days => ${days}),
          created_at = now() - make_interval(days => ${days}),
          updated_at = now() - make_interval(days => ${days})
        where id = ${connectionId}`),
    );

  it("[S7-F1] deleting a sheet connection deletes its file, and a replaced upload's old file is gone", async () => {
    const first = await upload(owner, csv('L-1'));
    const a = await start(owner, first.sheet?.fileId);
    await imports.executeRun({ runId: a.run.id, agencyId: owner.agencyId }, job());

    // a new upload replaces the file: the old one is released and deleted after the commit, the new one stays
    const second = await upload(owner, csv('L-2'));
    const b = await start(owner, second.sheet?.fileId, a.connectionId);
    await imports.executeRun({ runId: b.run.id, agencyId: owner.agencyId }, job());
    expect(await released(a.connectionId)).toMatchObject({
      fileIds: [first.sheet?.fileId],
      results: [{ deleted: true }],
    });
    expect(await stored(owner, first.sheet?.fileId)).toBe(false);
    expect(await stored(owner, second.sheet?.fileId)).toBe(true);

    // the same file imported again on the same connection is not released
    const again = await start(owner, second.sheet?.fileId, a.connectionId);
    await imports.executeRun({ runId: again.run.id, agencyId: owner.agencyId }, job());
    expect((await released(a.connectionId)).fileIds).toHaveLength(1);

    // the connection is deleted: its file goes too
    await as(owner, (ctx) => imports.deleteFeedConnection(ctx, a.connectionId));
    expect((await released(a.connectionId)).fileIds).toEqual([first.sheet?.fileId, second.sheet?.fileId]);
    expect(await stored(owner, second.sheet?.fileId)).toBe(false);

    // a file another connection still uses is kept when one of them is deleted; members cannot delete connections
    const shared = await upload(owner, csv('L-3'));
    const c1 = await start(owner, shared.sheet?.fileId);
    const c2 = await start(owner, shared.sheet?.fileId);
    expect(await refusal(as(agent, (ctx) => imports.deleteFeedConnection(ctx, c1.connectionId)))).toBe('FORBIDDEN');
    await as(owner, (ctx) => imports.deleteFeedConnection(ctx, c1.connectionId));
    expect((await released(c1.connectionId)).results).toEqual([{ deleted: false }]);
    expect(await stored(owner, shared.sheet?.fileId)).toBe(true);
    await as(owner, (ctx) => imports.deleteFeedConnection(ctx, c2.connectionId));
    expect((await released(c2.connectionId)).results).toEqual([{ deleted: true }]);
    expect(await stored(owner, shared.sheet?.fileId)).toBe(false);
    // idempotent: a redelivered release finds nothing to delete and does not fail
    expect((await released(c2.connectionId)).results).toEqual([{ deleted: true }]);
  }, 120_000);

  it('[S7-F1] the daily sweep deletes files idle for 30 days and files no connection points to (also a deleted agency’s), never recent, young or queued ones', async () => {
    // idle: its connection last ran (and changed) 31 days ago
    const idleFile = await upload(owner, csv('W-1'));
    const idleConn = await start(owner, idleFile.sheet?.fileId);
    await imports.executeRun({ runId: idleConn.run.id, agencyId: owner.agencyId }, job());
    await idle(idleConn.connectionId, 31);
    age(owner, idleFile.sheet?.fileId, 31);
    // recent: an old file whose connection ran 2 days ago
    const recentFile = await upload(owner, csv('W-2'));
    const recentConn = await start(owner, recentFile.sheet?.fileId);
    await imports.executeRun({ runId: recentConn.run.id, agencyId: owner.agencyId }, job());
    await idle(recentConn.connectionId, 2);
    age(owner, recentFile.sheet?.fileId, 40);
    // queued: idle for 31 days, but a run waits for it
    const queuedFile = await upload(owner, csv('W-3'));
    const queuedConn = await start(owner, queuedFile.sheet?.fileId);
    await idle(queuedConn.connectionId, 31);
    age(owner, queuedFile.sheet?.fileId, 31);
    // orphaned: uploaded two days ago, never imported; young: uploaded just now, the mapper is still open
    const orphan = await upload(owner, csv('W-4'));
    age(owner, orphan.sheet?.fileId, 2);
    const young = await upload(owner, csv('W-5'));
    // an agency whose connections are gone (offboarded): its files are orphans
    const other = await createFounder();
    const othersFile = await upload(other, csv('W-6'));
    const othersConn = await start(other, othersFile.sheet?.fileId);
    await system((tx) => tx.execute(sql`delete from feed_connections where id = ${othersConn.connectionId}`));
    age(other, othersFile.sheet?.fileId, 2);

    await system((tx) => writeCheckpoint(tx, 'imports.sweepSheets', null));
    const result = await imports.sweepSheets();
    expect(result.end).toBe(true);
    expect(await stored(owner, idleFile.sheet?.fileId)).toBe(false);
    expect(await stored(owner, orphan.sheet?.fileId)).toBe(false);
    expect(await stored(other, othersFile.sheet?.fileId)).toBe(false);
    expect(await stored(owner, recentFile.sheet?.fileId)).toBe(true);
    expect(await stored(owner, queuedFile.sheet?.fileId)).toBe(true);
    expect(await stored(owner, young.sheet?.fileId)).toBe(true);
    expect(result.deleted).toBeGreaterThanOrEqual(3);
    expect(result.orphaned).toBeGreaterThanOrEqual(2);
    // idempotent: a second sweep has nothing more to delete
    expect((await imports.sweepSheets()).deleted).toBe(0);

    // the idle connection's next run fails cleanly: the agency uploads the file again
    const rerun = await as(owner, (ctx) => imports.requestFeedRun(ctx, idleConn.connectionId));
    expect(await imports.executeRun({ runId: rerun.id, agencyId: owner.agencyId }, job())).toMatchObject({
      kind: 'finished',
      state: 'FAILED',
      errorCode: 'FEED_FETCH_FAILED',
    });
    await system((tx) =>
      tx.execute(sql`update feed_runs set state = 'FAILED', finished_at = now(), error_code = 'INTERNAL'
        where connection_id = ${queuedConn.connectionId} and state = 'QUEUED'`),
    );
  }, 120_000);

  it('[S7-F1] a sweep cut short resumes where it stopped on the next run, and wraps to the start at the end', async () => {
    // three orphans of a fresh agency (its keys sort after every earlier agency's: UUIDv7)
    const late = await createFounder();
    const files = [];
    for (const ref of ['P-1', 'P-2', 'P-3']) {
      const f = await upload(late, csv(ref));
      age(late, f.sheet?.fileId, 2);
      files.push(f.sheet?.fileId);
    }
    const objects = [...store.objects.keys()].filter((k) => k.startsWith('private/imports/sheets/')).length;
    await system((tx) => writeCheckpoint(tx, 'imports.sweepSheets', null));
    // one page of 2 objects per run: without the saved position every run would see the first page again
    const runs: Awaited<ReturnType<typeof imports.sweepSheets>>[] = [];
    while (runs.length < objects + 2) {
      const r = await imports.sweepSheets({ maxPages: 1, pageSize: 2 });
      runs.push(r);
      expect(r.scanned).toBeLessThanOrEqual(2);
      if (r.end) break;
    }
    expect(runs.at(-1)?.end).toBe(true);
    expect(runs.length).toBeGreaterThanOrEqual(Math.ceil(objects / 2));
    for (const f of files) expect(await stored(late, f)).toBe(false);
    expect(await system((tx) => readCheckpoint(tx, 'imports.sweepSheets'))).toBeUndefined();
    // at the end it starts over: the next run reads the first page again
    const again = await imports.sweepSheets({ maxPages: 1, pageSize: 2 });
    expect(again.scanned).toBeGreaterThan(0);
    await system((tx) => writeCheckpoint(tx, 'imports.sweepSheets', null));
  }, 120_000);

  it('[S7-F1] a released file cannot be imported again (the release and the start take the same lock)', async () => {
    const f = await upload(owner, csv('G-1'));
    const c = await start(owner, f.sheet?.fileId);
    await imports.executeRun({ runId: c.run.id, agencyId: owner.agencyId }, job());
    await as(owner, (ctx) => imports.deleteFeedConnection(ctx, c.connectionId));
    expect((await released(c.connectionId)).results).toEqual([{ deleted: true }]);
    // a stale browser tab still holding the file id (upper case too)
    expect(await refusal(start(owner, f.sheet?.fileId?.toUpperCase()))).toBe('FEED_SAMPLE_INVALID:FILE_GONE');
    // an orphan the sweep let go is refused the same way
    const orphan = await upload(owner, csv('G-2'));
    age(owner, orphan.sheet?.fileId, 2);
    await system((tx) => writeCheckpoint(tx, 'imports.sweepSheets', null));
    await imports.sweepSheets();
    expect(await refusal(start(owner, orphan.sheet?.fileId))).toBe('FEED_SAMPLE_INVALID:FILE_GONE');
  }, 120_000);

  it('[S7-F1] offboarding deletes an agency’s whole sheet prefix, and only that agency’s', async () => {
    const leaving = await createFounder();
    const kept = await upload(owner, csv('O-0'));
    const mine = [];
    for (const ref of ['O-1', 'O-2', 'O-3']) mine.push((await upload(leaving, csv(ref))).sheet?.fileId);
    expect(await imports.deleteAgencySheets(leaving.agencyId)).toEqual({ deleted: 3, more: false });
    for (const f of mine) expect(await stored(leaving, f)).toBe(false);
    expect(await stored(owner, kept.sheet?.fileId)).toBe(true);
    expect(await imports.deleteAgencySheets(leaving.agencyId)).toEqual({ deleted: 0, more: false });
  });
});
