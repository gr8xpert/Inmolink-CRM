import { CreateListingBody, CreatePortalConnectionBody, UpdateListingBody } from '@inmolink/contracts';
import { closeDb, withSystem } from '@inmolink/db';
import { setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { createKeyring, generateKey } from '@inmolink/platform/crypto';
import { invalidateFlags, setFlag, setFlagOverride } from '@inmolink/platform/flags';
import { newId } from '@inmolink/platform/ids';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as agencies from '../../agencies';
import * as properties from '../../properties';
import * as taxonomy from '../../taxonomy';
import * as exportsModule from '../index';
import { writeConnectionFeed } from '../worker';
import { image, listingDoc, schemaErrors, xsd } from './portal-fixtures';

/**
 * Portal feeds end to end (S9-02): a connection's selection is read from the agency's own read models, each listing is
 * checked against the portal's profile, valid ones are written (streaming, in batches) and validate against the
 * portal's schema fixture, invalid ones are left out with a stored reason the dashboard lists.
 */

const RUN = newId().slice(-8);
const code = (s: string) => `${s}-${RUN}`;
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('exports.feeds.test', fn);
const MEDIA = 'https://media.example/bucket';

let a: Founder;
let b: Founder;
let ids: { propertyType: string; city: string };
const L: Record<string, string> = {};
const REF: Record<string, string> = {};
/** The content locale of the founders' agencies (sign-up in Spanish: `es`). */
let LOCALE = 'es';

const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);

async function listing(m: Founder, label: string, visibility: 'PUBLIC' | 'SHARED' = 'PUBLIC'): Promise<string> {
  const { id } = await as(m, (ctx) =>
    properties.createListing(
      ctx,
      CreateListingBody.parse({
        propertyTypeId: ids.propertyType,
        locationId: ids.city,
        priceCents: 30_000_000,
        energyRating: 'B',
      }),
    ),
  );
  await as(m, async (ctx) =>
    properties.updateListing(
      ctx,
      id,
      UpdateListingBody.parse({
        status: 'ACTIVE',
        visibility,
        version: (await properties.getListing(ctx, id)).version,
      }),
    ),
  );
  L[label] = id;
  return id;
}

/** Stores the listing's read model in the agency's content locale (what the search worker would build). */
async function readModel(m: Founder, label: string, over: Parameters<typeof listingDoc>[0] = {}): Promise<void> {
  const id = L[label] as string;
  const ref = await system(
    async (tx) =>
      (await tx.execute<{ ref: string }>(sql`select ref from properties where id = ${id}`)).rows[0]?.ref ?? '',
  );
  REF[label] = ref;
  const doc = listingDoc({ id, ref, ...over });
  await system((tx) =>
    tx.execute(sql`
      insert into listing_read_models (target_id, locale, kind, agency_id, public, status, version, card, detail, etag)
      values (${id}, ${LOCALE}, 'LISTING', ${m.agencyId}, true, 'ACTIVE', 1, '{}'::jsonb, ${JSON.stringify(doc)}::jsonb, ${`e-${RUN}-${label}`})
      on conflict (target_id, locale) do update set detail = excluded.detail, updated_at = now()`),
  );
}

async function connect(m: Founder, channelCode: string, name: string): Promise<string> {
  const body = CreatePortalConnectionBody.parse({ channelCode, name });
  return (await as(m, (ctx) => exportsModule.createConnection(ctx, body))).connection.id;
}

/** Runs the writer into memory; the chunks are what a sink would have received. */
async function run(m: Founder, connectionId: string, batchSize?: number) {
  const chunks: string[] = [];
  const result = await writeConnectionFeed(m.agencyId, connectionId, {
    mediaBaseUrl: MEDIA,
    batchSize,
    sink: async (c) => {
      chunks.push(c);
    },
  });
  return { result, chunks, xml: chunks.join('') };
}

const issues = (m: Founder, connectionId: string) =>
  as(m, (ctx) => exportsModule.listIssues(ctx, { connectionId }, { limit: 100 }));

beforeAll(async () => {
  await setupTestDb('worker');
  exportsModule.configureExports({
    keyring: createKeyring({ keys: { k1: generateKey() }, activeKeyId: 'k1' }),
    tokenKey: 'test-hmac-key-0123456789abcdef0123456789',
  });
  await system((tx) => exportsModule.syncPortalChannels(tx));
  [a, b] = [await createFounder(), await createFounder()];
  for (const m of [a, b]) await setAgencyStatus(m.agencyId, 'VERIFIED');
  LOCALE = (await system((tx) => agencies.readModelOwnersOf(tx, [a.agencyId]))).get(a.agencyId)?.locales[0] ?? 'es';
  ids = await system(async (tx) => {
    const name = (n: string) => [{ locale: 'en', name: `${n} ${RUN}`, slug: code(n.toLowerCase()) }];
    const country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('fx'),
      translations: name('Feedland'),
    });
    const region = await taxonomy.createLocation(tx, {
      level: 'REGION',
      parentId: country,
      code: code('fx-r'),
      translations: name('Feedcoast'),
    });
    const city = await taxonomy.createLocation(tx, {
      level: 'CITY',
      parentId: region,
      code: code('fx-c'),
      translations: name('Feedcity'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: code('fx-g'),
      sort: 0,
      translations: name('Homes'),
    });
    const propertyType = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: code('fx-t'),
      sort: 0,
      translations: name('Villa'),
    });
    return { propertyType, city };
  });
  // Selected (PUBLIC): a complete one, one without photos, one without CEE and a description, one with a 3-photo set.
  await listing(a, 'good');
  await listing(a, 'noPhotos');
  await listing(a, 'noCee');
  await listing(a, 'threePhotos');
  await listing(a, 'shared', 'SHARED');
  await listing(b, 'other');
  await readModel(a, 'good');
  await readModel(a, 'noPhotos', { media: [], imageCount: 0, cover: null });
  await readModel(a, 'noCee', { energyRating: null, description: null });
  await readModel(a, 'threePhotos', { media: [image(1), image(2), image(3)], imageCount: 3 });
  await readModel(a, 'shared');
  await readModel(b, 'other');
}, 120_000);

afterAll(async () => {
  await closeDb();
});

describe('[S9-02] Kyero feed: valid listings export, invalid ones are excluded with a visible reason', () => {
  let connectionId: string;

  it('writes the valid listings, validates against the Kyero schema, and leaves the invalid ones out', async () => {
    connectionId = await connect(a, 'kyero', 'Kyero main');
    const { result, xml } = await run(a, connectionId);
    // good + threePhotos (Kyero needs 1 photo); noPhotos and noCee are left out
    expect(result).toMatchObject({ valid: 2, invalid: 2 });
    // The count and the stored list agree: every listing left out has its reason.
    expect((await issues(a, connectionId)).items).toHaveLength(2);
    expect(await schemaErrors(xml, xsd('kyero/kyero-v3.xsd'))).toEqual([]);
    expect(xml).toContain(`<ref>${REF.good}</ref>`);
    expect(xml).toContain(`<ref>${REF.threePhotos}</ref>`);
    expect(xml).not.toContain(`<ref>${REF.noPhotos}</ref>`);
    expect(xml).not.toContain(`<ref>${REF.noCee}</ref>`);
  });

  it('only the agency’s own ACTIVE, PUBLIC listings are read: SHARED and other agencies’ never appear', async () => {
    const { xml } = await run(a, connectionId);
    expect(xml).not.toContain(REF.shared as string);
    expect(xml).not.toContain(REF.other as string);
  });

  it('stores a reason per excluded listing and shows it in the dashboard API', async () => {
    const page = await issues(a, connectionId);
    const byRef = Object.fromEntries(page.items.map((i) => [i.ref, i.issues.map((x) => x.code).sort()]));
    expect(byRef).toEqual({
      [REF.noPhotos as string]: ['PHOTOS_TOO_FEW'],
      [REF.noCee as string]: ['DESCRIPTION_MISSING', 'ENERGY_RATING_MISSING'],
    });
    const dto = await as(a, (ctx) => exportsModule.getConnection(ctx, { connectionId }));
    expect(dto.validation).toMatchObject({ validCount: 2, invalidCount: 2 });
    // Another agency sees nothing of it.
    await expect(issues(b, connectionId)).rejects.toMatchObject({ code: 'PORTAL_CONNECTION_NOT_FOUND' });
  });

  it('a fixed listing leaves the list on the next run; a listing no longer selected does too', async () => {
    await readModel(a, 'noPhotos');
    await as(a, (ctx) =>
      exportsModule.setOverrides(
        ctx,
        { connectionId },
        { items: [{ propertyId: L.noCee as string, action: 'EXCLUDE' }] },
      ),
    );
    const { result, xml } = await run(a, connectionId);
    expect(result).toMatchObject({ valid: 3, invalid: 0 });
    expect(xml).toContain(`<ref>${REF.noPhotos}</ref>`);
    expect((await issues(a, connectionId)).items).toEqual([]);
    expect(await as(a, (ctx) => exportsModule.getConnection(ctx, { connectionId }))).toMatchObject({
      validation: { validCount: 3, invalidCount: 0 },
    });
  });

  it('a listing with no read model yet is left out with NO_DOCUMENT, the rest still go', async () => {
    await listing(a, 'fresh');
    const { result } = await run(a, connectionId);
    expect(result).toMatchObject({ valid: 3, invalid: 1 });
    expect((await issues(a, connectionId)).items.map((i) => i.issues[0]?.code)).toEqual(['NO_DOCUMENT']);
    await as(a, (ctx) =>
      exportsModule.setOverrides(
        ctx,
        { connectionId },
        { items: [{ propertyId: L.fresh as string, action: 'EXCLUDE' }] },
      ),
    );
  });
});

describe('[S9-02] the writer streams: bounded batches, bounded buffers', () => {
  it('writes in pieces while it reads in batches, and the output is the same whatever the batch size', async () => {
    const connectionId = await connect(a, 'kyero', 'Kyero big');
    // Long descriptions make the document larger than the 64 K flush threshold.
    const description = `${'Sunny house with a large garden. '.repeat(450)}`.slice(0, 15_000);
    const three = { media: [image(1), image(2), image(3)], imageCount: 3 };
    for (const label of ['good', 'noPhotos', 'threePhotos', 'noCee', 'fresh']) {
      await readModel(a, label, label === 'threePhotos' ? { description, ...three } : { description });
    }
    const small = await run(a, connectionId, 1);
    const whole = await run(a, connectionId, 1_000);
    expect(small.result).toMatchObject({ valid: 5, invalid: 0 });
    expect(small.chunks.length).toBeGreaterThanOrEqual(2);
    // No chunk is much larger than the flush threshold plus one listing.
    expect(Math.max(...small.chunks.map((c) => c.length))).toBeLessThan(64 * 1024 + 20_000);
    expect(small.xml.replace(/<date>[^<]*<\/date>/g, '')).toBe(whole.xml.replace(/<date>[^<]*<\/date>/g, ''));
    expect(await schemaErrors(small.xml, xsd('kyero/kyero-v3.xsd'))).toEqual([]);
  });
});

describe('[S9-02] thinkSPAIN, A Place in the Sun and generic XML', () => {
  it('unconfirmed portals write nothing until their flag is on, then validate against their fixtures (H6)', async () => {
    for (const [channel, schema, minPhotos] of [
      ['thinkspain', 'thinkspain/portal-feed.xsd', 3],
      ['a-place-in-the-sun', 'a-place-in-the-sun/portal-feed.xsd', 5],
    ] as const) {
      const connectionId = await connect(a, channel, `${channel} main`);
      expect((await run(a, connectionId)).result).toEqual({ skipped: 'writer-disabled' });
      await system(async (tx) => {
        await setFlag(tx, exportsModule.portalFlagKey(channel), { enabled: false });
        await setFlagOverride(tx, exportsModule.portalFlagKey(channel), a.agencyId, true);
      });
      invalidateFlags();
      const { result, xml } = await run(a, connectionId);
      // every listing has six photos but 'threePhotos' (three): A Place in the Sun needs five
      expect(result.valid).toBe(minPhotos === 3 ? 5 : 4);
      expect(await schemaErrors(xml, xsd(schema))).toEqual([]);
      const reasons = (await issues(a, connectionId)).items.flatMap((i) => i.issues.map((x) => x.code));
      expect(reasons).toEqual(minPhotos === 3 ? [] : ['PHOTOS_TOO_FEW']);
    }
  });

  it('generic XML carries every selected listing and the agency itself as presenter', async () => {
    const connectionId = await connect(a, 'generic-xml', 'Generic main');
    const { result, xml } = await run(a, connectionId);
    expect(result.invalid).toBe(0);
    expect(await schemaErrors(xml, xsd('website-feed/inmolink-feed-v1.xsd'))).toEqual([]);
    expect(xml).toContain('<name>Costa Homes');
    // The header carries the agency's public name, never the connection's internal label, and no timestamp.
    expect(xml).not.toContain('Generic main');
    expect(xml).not.toContain('generated=');
    expect(xml).not.toMatch(/commission/i);
  });

  it('an off or revoked connection writes nothing', async () => {
    const connectionId = await connect(a, 'kyero', 'Kyero off');
    const dto = await as(a, (ctx) => exportsModule.getConnection(ctx, { connectionId }));
    await as(a, (ctx) =>
      exportsModule.updateConnection(ctx, { connectionId }, { version: dto.version, enabled: false }),
    );
    expect((await run(a, connectionId)).result).toEqual({ skipped: 'disabled' });
    expect((await run(a, newId())).result).toEqual({ skipped: 'no-connection' });
  });
});

describe('[S9-02] reruns, failures and skipped agencies', () => {
  const rowVersions = (connectionId: string) =>
    system(
      async (tx) =>
        (
          await tx.execute<{ id: string; v: string }>(
            sql`select property_id::text as id, xmin::text as v from portal_connection_issues where connection_id = ${connectionId} order by 1`,
          )
        ).rows,
    );

  it('two runs over unchanged data give identical bytes (Kyero and generic) and rewrite no issue row', async () => {
    for (const channel of ['kyero', 'generic-xml']) {
      const connectionId = await connect(a, channel, `${channel} stable`);
      const first = await run(a, connectionId);
      const rows = await rowVersions(connectionId);
      const second = await run(a, connectionId);
      expect(second.xml).toBe(first.xml);
      expect(second.result).toEqual(first.result);
      // Unchanged reasons are not written again (same row versions).
      expect(await rowVersions(connectionId)).toEqual(rows);
    }
  });

  it('a failing sink leaves the last good summary: no half run is shown', async () => {
    const connectionId = await connect(a, 'kyero', 'Kyero flaky');
    await run(a, connectionId);
    const before = await as(a, (ctx) => exportsModule.getConnection(ctx, { connectionId }));
    expect(before.validation).not.toBeNull();
    // Another listing now fails; the run dies mid-way.
    await readModel(a, 'good', { energyRating: null });
    let calls = 0;
    await expect(
      writeConnectionFeed(a.agencyId, connectionId, {
        mediaBaseUrl: MEDIA,
        batchSize: 1,
        sink: async () => {
          if (++calls === 1) throw new Error('storage down');
        },
      }),
    ).rejects.toThrow('storage down');
    const after = await as(a, (ctx) => exportsModule.getConnection(ctx, { connectionId }));
    expect(after.validation).toEqual(before.validation);
    await readModel(a, 'good');
  });

  it('a suspended agency is skipped with its own reason, not reported as listings without documents', async () => {
    const c = await createFounder();
    await setAgencyStatus(c.agencyId, 'VERIFIED');
    const connectionId = await connect(c, 'kyero', 'Kyero c');
    await setAgencyStatus(c.agencyId, 'SUSPENDED');
    expect((await run(c, connectionId)).result).toEqual({ skipped: 'not-verified' });
  });
});
