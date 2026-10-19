import { StartSheetImportBody, XmlMapping, type XmlMappingInput } from '@inmolink/contracts';
import { closeDb, countQueries, withSystem } from '@inmolink/db';
import { setupTestDb } from '@inmolink/db/testing';
import { createKeyring, generateKey } from '@inmolink/platform/crypto';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
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
