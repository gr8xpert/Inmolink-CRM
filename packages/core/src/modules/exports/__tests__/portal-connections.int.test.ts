import {
  CreateListingBody,
  CreatePortalConnectionBody,
  type CreatePortalConnectionInput,
  type PortalConnectionDto,
  PortalSelection,
  UpdateListingBody,
} from '@inmolink/contracts';
import { closeDb, countQueries, withSystem } from '@inmolink/db';
import { setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { createKeyring, generateKey } from '@inmolink/platform/crypto';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as properties from '../../properties';
import * as taxonomy from '../../taxonomy';
import { portalCredentialsCipher, portalFeedTokenHash } from '../config';
import { selectConnectionListings, type WorkerConnection, workerConnections } from '../connections-worker';
import { planAgencyFeeds, writePlannedFeeds } from '../feed';
import * as exportsModule from '../index';
import * as repo from '../repo';
import { groupSelectionPages, type SelectionRule, selectionPage } from '../selection';
import { selectListings } from '../service';

/**
 * Portal connections and selection rules (S9-01): which listings a connection sends is deterministic — the agency's
 * ACTIVE, PUBLIC listings by rule (all / tagged / manual) with per-property includes and excludes — and the
 * connection keeps its credentials encrypted and its feed token only as a keyed hash.
 */

const RUN = newId().slice(-8);
const code = (s: string) => `${s}-${RUN}`;
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('exports.portal.test', fn);

let a: Founder;
let b: Founder;
let ids: { propertyType: string; city: string };
/** Fixture label → listing id (a's unless the label starts with `b`). */
const L: Record<string, string> = {};
const label = (id: string) => Object.entries(L).find(([, v]) => v === id)?.[0] ?? id;
const labels = (xs: readonly string[]) => xs.map(label).sort();

const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);
/** The same member as a plain agent: members read portal setup, admins change it. */
const asAgent = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  as(m, (ctx) =>
    fn({ ...ctx, actor: { ...(ctx.actor as { kind: 'user'; userId: string; role: string }), role: 'AGENT' } }),
  );

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (isAppError(err)) return err.code;
    throw err;
  }
  return 'accepted';
}

async function listing(
  m: Founder,
  state: Pick<UpdateListingBody, 'visibility' | 'status'>,
  tag?: string,
): Promise<string> {
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
        ...state,
        version: (await properties.getListing(ctx, id)).version,
      }),
    ),
  );
  if (tag) {
    await system((tx) =>
      tx.execute(sql`insert into property_tags (property_id, agency_id, tag) values (${id}, ${m.agencyId}, ${tag})`),
    );
  }
  return id;
}

async function connect(
  m: Founder,
  over: Partial<CreatePortalConnectionInput> & { name: string },
): Promise<PortalConnectionDto> {
  const body = CreatePortalConnectionBody.parse({ channelCode: 'kyero', ...over });
  return (await as(m, (ctx) => exportsModule.createConnection(ctx, body))).connection;
}

const choose = (m: Founder, connectionId: string, items: Record<string, 'INCLUDE' | 'EXCLUDE' | null>) =>
  as(m, (ctx) =>
    exportsModule.setOverrides(
      ctx,
      { connectionId },
      { items: Object.entries(items).map(([label, action]) => ({ propertyId: L[label] as string, action })) },
    ),
  );

/** Every page of a connection's selection, `size` ids at a time (never more than asked, strictly ascending). */
async function walk(m: Founder, connectionId: string, size: number): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | null = null;
  for (let rounds = 0; rounds < 1_000; rounds++) {
    const page: { ids: string[]; nextCursor: string | null } = await as(m, (ctx) =>
      selectListings(ctx, connectionId, { cursor, limit: size }),
    );
    expect(page.ids.length).toBeLessThanOrEqual(size);
    out.push(...page.ids);
    cursor = page.nextCursor;
    if (cursor === null) break;
  }
  return out;
}

beforeAll(async () => {
  await setupTestDb('worker');
  exportsModule.configureExports({
    keyring: createKeyring({ keys: { k1: generateKey() }, activeKeyId: 'k1' }),
    tokenKey: 'test-hmac-key-0123456789abcdef0123456789',
  });
  await system((tx) => exportsModule.syncPortalChannels(tx));
  [a, b] = [await createFounder(), await createFounder()];
  for (const m of [a, b]) await setAgencyStatus(m.agencyId, 'VERIFIED');
  ids = await system(async (tx) => {
    const name = (n: string) => [{ locale: 'en', name: `${n} ${RUN}`, slug: code(n.toLowerCase()) }];
    const country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('px'),
      translations: name('Portalia'),
    });
    const region = await taxonomy.createLocation(tx, {
      level: 'REGION',
      parentId: country,
      code: code('px-r'),
      translations: name('Coast'),
    });
    const city = await taxonomy.createLocation(tx, {
      level: 'CITY',
      parentId: region,
      code: code('px-c'),
      translations: name('Portalcity'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: code('px-g'),
      sort: 0,
      translations: name('Homes'),
    });
    const propertyType = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: code('px-t'),
      sort: 0,
      translations: name('Villa'),
    });
    return { propertyType, city };
  });
  // Eight PUBLIC listings (two with the tag `portal`, one with another), then the ones that never go out.
  L.p1 = await listing(a, { visibility: 'PUBLIC' }, 'portal');
  L.p2 = await listing(a, { visibility: 'PUBLIC' });
  L.p3 = await listing(a, { visibility: 'PUBLIC' }, 'portal');
  L.p4 = await listing(a, { visibility: 'PUBLIC' }, 'other');
  L.p5 = await listing(a, { visibility: 'PUBLIC' });
  L.p6 = await listing(a, { visibility: 'PUBLIC' }, 'portal');
  L.p7 = await listing(a, { visibility: 'PUBLIC' });
  L.p8 = await listing(a, { visibility: 'PUBLIC' });
  L.shared = await listing(a, { visibility: 'SHARED' }, 'portal');
  L.private = await listing(a, { visibility: 'PRIVATE' }, 'portal');
  L.withdrawn = await listing(a, { visibility: 'PUBLIC' }, 'portal');
  await as(a, async (ctx) =>
    properties.updateListing(
      ctx,
      L.withdrawn as string,
      UpdateListingBody.parse({
        status: 'WITHDRAWN',
        version: (await properties.getListing(ctx, L.withdrawn as string)).version,
      }),
    ),
  );
  L.deleted = await listing(a, { visibility: 'PUBLIC' }, 'portal');
  await as(a, (ctx) => properties.deleteListing(ctx, L.deleted as string));
  L.bPublic = await listing(b, { visibility: 'PUBLIC' }, 'portal');
}, 120_000);

afterAll(async () => {
  await closeDb();
});

describe('portal catalog', () => {
  it('[S9-01] lists Kyero, thinkSPAIN, A Place in the Sun and generic XML as available, idealista and Fotocasa as planned', async () => {
    const { items } = await as(a, (ctx) => exportsModule.listChannels(ctx));
    const status = Object.fromEntries(items.map((c) => [c.code, c.status]));
    expect(status).toMatchObject({
      kyero: 'AVAILABLE',
      thinkspain: 'AVAILABLE',
      'a-place-in-the-sun': 'AVAILABLE',
      'generic-xml': 'AVAILABLE',
      idealista: 'PLANNED',
      fotocasa: 'PLANNED',
    });
  });

  it('[S9-01] a planned portal cannot be connected yet', async () => {
    const body = CreatePortalConnectionBody.parse({ channelCode: 'idealista', name: 'Idealista' });
    expect(await refusal(as(a, (ctx) => exportsModule.createConnection(ctx, body)))).toBe('PORTAL_CHANNEL_UNAVAILABLE');
  });
});

describe('selection rules', () => {
  it('[S9-01] selection rules produce a deterministic listing set per connection (snapshot on fixtures)', async () => {
    const all = await connect(a, { name: 'All public' });
    const tagged = await connect(a, {
      name: 'Tagged',
      channelCode: 'thinkspain',
      selection: { mode: 'TAGGED', tag: 'portal' },
    });
    const manual = await connect(a, {
      name: 'Manual',
      channelCode: 'generic-xml',
      selection: { mode: 'MANUAL', tag: null },
    });
    const excluding = await connect(a, { name: 'Without p1 and p2', channelCode: 'a-place-in-the-sun' });
    const mixed = await connect(a, {
      name: 'Tagged plus',
      channelCode: 'generic-xml',
      selection: { mode: 'TAGGED', tag: 'portal' },
    });
    await choose(a, manual.id, {
      p2: 'INCLUDE',
      p4: 'INCLUDE',
      shared: 'INCLUDE',
      private: 'INCLUDE',
      withdrawn: 'INCLUDE',
    });
    await choose(a, excluding.id, { p1: 'EXCLUDE', p2: 'EXCLUDE', private: 'EXCLUDE' });
    await choose(a, mixed.id, { p2: 'INCLUDE', p5: 'INCLUDE', private: 'INCLUDE', p3: 'EXCLUDE', shared: 'EXCLUDE' });

    const snapshot: Record<string, string[]> = {};
    for (const [name, c] of Object.entries({ all, tagged, manual, excluding, mixed })) {
      const full = await walk(a, c.id, 1_000);
      expect(full).toEqual([...full].sort()); // ascending listing ids
      expect(new Set(full).size).toBe(full.length);
      snapshot[name] = labels(full);
      // The same set, whatever the page size, and again on a second run.
      for (const size of [1, 2, 3, 5]) expect(await walk(a, c.id, size)).toEqual(full);
      expect(await walk(a, c.id, 1_000)).toEqual(full);
    }
    expect(snapshot).toEqual({
      // every ACTIVE PUBLIC listing of the agency: not SHARED, PRIVATE, withdrawn, deleted, nor another agency's
      all: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'],
      tagged: ['p1', 'p3', 'p6'],
      // includes only; a SHARED, PRIVATE or withdrawn listing is never sent, whatever the choice
      manual: ['p2', 'p4'],
      excluding: ['p3', 'p4', 'p5', 'p6', 'p7', 'p8'],
      // the tag, plus p2 and p5, without p3; INCLUDE never publishes the PRIVATE listing
      mixed: ['p1', 'p2', 'p5', 'p6'],
    });
  });

  it('[S9-01] an ALL_PUBLIC page asks the database for at most two statements, however long the selection', async () => {
    const c = await connect(a, { name: 'Counted', channelCode: 'generic-xml' });
    await choose(a, c.id, { p2: 'INCLUDE', p7: 'EXCLUDE' });
    const rule = { agencyId: a.agencyId, connectionId: c.id, mode: 'ALL_PUBLIC' as const, tag: null };
    let n = Number.POSITIVE_INFINITY;
    await as(a, async (ctx) => {
      n = await countQueries(() => selectionPage(ctx.tx, rule, null, 3));
    });
    expect(n).toBeLessThanOrEqual(2);
    // TAGGED reads the INCLUDEs too: four.
    let tagged = Number.POSITIVE_INFINITY;
    await as(a, async (ctx) => {
      tagged = await countQueries(() => selectionPage(ctx.tx, { ...rule, mode: 'TAGGED', tag: 'portal' }, null, 3));
    });
    expect(tagged).toBeLessThanOrEqual(4);
  });

  it('[S9-01] another agency’s listings are never selected, and its connection is not visible', async () => {
    const c = await connect(b, { name: 'B all' });
    const own = await walk(b, c.id, 100);
    expect(own).toEqual([L.bPublic]);
    expect(await refusal(as(a, (ctx) => exportsModule.getConnection(ctx, { connectionId: c.id })))).toBe(
      'PORTAL_CONNECTION_NOT_FOUND',
    );
    expect(await refusal(as(a, (ctx) => selectListings(ctx, c.id)))).toBe('PORTAL_CONNECTION_NOT_FOUND');
  });

  it('[S9-01] a listing of another agency cannot be chosen', async () => {
    const c = await connect(a, { name: 'Foreign choice', channelCode: 'thinkspain' });
    expect(await refusal(choose(a, c.id, { bPublic: 'INCLUDE' }))).toBe('LISTING_NOT_FOUND');
  });

  it('[S9-01] clearing a choice returns the listing to the rule, and the counts follow', async () => {
    const c = await connect(a, { name: 'Clearing', channelCode: 'a-place-in-the-sun' });
    let dto = await choose(a, c.id, { p1: 'EXCLUDE', p2: 'EXCLUDE' });
    expect([dto.includeCount, dto.excludeCount]).toEqual([0, 2]);
    expect(labels(await walk(a, c.id, 100))).not.toContain('p1');
    dto = await choose(a, c.id, { p1: null });
    expect([dto.includeCount, dto.excludeCount]).toEqual([0, 1]);
    expect(labels(await walk(a, c.id, 100))).toContain('p1');
    expect(dto.version).toBeGreaterThan(c.version);
  });

  it('[S9-01] the rule’s tag is required for TAGGED and only then', () => {
    expect(PortalSelection.safeParse({ mode: 'TAGGED' }).success).toBe(false);
    expect(PortalSelection.safeParse({ mode: 'ALL_PUBLIC', tag: 'portal' }).success).toBe(false);
    // tags are normalised like the listing tags they match
    expect(PortalSelection.parse({ mode: 'TAGGED', tag: ' Portal ' }).tag).toBe('portal');
    expect(PortalSelection.safeParse({ mode: 'TAGGED', tag: 'portal' }).success).toBe(true);
  });

  it('[S9-01] the worker reads the connection once; its batches never read it again', async () => {
    const c = await connect(a, {
      name: 'Worker',
      channelCode: 'generic-xml',
      selection: { mode: 'TAGGED', tag: 'portal' },
    });
    const [conn] = await system((tx) => workerConnections(tx, a.agencyId, [c.id]));
    expect(conn).toMatchObject({ channelCode: 'generic-xml', enabled: true, revokedAt: null, version: c.version });
    expect(conn?.rule).toEqual({ agencyId: a.agencyId, connectionId: c.id, mode: 'TAGGED', tag: 'portal' });
    expect(await system((tx) => workerConnections(tx, b.agencyId, [c.id]))).toEqual([]);
    let reads = -1;
    const got = await system(async (tx) => {
      let out: Awaited<ReturnType<typeof selectConnectionListings>> | undefined;
      reads = await countQueries(
        async () => {
          out = await selectConnectionListings(tx, conn as WorkerConnection, {
            limit: 100,
          });
        },
        { match: /agency_portal_connections/ },
      );
      return out;
    });
    expect(labels(got?.ids ?? [])).toEqual(['p1', 'p3', 'p6']);
    expect(got?.nextCursor).toBeNull();
    expect(reads).toBe(0);
  });

  it('[S9-01] the dashboard preview is one page: at most 10 statements with EXCLUDEs clustered at the front', async () => {
    const c = await connect(a, { name: 'Clustered', channelCode: 'thinkspain' });
    // Hold back the first six listings by id: the first page of three is all excluded.
    const firstSix = Object.entries(L)
      .filter(([k]) => /^p[1-8]$/.test(k))
      .sort(([, x], [, y]) => (x < y ? -1 : 1))
      .slice(0, 6)
      .map(([k]) => k);
    await choose(a, c.id, Object.fromEntries(firstSix.map((k) => [k, 'EXCLUDE' as const])));
    let n = Number.POSITIVE_INFINITY;
    let page: Awaited<ReturnType<typeof exportsModule.previewSelection>> | undefined;
    await as(a, async (ctx) => {
      n = await countQueries(async () => {
        page = await exportsModule.previewSelection(ctx, { connectionId: c.id }, { limit: 3 });
      });
    });
    expect(n).toBeLessThanOrEqual(10);
    // A short page is fine: it continues from `nextCursor`, and the pages together are the selection.
    const seen: string[] = [];
    let cursor = page?.nextCursor ?? null;
    seen.push(...(page?.items.map((i) => i.propertyId) ?? []));
    for (let i = 0; cursor && i < 20; i++) {
      const next = await as(a, (ctx) =>
        exportsModule.previewSelection(ctx, { connectionId: c.id }, { limit: 3, cursor: cursor as string }),
      );
      seen.push(...next.items.map((x) => x.propertyId));
      cursor = next.nextCursor;
    }
    expect(seen).toEqual(await walk(a, c.id, 1_000));
    expect(labels(seen).sort()).toEqual(
      ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'].filter((k) => !firstSix.includes(k)).sort(),
    );
  });

  it('[S9-01] a batch reads a bounded number of pages, and a thin page continues from its cursor', async () => {
    const c = await connect(a, { name: 'Thin', channelCode: 'a-place-in-the-sun' });
    await choose(a, c.id, { p1: 'EXCLUDE', p2: 'EXCLUDE', p3: 'EXCLUDE', p4: 'EXCLUDE', p5: 'EXCLUDE', p6: 'EXCLUDE' });
    let n = Number.POSITIVE_INFINITY;
    await as(a, async (ctx) => {
      n = await countQueries(() => selectListings(ctx, c.id, { limit: 2 }));
    });
    expect(n).toBeLessThanOrEqual(2 + 20);
    expect(labels(await walk(a, c.id, 2))).toEqual(['p7', 'p8']);
  });

  it('[S9-01] a malformed cursor is a validation error, not a failure', async () => {
    const c = await connect(a, { name: 'Cursors', channelCode: 'generic-xml' });
    expect(await refusal(as(a, (ctx) => selectListings(ctx, c.id, { cursor: 'not-a-uuid' })))).toBe(
      'VALIDATION_FAILED',
    );
    expect(
      await refusal(
        as(a, (ctx) => exportsModule.previewSelection(ctx, { connectionId: c.id }, { limit: 5, cursor: 'x' })),
      ),
    ).toBe('VALIDATION_FAILED');
  });

  it('[S9-01] choosing by reference resolves case-insensitively in the service; an unknown reference refuses all', async () => {
    const c = await connect(a, { name: 'By ref', channelCode: 'generic-xml' });
    const refs = await as(a, (ctx) => properties.listingRefs(ctx.tx, a.agencyId, [L.p1 as string, L.p2 as string]));
    const ref = (id: string) => refs.find((r) => r.id === id)?.ref as string;
    const dto = await as(a, (ctx) =>
      exportsModule.setOverrides(
        ctx,
        { connectionId: c.id },
        {
          items: [
            { ref: ref(L.p1 as string).toLowerCase(), action: 'EXCLUDE' },
            { ref: ref(L.p2 as string), action: 'EXCLUDE' },
          ],
        },
      ),
    );
    expect(dto.excludeCount).toBe(2);
    expect(labels(await walk(a, c.id, 100))).not.toContain('p1');
    const before = dto.version;
    const missing = await as(a, async (ctx) => {
      try {
        await exportsModule.setOverrides(
          ctx,
          { connectionId: c.id },
          {
            items: [
              { ref: ref(L.p1 as string), action: null },
              { ref: 'NO-SUCH-REF', action: 'EXCLUDE' },
            ],
          },
        );
        return 'accepted';
      } catch (err) {
        return isAppError(err) ? err.code : 'other';
      }
    });
    expect(missing).toBe('LISTING_NOT_FOUND');
    expect((await as(a, (ctx) => exportsModule.getConnection(ctx, { connectionId: c.id }))).version).toBe(before);
    // one statement resolves any number of references
    let n = Number.POSITIVE_INFINITY;
    await as(a, async (ctx) => {
      n = await countQueries(() =>
        properties.listingIdsByRefs(ctx.tx, a.agencyId, [ref(L.p1 as string), ref(L.p2 as string)]),
      );
    });
    expect(n).toBe(1);
  });

  it('[S9-01] a choice that changes nothing bumps no version and emits no event', async () => {
    const c = await connect(a, { name: 'Idle', channelCode: 'kyero' });
    const first = await choose(a, c.id, { p1: 'EXCLUDE' });
    const again = await choose(a, c.id, { p1: 'EXCLUDE' });
    const clearNone = await choose(a, c.id, { p2: null });
    expect(again.version).toBe(first.version);
    expect(clearNone.version).toBe(first.version);
    const events = await system(async (tx) => {
      const r = await tx.execute<{ action: string }>(
        sql`select payload->>'action' as action from outbox_events
             where type = 'exports.connection.changed' and payload->>'connectionId' = ${c.id} order by id`,
      );
      return r.rows.map((x) => x.action);
    });
    expect(events).toEqual(['CREATED', 'SELECTION_CHANGED']);
  });

  it('[S9-01] a choice on a deleted listing can be cleared', async () => {
    const tmp = await listing(a, { visibility: 'PUBLIC' });
    L.tmp = tmp;
    const c = await connect(a, { name: 'Gone', channelCode: 'thinkspain' });
    expect((await choose(a, c.id, { tmp: 'EXCLUDE' })).excludeCount).toBe(1);
    await as(a, (ctx) => properties.deleteListing(ctx, tmp));
    expect(await refusal(choose(a, c.id, { tmp: 'INCLUDE' }))).toBe('LISTING_NOT_FOUND');
    const cleared = await choose(a, c.id, { tmp: null });
    expect(cleared.excludeCount).toBe(0);
  });
});

describe('connections', () => {
  // The selection tests above used up the agency's connection cap (20): start these from none.
  beforeAll(async () => {
    await system((tx) => tx.execute(sql`delete from agency_portal_connections where agency_id = ${a.agencyId}`));
  });

  it('[S10-F7] a retried create with the same Idempotency-Key answers the same connection and token, no second row', async () => {
    const body = CreatePortalConnectionBody.parse({ channelCode: 'kyero', name: 'Retried' });
    const idempotencyKey = `retry-key-${RUN}-0123456789`;
    const count = () =>
      system(async (tx) => {
        const r = await tx.execute<{ n: string }>(
          sql`select count(*)::text n from agency_portal_connections where agency_id = ${a.agencyId} and name = 'Retried'`,
        );
        return Number(r.rows[0]?.n);
      });
    const first = await as(a, (ctx) => exportsModule.createConnection(ctx, body, { idempotencyKey }));
    const retry = await as(a, (ctx) => exportsModule.createConnection(ctx, body, { idempotencyKey }));
    expect(first.replayed).toBe(false);
    expect(retry.replayed).toBe(true);
    expect(retry.connection.id).toBe(first.connection.id);
    expect(retry.token).toBe(first.token);
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await count()).toBe(1);
    // The same key with another body is refused; another key is another create (here the name is taken).
    const other = CreatePortalConnectionBody.parse({ channelCode: 'kyero', name: 'Retried 2' });
    expect(await refusal(as(a, (ctx) => exportsModule.createConnection(ctx, other, { idempotencyKey })))).toBe(
      'IDEMPOTENCY_KEY_REUSED',
    );
    expect(
      await refusal(
        as(a, (ctx) => exportsModule.createConnection(ctx, body, { idempotencyKey: `${idempotencyKey}-2` })),
      ),
    ).toBe('PORTAL_CONNECTION_NAME_TAKEN');
    // Another agency's identical key does not see this connection.
    const foreign = await as(b, (ctx) => exportsModule.createConnection(ctx, body, { idempotencyKey }));
    expect(foreign.replayed).toBe(false);
    expect(foreign.connection.id).not.toBe(first.connection.id);
    expect(foreign.token).not.toBe(first.token);
    // After a rotation the key never yields the old token (nor the new one): the retry is refused.
    await as(a, (ctx) => exportsModule.rotateConnectionToken(ctx, { connectionId: first.connection.id }));
    expect(await refusal(as(a, (ctx) => exportsModule.createConnection(ctx, body, { idempotencyKey })))).toBe(
      'IDEMPOTENCY_KEY_REUSED',
    );
    // After a delete, the same key makes a new connection with a NEW token.
    await as(a, (ctx) => exportsModule.deleteConnection(ctx, { connectionId: first.connection.id }));
    const again = await as(a, (ctx) => exportsModule.createConnection(ctx, body, { idempotencyKey }));
    expect(again.replayed).toBe(false);
    expect(again.connection.id).not.toBe(first.connection.id);
    expect(again.token).not.toBe(first.token);
    expect(await count()).toBe(1);
  });

  it('[S9-01] credentials are stored encrypted and never returned; the token only as a keyed hash', async () => {
    const body = CreatePortalConnectionBody.parse({
      channelCode: 'thinkspain',
      name: 'Secrets',
      credentials: { agentId: 'agent-secret-4711' },
    });
    const { connection, token } = await as(a, (ctx) => exportsModule.createConnection(ctx, body));
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(connection.credentialKeys).toEqual(['agentId']);
    expect(JSON.stringify(connection)).not.toContain('agent-secret-4711');
    expect(JSON.stringify(connection)).not.toContain(token);
    const row = await system(async (tx) => {
      const r = await tx.execute<{ credentials_enc: string; token_hash: string; token_hint: string }>(
        sql`select credentials_enc, token_hash, token_hint from agency_portal_connections where id = ${connection.id}`,
      );
      return r.rows[0];
    });
    expect(row?.credentials_enc).toMatch(/^v1\./);
    expect(row?.credentials_enc).not.toContain('agent-secret-4711');
    expect(row?.token_hash).toBe(portalFeedTokenHash(token));
    expect(row?.token_hash).not.toContain(token);
    expect(row?.token_hint).toBe(token.slice(-4));
    // Decrypts back only for its own agency and row.
    expect(portalCredentialsCipher.decrypt(a.agencyId, connection.id, row?.credentials_enc as string)).toEqual({
      agentId: 'agent-secret-4711',
    });
    expect(() => portalCredentialsCipher.decrypt(b.agencyId, connection.id, row?.credentials_enc as string)).toThrow();
  });

  it('[S9-01] the dashboard lists credential names from their own column, never by decrypting', async () => {
    const body = CreatePortalConnectionBody.parse({
      channelCode: 'thinkspain',
      name: 'Names only',
      credentials: { agentId: 'secret-agent-1' },
    });
    const { connection } = await as(a, (ctx) => exportsModule.createConnection(ctx, body));
    const stored = await system(async (tx) => {
      const r = await tx.execute<{ credential_keys: string[] }>(
        sql`select credential_keys from agency_portal_connections where id = ${connection.id}`,
      );
      return r.rows[0]?.credential_keys;
    });
    expect(stored).toEqual(['agentId']);
    // Corrupt the envelope: reading the connection still works (nothing is decrypted), and the keys follow updates.
    await system((tx) =>
      tx.execute(sql`update agency_portal_connections set credentials_enc = 'v1.broken' where id = ${connection.id}`),
    );
    expect(
      (await as(a, (ctx) => exportsModule.getConnection(ctx, { connectionId: connection.id }))).credentialKeys,
    ).toEqual(['agentId']);
    const removed = await as(a, (ctx) =>
      exportsModule.updateConnection(
        ctx,
        { connectionId: connection.id },
        { version: connection.version, credentials: null },
      ),
    );
    expect(removed.credentialKeys).toEqual([]);
  });

  it('[S9-01] credentials of a portal that is missing or not available are refused on update too', async () => {
    const c = await connect(a, { name: 'Moved', channelCode: 'generic-xml' });
    await system((tx) =>
      tx.execute(sql`update agency_portal_connections set channel_code = 'idealista' where id = ${c.id}`),
    );
    expect(
      await refusal(
        as(a, (ctx) =>
          exportsModule.updateConnection(
            ctx,
            { connectionId: c.id },
            { version: c.version, credentials: { clientId: 'x' } },
          ),
        ),
      ),
    ).toBe('PORTAL_CHANNEL_UNAVAILABLE');
  });

  it('[S9-01] only the keys a portal declares are accepted as credentials', async () => {
    const body = CreatePortalConnectionBody.parse({
      channelCode: 'kyero',
      name: 'Bad keys',
      credentials: { apiKey: 'x' },
    });
    expect(await refusal(as(a, (ctx) => exportsModule.createConnection(ctx, body)))).toBe('VALIDATION_FAILED');
  });

  it('[S9-01] rotating the token replaces the hash, revoking turns it off, rotating again revives it', async () => {
    const created = await as(a, (ctx) =>
      exportsModule.createConnection(ctx, CreatePortalConnectionBody.parse({ channelCode: 'kyero', name: 'Rotating' })),
    );
    const rotated = await as(a, (ctx) =>
      exportsModule.rotateConnectionToken(ctx, { connectionId: created.connection.id }),
    );
    expect(rotated.token).not.toBe(created.token);
    expect(rotated.connection.tokenHint).toBe(rotated.token.slice(-4));
    const revoked = await as(a, (ctx) =>
      exportsModule.revokeConnectionToken(ctx, { connectionId: created.connection.id }),
    );
    expect(revoked.tokenActive).toBe(false);
    const revived = await as(a, (ctx) =>
      exportsModule.rotateConnectionToken(ctx, { connectionId: created.connection.id }),
    );
    expect(revived.connection.tokenActive).toBe(true);
    const hash = await system(async (tx) => {
      const r = await tx.execute<{ token_hash: string }>(
        sql`select token_hash from agency_portal_connections where id = ${created.connection.id}`,
      );
      return r.rows[0]?.token_hash;
    });
    expect(hash).toBe(portalFeedTokenHash(revived.token));
  });

  it('[S9-01] members read portal setup, only admins change it', async () => {
    const c = await connect(a, { name: 'Roles', channelCode: 'generic-xml' });
    expect((await asAgent(a, (ctx) => exportsModule.getConnection(ctx, { connectionId: c.id }))).id).toBe(c.id);
    const body = CreatePortalConnectionBody.parse({ channelCode: 'kyero', name: 'By agent' });
    expect(await refusal(asAgent(a, (ctx) => exportsModule.createConnection(ctx, body)))).toBe('FORBIDDEN');
    expect(
      await refusal(
        asAgent(a, (ctx) =>
          exportsModule.updateConnection(ctx, { connectionId: c.id }, { version: c.version, enabled: false }),
        ),
      ),
    ).toBe('FORBIDDEN');
    expect(await refusal(asAgent(a, (ctx) => exportsModule.rotateConnectionToken(ctx, { connectionId: c.id })))).toBe(
      'FORBIDDEN',
    );
  });

  it('[S9-01] a stale version is refused, a name is unique per portal, a change emits an outbox event', async () => {
    const c = await connect(a, { name: 'Versions', channelCode: 'kyero' });
    const updated = await as(a, (ctx) =>
      exportsModule.updateConnection(ctx, { connectionId: c.id }, { version: c.version, enabled: false }),
    );
    expect(updated.enabled).toBe(false);
    expect(updated.version).toBe(c.version + 1);
    expect(
      await refusal(
        as(a, (ctx) =>
          exportsModule.updateConnection(ctx, { connectionId: c.id }, { version: c.version, enabled: true }),
        ),
      ),
    ).toBe('VERSION_CONFLICT');
    expect(await refusal(connect(a, { name: 'VERSIONS', channelCode: 'kyero' }))).toBe('PORTAL_CONNECTION_NAME_TAKEN');
    const events = await system(async (tx) => {
      const r = await tx.execute<{ action: string }>(
        sql`select payload->>'action' as action from outbox_events
             where type = 'exports.connection.changed' and payload->>'connectionId' = ${c.id} order by id`,
      );
      return r.rows.map((x) => x.action);
    });
    expect(events).toEqual(['CREATED', 'UPDATED']);
  });

  it('[S9-01] deleting a connection removes its per-property choices', async () => {
    const c = await connect(a, { name: 'Deleting', channelCode: 'generic-xml' });
    await choose(a, c.id, { p1: 'INCLUDE' });
    await as(a, (ctx) => exportsModule.deleteConnection(ctx, { connectionId: c.id }));
    expect(await refusal(as(a, (ctx) => exportsModule.getConnection(ctx, { connectionId: c.id })))).toBe(
      'PORTAL_CONNECTION_NOT_FOUND',
    );
    const left = await system(async (tx) => {
      const r = await tx.execute<{ n: number }>(
        sql`select count(*)::int as n from portal_connection_properties where connection_id = ${c.id}`,
      );
      return r.rows[0]?.n;
    });
    expect(left).toBe(0);
  });

  it('[S9-01] lists the agency’s connections by keyset and the per-property choices with references', async () => {
    const first = await as(a, (ctx) => exportsModule.listConnections(ctx, { limit: 2 }));
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const c = await connect(a, { name: 'Listed choices', channelCode: 'thinkspain' });
    await choose(a, c.id, { p1: 'INCLUDE', p2: 'EXCLUDE' });
    const page = await as(a, (ctx) => exportsModule.listOverrides(ctx, { connectionId: c.id }, { limit: 10 }));
    expect(page.items.map((i) => [label(i.propertyId), i.action]).sort()).toEqual([
      ['p1', 'INCLUDE'],
      ['p2', 'EXCLUDE'],
    ]);
    expect(page.items.every((i) => typeof i.ref === 'string')).toBe(true);
    const preview = await as(a, (ctx) => exportsModule.previewSelection(ctx, { connectionId: c.id }, { limit: 50 }));
    expect(preview.items.length).toBeGreaterThan(0);
    expect(preview.items.every((i) => (i.ref ?? '').length > 0)).toBe(true);
  });
});

// ── S10-F9: one selection read per rule across an agency's connections; setOverrides within budget ─────────────────

describe('[S10-F9] grouped selection and the overrides budget', () => {
  let g: Founder;
  const G: Record<string, string> = {};
  /** 20 connections (the cap): 8 ALL_PUBLIC, 6 TAGGED `portal`, 6 MANUAL — three rules. */
  const conns: { id: string; mode: 'ALL_PUBLIC' | 'TAGGED' | 'MANUAL' }[] = [];
  const RULES = 3;

  beforeAll(async () => {
    g = await createFounder();
    await setAgencyStatus(g.agencyId, 'VERIFIED');
    G.g1 = await listing(g, { visibility: 'PUBLIC' }, 'portal');
    G.g2 = await listing(g, { visibility: 'PUBLIC' });
    G.g3 = await listing(g, { visibility: 'PUBLIC' }, 'portal');
    G.g4 = await listing(g, { visibility: 'PUBLIC' });
    G.g5 = await listing(g, { visibility: 'PRIVATE' }, 'portal');
    for (let i = 0; i < 20; i++) {
      const mode = i < 8 ? 'ALL_PUBLIC' : i < 14 ? 'TAGGED' : 'MANUAL';
      const c = await connect(g, {
        name: `Grouped ${i}`,
        channelCode: i % 2 === 0 ? 'kyero' : 'generic-xml',
        selection: { mode, tag: mode === 'TAGGED' ? 'portal' : null },
      });
      conns.push({ id: c.id, mode });
    }
    // Per-connection choices that make the members of a rule differ.
    const set = (c: string, items: [string, 'INCLUDE' | 'EXCLUDE'][]) =>
      as(g, (ctx) =>
        exportsModule.setOverrides(
          ctx,
          { connectionId: c },
          { items: items.map(([k, action]) => ({ propertyId: G[k] as string, action })) },
        ),
      );
    const of = (mode: string) => conns.filter((c) => c.mode === mode).map((c) => c.id);
    const [all0, all1] = of('ALL_PUBLIC');
    const [tag0, tag1] = of('TAGGED');
    const [man0, man1] = of('MANUAL');
    await set(all0 as string, [['g2', 'EXCLUDE']]);
    await set(all1 as string, [
      ['g4', 'EXCLUDE'],
      ['g1', 'EXCLUDE'],
    ]);
    await set(tag0 as string, [
      ['g2', 'INCLUDE'],
      ['g1', 'EXCLUDE'],
    ]);
    await set(tag1 as string, [['g5', 'INCLUDE']]);
    await set(man0 as string, [
      ['g1', 'INCLUDE'],
      ['g4', 'INCLUDE'],
    ]);
    await set(man1 as string, [
      ['g5', 'INCLUDE'],
      ['g3', 'INCLUDE'],
    ]);
  }, 120_000);

  /** What a connection's own selection (S9-01) returns, walked to the end. */
  const ownSelection = (c: WorkerConnection) =>
    system(async (tx) => {
      const out: string[] = [];
      let cursor: string | null = null;
      for (;;) {
        const page = await selectConnectionListings(tx, c, { cursor, limit: 200 });
        out.push(...page.ids);
        cursor = page.nextCursor;
        if (cursor === null) return out;
      }
    });

  it('[S10-F9] grouped selection selects exactly what each connection selects alone, at any page size', async () => {
    const loaded = await system((tx) => workerConnections(tx, g.agencyId, null));
    expect(loaded).toHaveLength(20);
    for (const size of [200, 2, 1]) {
      for (const mode of ['ALL_PUBLIC', 'TAGGED', 'MANUAL'] as const) {
        const members = loaded.filter((c) => c.rule.mode === mode);
        const rule = members[0]?.rule as SelectionRule;
        // The whole group walks the selection together, cut at the smallest `next` like a pass does.
        const got = new Map<string, string[]>(members.map((c) => [c.id, []]));
        let after: string | null = null;
        for (let round = 0; round < 50; round++) {
          const pages: Map<string, { ids: string[]; next: string | null }> = await system((tx) =>
            groupSelectionPages(
              tx,
              g.agencyId,
              rule,
              members.map((c) => c.id),
              after,
              size,
            ),
          );
          const nexts = [...pages.values()].map((p) => p.next).filter((n): n is string => n !== null);
          const bound: string | null = nexts.sort()[0] ?? null;
          for (const [id, p] of pages) {
            got.get(id)?.push(...p.ids.filter((x) => bound === null || x <= bound));
          }
          after = bound ?? null;
          if (after === null) break;
        }
        for (const c of members) expect(got.get(c.id)).toEqual(await ownSelection(c));
      }
    }
  });

  it('[S10-F9] a 20-connection agency’s batch runs ≤ 2 × (rules + 2) statements; issue rows in one statement', async () => {
    const plan = await planAgencyFeeds(g.agencyId, 'live');
    expect(plan.ready).toHaveLength(20);
    const sinks = new Map(plan.ready.map((p) => [p.connection.id, async (_chunk: string) => {}]));
    const statements: string[] = [];
    let outcomes: Awaited<ReturnType<typeof writePlannedFeeds>> = [];
    const n = await countQueries(
      async () => {
        outcomes = await writePlannedFeeds(plan, sinks, {
          mediaBaseUrl: 'https://media.example',
          recordSummary: false,
        });
      },
      { onQuery: (q) => statements.push(q) },
    );
    // One batch (five listings < 200): per rule two statements, the documents once, the issue rows once.
    expect(n).toBeLessThanOrEqual(2 * (RULES + 2));
    expect(statements.filter((q) => /portal_connection_issues/.test(q))).toHaveLength(1);
    expect(outcomes).toHaveLength(20);
    // The issue rows are each connection's own: no read model here, so every selected listing is NO_DOCUMENT.
    for (const p of plan.ready) {
      const rows = await system(
        async (tx) =>
          (
            await tx.execute<{ property_id: string }>(
              sql`select property_id from portal_connection_issues where connection_id = ${p.connection.id}
                   order by property_id`,
            )
          ).rows,
      );
      expect(rows.map((r) => r.property_id)).toEqual(await ownSelection(p.connection));
    }
  });

  it('[S10-F9] nightly lanes are hash ranges: the first / next probes visit every due agency once, in its lane', async () => {
    const mine = [a.agencyId, b.agencyId, g.agencyId];
    const LANES = 3;
    const before = new Date(Date.now() + 60_000);
    // In one rolled-back transaction: only these agencies are due (the shared database holds other files' rows).
    const seen = await system(async (tx) => {
      await tx.execute(sql`update agency_portal_connections
                              set nightly_at = case when agency_id in ${mine} then null else ${before.toISOString()}::timestamptz end`);
      const expected = (
        await tx.execute<{ agency_id: string; lane: number }>(sql`
          select distinct agency_id,
                 ((hashtext(agency_id::text)::bigint + 2147483648) * ${LANES} / 4294967296)::int as lane
            from agency_portal_connections where enabled and revoked_at is null and agency_id in ${mine}`)
      ).rows;
      const visited: { agency_id: string; lane: number }[] = [];
      const firsts = await repo.firstNightlyAgencies(tx, { before, lanes: LANES });
      for (const first of firsts) {
        let at: string | null = first.agencyId;
        while (at !== null) {
          visited.push({ agency_id: at, lane: first.lane });
          at = await repo.nextNightlyAgency(tx, { before, lanes: LANES, lane: first.lane, after: at });
        }
      }
      // A chain whose `after` is not in its lane (started under another lane split) restarts at the lane's first.
      for (const first of firsts) {
        let stranger = newId();
        for (;;) {
          const r = await tx.execute<{ lane: number }>(
            sql`select ((hashtext(${stranger}::uuid::text)::bigint + 2147483648) * ${LANES} / 4294967296)::int as lane`,
          );
          if (r.rows[0]?.lane !== first.lane) break;
          stranger = newId();
        }
        expect(await repo.nextNightlyAgency(tx, { before, lanes: LANES, lane: first.lane, after: stranger })).toBe(
          first.agencyId,
        );
      }
      // Rolled back: the result leaves the transaction inside the error.
      throw Object.assign(new Error('rollback'), { result: { expected, visited } });
    }).catch((err: { result?: unknown }) => {
      if (!err.result) throw err;
      return err.result;
    });
    const { expected, visited } = seen as {
      expected: { agency_id: string; lane: number }[];
      visited: { agency_id: string; lane: number }[];
    };
    const byId = (xs: { agency_id: string }[]) => [...xs].sort((x, y) => x.agency_id.localeCompare(y.agency_id));
    expect(expected.length).toBeGreaterThan(0);
    expect(byId(visited)).toEqual(byId(expected));
  });

  it('[S10-F9] lane edges: each hash at the ends and on both sides of every lane boundary is in exactly one lane', async () => {
    for (const lanes of [1, 3, 7, 64]) {
      const rows = await system(
        async (tx) =>
          (
            await tx.execute<{ h: string; n: number }>(sql`
              with b as (select ${repo.laneStart(sql`g`, lanes)} as lo from generate_series(1, ${lanes - 1}::int) g),
                   hs as (select -2147483648::bigint as h union select 2147483647::bigint
                          union select lo - 1 from b union select lo from b)
              select hs.h::text as h,
                     (select count(*)::int from generate_series(0, ${lanes - 1}::int) l(lane)
                       where hs.h >= ${repo.laneStart(sql`l.lane`, lanes)}
                         and hs.h < ${repo.laneStart(sql`l.lane + 1`, lanes)}) as n
                from hs`)
          ).rows,
      );
      expect(rows.length, `lanes ${lanes}`).toBe(lanes === 1 ? 2 : 2 + 2 * (lanes - 1));
      for (const r of rows) {
        expect(BigInt(r.h) >= -2147483648n && BigInt(r.h) <= 2147483647n, `lanes ${lanes} h ${r.h}`).toBe(true);
        expect(r.n, `lanes ${lanes} h ${r.h}`).toBe(1);
      }
    }
  });

  it('[S10-F9] setOverrides runs ≤ 10 statements (references, ids, sets and clears in one request)', async () => {
    const c = conns.find((x) => x.mode === 'ALL_PUBLIC')?.id as string;
    const refs = await system((tx) => properties.listingRefs(tx, g.agencyId, [G.g3 as string]));
    let n = Number.POSITIVE_INFINITY;
    const dto = await as(g, async (ctx) => {
      let out: PortalConnectionDto | undefined;
      n = await countQueries(async () => {
        out = await exportsModule.setOverrides(
          ctx,
          { connectionId: c },
          {
            items: [
              { ref: refs[0]?.ref as string, action: 'EXCLUDE' },
              { propertyId: G.g4 as string, action: 'INCLUDE' },
              { propertyId: G.g2 as string, action: null },
            ],
          },
        );
      });
      return out as PortalConnectionDto;
    });
    expect(n).toBeLessThanOrEqual(10);
    // The counts come from the rows as written: g3 EXCLUDE, g4 INCLUDE (g2's EXCLUDE cleared).
    expect(dto).toMatchObject({ includeCount: 1, excludeCount: 1 });
  });
});
