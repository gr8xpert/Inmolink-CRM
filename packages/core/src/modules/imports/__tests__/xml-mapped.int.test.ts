import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CreateFeedConnectionBody, XmlMapping, type XmlMappingInput } from '@inmolink/contracts';
import { closeDb, countQueries, withSystem } from '@inmolink/db';
import { setupTestDb } from '@inmolink/db/testing';
import { createKeyring, generateKey } from '@inmolink/platform/crypto';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { allowLoopbackOriginsForTests } from '@inmolink/platform/safe-fetch';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as taxonomy from '../../taxonomy';
import * as imports from '../index';
import { FIXTURE_MAPPING, fixtureBytes } from './xml-mapped-fixture';

/**
 * The generic XML connector end to end (S6-04): a non-Kyero feed, a saved mapping profile, a dry run that writes
 * nothing, and a real run through the connector (loopback fixture server) with no code written for the feed.
 */

const RUN = newId().slice(-8).toLowerCase();
const log = createLogger({
  service: 'xml-mapped-test',
  level: (process.env.TEST_LOG as 'warn' | undefined) ?? 'silent',
});
const job = () => ({ log, signal: new AbortController().signal, lastAttempt: true });
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('imports.xmlMapped.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);
const tr = (name: string) => [
  { locale: 'en', name: `${name} ${RUN}`, slug: `${name.toLowerCase().replaceAll(/[^a-z]+/g, '-')}-${RUN}` },
];

/** The fixture with this run's taxonomy names (the real names are shared with other tests' and the e2e's data). */
const feedXml = Buffer.from(fixtureBytes())
  .toString('utf8')
  .replaceAll('E2E Villa', `Villa ${RUN}`)
  .replaceAll('E2E Listland', `Listland ${RUN}`)
  .replaceAll('E2E Pool', `Pool ${RUN}`);

let owner: Founder;
let agent: Founder;
let server: Server;
let origin = '';
let undoLoopback = () => {};
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
    return (err as { code?: string }).code ?? 'unknown';
  }
  return 'no error';
};
const mapping = (over: Partial<XmlMappingInput> = {}): XmlMappingInput => ({ ...FIXTURE_MAPPING, ...over });

beforeAll(async () => {
  await setupTestDb('worker');
  imports.configureImports({
    keyring: createKeyring({ keys: { k1: generateKey() }, activeKeyId: 'k1' }),
    withdrawAfterMissedRuns: 3,
  });
  owner = await createFounder();
  agent = { ...owner, userId: newId() };
  await system(async (tx) => {
    await tx.execute(sql`insert into users (id, email, password_hash, name, locale, status)
      values (${agent.userId}, ${`xm-agent-${agent.userId}@example.com`}, 'x', 'Agent', 'es', 'ACTIVE')`);
    await tx.execute(sql`insert into agency_members (agency_id, user_id, role, name, email)
      values (${owner.agencyId}, ${agent.userId}, 'AGENT', 'Agent', ${`xm-agent-${agent.userId}@example.com`})`);
    const country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: `xm-c-${RUN}`,
      translations: tr('Listland'),
    });
    void country;
    const types = await taxonomy.createPropertyTypeGroup(tx, {
      key: `xm-types-${RUN}`,
      sort: 0,
      translations: tr('Xm Types'),
    });
    await taxonomy.createPropertyType(tx, {
      groupId: types,
      key: `xm-villa-${RUN}`,
      sort: 0,
      translations: tr('Villa'),
    });
    const features = await taxonomy.createFeatureGroup(tx, {
      key: `xm-features-${RUN}`,
      sort: 0,
      translations: tr('Xm Features'),
    });
    await taxonomy.createFeature(tx, {
      groupId: features,
      key: `xm-pool-${RUN}`,
      sort: 0,
      icon: 'star',
      translations: tr('Pool'),
    });
  });
  server = createServer((req, res) => {
    if (req.url === '/estate.xml') res.writeHead(200, { 'content-type': 'application/xml' }).end(feedXml);
    else if (req.url === '/page.html') res.writeHead(200, { 'content-type': 'text/html' }).end('<html></html>');
    else res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  undoLoopback = allowLoopbackOriginsForTests([origin]);
}, 120_000);

afterAll(async () => {
  undoLoopback();
  server.close();
  await closeDb();
});

let profileId = '';

describe('mapping profiles', () => {
  it('[S6-04] a mapping is saved as a profile, listed, changed with a version check, and an invalid one is refused', async () => {
    const created = await as(owner, (ctx) =>
      imports.createMappingProfile(ctx, { name: 'Casa Datos', mapping: XmlMapping.parse(mapping()) }),
    );
    profileId = created.id;
    expect(created).toMatchObject({ name: 'Casa Datos', connector: 'xml-mapped', version: 1 });
    const list = await as(owner, (ctx) => imports.listMappingProfiles(ctx, { limit: 25 }));
    expect(list.items.map((p) => p.id)).toContain(created.id);
    const renamed = await as(owner, (ctx) =>
      imports.updateMappingProfile(ctx, created.id, { version: 1, name: 'Casa Datos v2' }),
    );
    expect(renamed).toMatchObject({ name: 'Casa Datos v2', version: 2 });
    expect(
      await refusal(as(owner, (ctx) => imports.updateMappingProfile(ctx, created.id, { version: 1, name: 'x' }))),
    ).toBe('VERSION_CONFLICT');
    // a mapping that skipped the schema (a client that bypassed the contract) never reaches the table
    expect(
      await refusal(
        as(owner, (ctx) =>
          imports.createMappingProfile(ctx, { name: 'bad', mapping: { schemaVersion: 1 } as unknown as XmlMapping }),
        ),
      ),
    ).toBe('FEED_MAPPING_INVALID');
  });

  it('[S6-04] only admins manage profiles and the mapper; agents read nothing of it', async () => {
    expect(
      await refusal(
        as(agent, (ctx) => imports.createMappingProfile(ctx, { name: 'x', mapping: XmlMapping.parse(mapping()) })),
      ),
    ).toBe('FORBIDDEN');
    expect(await refusal(imports.sampleFromUpload(runner(agent), fixtureBytes(), {}))).toBe('FORBIDDEN');
    expect(await refusal(imports.sampleFromUrl(runner(agent), { url: `${origin}/estate.xml` }))).toBe('FORBIDDEN');
    expect(
      await refusal(
        as(agent, (ctx) =>
          imports.previewMapping(ctx, { mapping: XmlMapping.parse(mapping()), records: undefined as never }),
        ),
      ),
    ).toBe('FORBIDDEN');
  });

  it('[S6-04] a generic XML connection needs a profile of its own connector', async () => {
    const body = (over: Record<string, unknown>) =>
      CreateFeedConnectionBody.parse({
        name: 'No profile',
        connector: 'xml-mapped',
        url: `${origin}/estate.xml`,
        scheduleMinutes: null,
        ...over,
      });
    expect(await refusal(as(owner, (ctx) => imports.createFeedConnection(ctx, body({}))))).toBe(
      'FEED_MAPPING_REQUIRED',
    );
    expect(
      await refusal(as(owner, (ctx) => imports.createFeedConnection(ctx, body({ mappingProfileId: newId() })))),
    ).toBe('FEED_MAPPING_PROFILE_NOT_FOUND');
    expect(
      await refusal(
        as(owner, (ctx) =>
          imports.createFeedConnection(ctx, body({ connector: 'kyero', mappingProfileId: profileId })),
        ),
      ),
    ).toBe('FEED_MAPPING_INVALID');
  });
});

describe('samples', () => {
  it('[S6-04] a sample from a URL goes through safeFetch: the head of the feed is read, a private address is refused', async () => {
    const sample = await imports.sampleFromUrl(runner(owner), { url: `${origin}/estate.xml` });
    expect(sample).toMatchObject({ recordElement: 'object', recordCount: 4, truncated: false });
    expect(await refusal(imports.sampleFromUrl(runner(owner), { url: 'http://10.0.0.5/feed.xml' }))).toBe(
      'FEED_URL_NOT_ALLOWED',
    );
    expect(
      await refusal(imports.sampleFromUrl(runner(owner), { url: 'http://169.254.169.254/latest/meta-data' })),
    ).toBe('FEED_URL_NOT_ALLOWED');
    // HTML is no feed: the content type is checked before the body is read
    expect(await refusal(imports.sampleFromUrl(runner(owner), { url: `${origin}/page.html` }))).toBe(
      'FEED_SAMPLE_INVALID',
    );
    expect(await refusal(imports.sampleFromUrl(runner(owner), { url: `${origin}/missing.xml` }))).toBe(
      'FEED_SAMPLE_INVALID',
    );
  });

  it('[S6-04] credentials are never sent over plain http for a sample, as for a saved connection', async () => {
    const creds = { type: 'query' as const, name: 'key', value: 'secret-key-1' };
    expect(
      await refusal(
        imports.sampleFromUrl(runner(owner), { url: 'http://feeds.example.com/x.xml', credentials: creds }),
      ),
    ).toBe('FEED_URL_NOT_ALLOWED');
  });

  it('[S6-04] an uploaded sample is read, and a file that is not XML is refused by its bytes', async () => {
    const sample = await imports.sampleFromUpload(runner(owner), fixtureBytes(), {});
    expect(sample.recordElement).toBe('object');
    expect(
      await refusal(imports.sampleFromUpload(runner(owner), Uint8Array.from([0x50, 0x4b, 3, 4, 0x3c, 0x61, 0x3e]), {})),
    ).toBe('FEED_SAMPLE_INVALID');
  });
});

describe('dry run and import', () => {
  const listingCount = async () =>
    Number(
      (
        await rows<{ n: string }>(sql`select count(*)::text as n from properties where agency_id = ${owner.agencyId}`)
      )[0]?.n,
    );
  const queueCount = async () =>
    Number((await rows<{ n: string }>(sql`select coalesce(sum(count), 0)::text as n from taxonomy_unmatched`))[0]?.n);

  it('[S6-04] the dry run reports created, held, refused and unmatched taxonomy and writes nothing', async () => {
    const sample = await imports.sampleFromUpload(runner(owner), Buffer.from(feedXml), {});
    const [listingsBefore, queueBefore] = [await listingCount(), await queueCount()];
    const report = await as(owner, (ctx) =>
      imports.dryRunMapping(ctx, { mapping: XmlMapping.parse(mapping()), records: sample.records }),
    );
    expect(report).toMatchObject({
      total: 4,
      valid: 3,
      wouldCreate: 3,
      wouldUpdate: 0,
      refused: 1,
      comparedWithConnection: false,
    });
    expect(report.refusals).toEqual([
      {
        position: 2,
        itemRef: 'CD-1003',
        problem: { code: 'INVALID_PRICE', field: 'price', message: expect.any(String) },
      },
    ]);
    // the towns and the feature "Sea view" have no match in the taxonomy: those listings would be held as drafts
    expect(report.wouldHold).toBe(3);
    expect(report.unmatched.map((u) => [u.kind, u.text]).sort()).toEqual(
      expect.arrayContaining([
        ['feature', 'Sea view'],
        ['location', 'Hillview'],
        ['location', 'Seaside'],
      ]),
    );
    // nothing written: no listing, and the staff queue did not count a single value
    expect(await listingCount()).toBe(listingsBefore);
    expect(await queueCount()).toBe(queueBefore);
  });

  it('[S6-04] the dry run costs a fixed number of queries, whatever the number of distinct towns in the sample', async () => {
    const many = Array.from(
      { length: 25 },
      (_, i) =>
        `<object code="Q${i}"><deal>venta</deal><category>Villa ${RUN}</category><place><nation>Listland ${RUN}</nation><town>Town ${i} ${RUN}</town></place><price>${i + 1}00,00</price></object>`,
    ).join('');
    const sample = await imports.sampleFromUpload(
      runner(owner),
      Buffer.from(`<estate-export><objects>${many}</objects></estate-export>`),
      {},
    );
    expect(sample.recordCount).toBe(25);
    let report: Awaited<ReturnType<typeof imports.dryRunMapping>> | undefined;
    const queries = await countQueries(async () => {
      report = await as(owner, (ctx) =>
        imports.dryRunMapping(ctx, { mapping: XmlMapping.parse(mapping()), records: sample.records }),
      );
    });
    expect(report).toMatchObject({ valid: 25, wouldCreate: 25, wouldHold: 25 });
    expect(report?.unmatched.filter((u) => u.kind === 'location')).toHaveLength(25);
    expect(queries).toBeLessThanOrEqual(20);
  });

  it('[S6-04] a non-Kyero feed imports through its profile without code changes, and the dry run then reports updates', async () => {
    const c = await as(owner, (ctx) =>
      imports.createFeedConnection(
        ctx,
        CreateFeedConnectionBody.parse({
          name: 'Casa Datos feed',
          connector: 'xml-mapped',
          url: `${origin}/estate.xml`,
          scheduleMinutes: null,
          mappingProfileId: profileId,
        }),
      ),
    );
    expect(c.mappingProfileId).toBe(profileId);
    const run = await as(owner, (ctx) => imports.requestFeedRun(ctx, c.id));
    const outcome = await imports.executeRun({ runId: run.id, agencyId: owner.agencyId }, job());
    expect(outcome).toMatchObject({ kind: 'finished', state: 'SUCCEEDED' });
    const dto = await as(owner, (ctx) => imports.getFeedRun(ctx, run.id));
    expect(dto.counts).toMatchObject({ total: 4, valid: 3, failed: 1, created: 3 });
    const errors = await as(owner, (ctx) => imports.listFeedItemErrors(ctx, run.id, { limit: 10 }));
    expect(errors.items.map((e) => [e.itemRef, e.code, e.field])).toEqual([['CD-1003', 'INVALID_PRICE', 'price']]);

    type Row = { ref: string; transaction_type: string; price_cents: string | null; source: string; locales: string };
    const stored = await rows<Row>(sql`
      select pp.external_ref as ref, p.transaction_type, p.price_cents, p.source,
             (select string_agg(t.locale, ',' order by t.locale) from property_translations t where t.property_id = p.id) as locales
        from properties p join property_privates pp on pp.property_id = p.id
       where p.agency_id = ${owner.agencyId} and pp.import_connection_id = ${c.id} order by pp.external_ref`);
    expect(stored.map((r) => r.ref)).toEqual(['CD-1001', 'CD-1002', 'CD-1004']);
    expect(stored[0]).toMatchObject({
      transaction_type: 'SALE',
      price_cents: '125000000',
      source: 'XML_MAPPED',
      locales: 'en,es',
    });
    expect(stored[1]).toMatchObject({ transaction_type: 'RENT_LONG_TERM', price_cents: '240000' });

    // changing the profile changes the next run with no deploy: the dry run now compares with the connection's listings
    const sample = await imports.sampleFromUpload(runner(owner), Buffer.from(feedXml), {});
    const report = await as(owner, (ctx) =>
      imports.dryRunMapping(ctx, { mapping: XmlMapping.parse(mapping()), records: sample.records, connectionId: c.id }),
    );
    expect(report).toMatchObject({ valid: 3, wouldCreate: 0, wouldUpdate: 3, comparedWithConnection: true });
  });

  it('[S6-04] a profile that no longer reads fails the run with FEED_MAPPING_INVALID before any download', async () => {
    const broken = await system(async (tx) => {
      const id = newId();
      await tx.execute(sql`insert into feed_mapping_profiles (id, agency_id, name, connector, mapping)
        values (${id}, ${owner.agencyId}, 'broken', 'xml-mapped', '{"schemaVersion": 1}'::jsonb)`);
      return id;
    });
    const c = await as(owner, (ctx) =>
      imports.createFeedConnection(
        ctx,
        CreateFeedConnectionBody.parse({
          name: 'Broken',
          connector: 'xml-mapped',
          url: `${origin}/estate.xml`,
          scheduleMinutes: null,
          mappingProfileId: broken,
        }),
      ),
    );
    const run = await as(owner, (ctx) => imports.requestFeedRun(ctx, c.id));
    const outcome = await imports.executeRun({ runId: run.id, agencyId: owner.agencyId }, job());
    expect(outcome).toMatchObject({ kind: 'finished', state: 'FAILED', errorCode: 'FEED_MAPPING_INVALID' });
  });
});
