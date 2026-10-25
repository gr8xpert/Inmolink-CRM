import { CreateListingBody, type CreateNetworkPostBody, UpdateListingBody } from '@inmolink/contracts';
import { closeDb, type Tx, withSystem, withTenant } from '@inmolink/db';
import { loadStackEnv, setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { configureSearch, createMeiliEngine } from '@inmolink/platform/search';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder, impersonatedCtx } from '../../../testing/factories';
import * as chat from '../../chat';
import * as properties from '../../properties';
import * as search from '../../search';
import * as taxonomy from '../../taxonomy';
import * as network from '../index';

/**
 * Network board (S11-05) on the real test database and Meilisearch: who reads a post (RLS), subscriptions notify only
 * the members whose filters match, a buyer request notifies each agency with matching listings once with those
 * listings, and a reply opens a NETWORK chat thread with the poster.
 */

const RUN = newId().slice(-8).toLowerCase();
const UID = `t_netboard_${RUN.replace(/[^A-Za-z0-9]/g, '')}`;
const real = () =>
  createMeiliEngine({ url: process.env.MEILI_URL as string, apiKey: process.env.MEILI_MASTER_KEY as string });
const system = <T>(fn: (tx: Tx) => Promise<T>) => withSystem('network.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);

/**
 * p: posts · s: subscribers (s, s2, s3 its agents) · m: owns 3 matching listings and 1 that does not match ·
 * n: owns 1 matching listing · u: an unverified agency (subscribed to everything).
 */
let p: Founder;
let s: Founder;
let s2: Founder;
let s3: Founder;
let m: Founder;
let n: Founder;
let u: Founder;
let p2: Founder;
let ids: { country: string; city: string; area: string; elsewhere: string; villa: string; flat: string };
const L: Record<string, string> = {};
const REF: Record<string, string> = {};

const as = <T>(f: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: f.userId, agencyId: f.agencyId, requestId: newId(), locale: 'en' }, fn);
const asUser = <T>(f: Founder, q: ReturnType<typeof sql>) =>
  withTenant({ agencyId: f.agencyId, userId: f.userId }, async (tx) => (await tx.execute(q)).rows as T[]);

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (isAppError(err)) return err.code;
    if (err instanceof ZodError) return 'ZOD';
    throw err;
  }
  return 'accepted';
}

async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (err) {
    for (let e = err as { code?: unknown; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
      if (typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) return e.code;
    }
    return `no sqlstate: ${String(err)}`;
  }
  return undefined;
}

async function agent(agencyId: string, name: string): Promise<Founder> {
  const userId = newId();
  const email = `netboard-${name.toLowerCase()}-${userId}@example.com`;
  await system(async (tx) => {
    await tx.execute(sql`insert into users (id, email, password_hash, name, locale, status)
      values (${userId}, ${email}, 'x', ${name}, 'en', 'ACTIVE')`);
    await tx.execute(sql`insert into agency_members (agency_id, user_id, role, name, email)
      values (${agencyId}, ${userId}, 'AGENT', ${name}, ${email})`);
  });
  return { userId, agencyId, email, password: 'x' };
}

async function listing(f: Founder, body: Partial<CreateListingBody>): Promise<string> {
  const { id } = await as(f, (ctx) =>
    properties.createListing(
      ctx,
      CreateListingBody.parse({
        propertyTypeId: ids.villa,
        locationId: ids.area,
        priceCents: 50_000_000,
        energyRating: 'B',
        commission: { type: 'PCT', basisPoints: 500, includesVat: false },
        splitBp: 5000,
        ...body,
      }),
    ),
  );
  await as(f, async (ctx) =>
    properties.updateListing(
      ctx,
      id,
      UpdateListingBody.parse({
        status: 'ACTIVE',
        visibility: 'SHARED',
        shareScope: 'ALL',
        version: (await properties.getListing(ctx, id)).version,
      }),
    ),
  );
  REF[id] = (await as(f, (ctx) => properties.getListing(ctx, id))).ref ?? '';
  return id;
}

const buyerRequest = (over: Partial<CreateNetworkPostBody> = {}): CreateNetworkPostBody => ({
  kind: 'BUYER_REQUEST',
  title: `Villa wanted ${RUN}`,
  body: 'Family relocating, sea views preferred, ready to buy this quarter.',
  criteria: {
    transactionType: 'SALE',
    propertyTypeIds: [ids.villa],
    locationIds: [ids.area],
    priceMinCents: 30_000_000,
    priceMaxCents: 80_000_000,
  },
  ...over,
});

const notificationsOf = (type: string, sourceKey: string) =>
  rows<{ agency_id: string; user_id: string; params: Record<string, unknown> }>(sql`
    select agency_id, user_id, params from notifications where type = ${type} and source_key = ${sourceKey}`);

/** Notifications of this file's agencies only. */
const mineOnly = <T extends { agency_id: string }>(xs: T[]) => {
  const own = new Set([p, s, m, n, u].map((f) => f.agencyId));
  return xs.filter((x) => own.has(x.agency_id));
};

beforeAll(async () => {
  await setupTestDb('worker');
  loadStackEnv('test');
  [p, s, m, n, u] = await Promise.all([
    createFounder(),
    createFounder(),
    createFounder(),
    createFounder(),
    createFounder(),
  ]);
  for (const f of [p, s, m, n]) await setAgencyStatus(f.agencyId, 'VERIFIED');
  [s2, s3, p2] = await Promise.all([agent(s.agencyId, 'Sol'), agent(s.agencyId, 'Tea'), agent(p.agencyId, 'Pia')]);
  ids = await system(async (tx) => {
    const name = (x: string) => [{ locale: 'en', name: `${x} ${RUN}`, slug: `nb-${x.toLowerCase()}-${RUN}` }];
    const country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: `nb-${RUN}`,
      translations: name('Boardland'),
    });
    const elsewhere = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: `nb-x-${RUN}`,
      translations: name('Farland'),
    });
    const region = await taxonomy.createLocation(tx, {
      level: 'REGION',
      parentId: country,
      code: `nb-r-${RUN}`,
      translations: name('Boardregion'),
    });
    const city = await taxonomy.createLocation(tx, {
      level: 'CITY',
      parentId: region,
      code: `nb-c-${RUN}`,
      translations: name('Boardcity'),
    });
    const area = await taxonomy.createLocation(tx, {
      level: 'AREA',
      parentId: city,
      code: `nb-a-${RUN}`,
      translations: name('Boardarea'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: `nb-g-${RUN}`,
      sort: 0,
      translations: name('Homes'),
    });
    const type = (t: string) =>
      taxonomy.createPropertyType(tx, { groupId: group, key: `nb-${t}-${RUN}`, sort: 0, translations: name(t) });
    return { country, city, area, elsewhere, villa: await type('Villa'), flat: await type('Flat') };
  });
  L.m1 = await listing(m, { priceCents: 40_000_000 });
  L.m2 = await listing(m, { priceCents: 55_000_000 });
  L.m3 = await listing(m, { priceCents: 70_000_000 });
  L.mFlat = await listing(m, { propertyTypeId: ids.flat });
  L.mDear = await listing(m, { priceCents: 200_000_000 });
  L.n1 = await listing(n, { priceCents: 60_000_000 });
  // the poster's own matching listing is never matched for it
  L.p1 = await listing(p, { priceCents: 60_000_000 });
  await system((tx) => search.rebuildReadModels(tx, 'LISTING', Object.values(L)));
  configureSearch(real());
  search.configureSearchIndex({ uid: UID, scope: Object.values(L) });
  await search.ensureListingsIndex(real(), search.listingsIndex(UID));
  await search.syncIndex();
}, 240_000);

afterAll(async () => {
  await real().dropIndex(UID);
  const targets = Object.values(L);
  if (targets.length > 0) {
    await system(async (tx) => {
      const list = sql.join(
        targets.map((x) => sql`${x}`),
        sql`, `,
      );
      await tx.execute(sql`delete from search_index_queue where target_id in (${list})`);
      await tx.execute(sql`delete from listing_search_docs where target_id in (${list})`);
    });
  }
  await closeDb();
});

describe('subscriptions', () => {
  it('[S11-05] subscribers receive only posts matching their filters', async () => {
    // s: villas for sale in the city (the post is about one of its areas), in budget
    await as(s, (ctx) =>
      network.createSubscription(ctx, {
        name: 'City villas',
        kinds: ['BUYER_REQUEST'],
        transactionType: 'SALE',
        propertyTypeIds: [ids.villa],
        locationIds: [ids.city],
        priceMaxCents: 50_000_000,
      }),
    );
    // s2: another country — s3: offers only — s3 also: flats only
    await as(s2, (ctx) => network.createSubscription(ctx, { name: 'Far away', locationIds: [ids.elsewhere] }));
    await as(s3, (ctx) => network.createSubscription(ctx, { name: 'Offers', kinds: ['PROPERTY_OFFER'] }));
    await as(s3, (ctx) => network.createSubscription(ctx, { name: 'Flats', propertyTypeIds: [ids.flat] }));
    // above the request's budget: the ranges do not overlap
    await as(s2, (ctx) => network.createSubscription(ctx, { name: 'Luxury', priceMinCents: 90_000_000 }));
    // an unverified agency and the poster's colleague subscribe to everything: neither is told
    await as(u, (ctx) => network.createSubscription(ctx, { name: 'All' }));
    await as(p2, (ctx) => network.createSubscription(ctx, { name: 'All' }));
    // a second matching subscription of s: still one notification
    await as(s, (ctx) => network.createSubscription(ctx, { name: 'Everything' }));

    const { post } = await as(p, (ctx) => network.createPost(ctx, buyerRequest()));
    expect(post.own).toBe(true);
    expect(post.criteria.locationIds).toEqual([ids.area]);
    // the event drives the job
    const [event] = await rows<{ payload: { postId: string; kind: string } }>(
      sql`select payload from outbox_events where type = 'network.post.published' and payload ->> 'postId' = ${post.id}`,
    );
    expect(event?.payload.kind).toBe('BUYER_REQUEST');

    // (the shared test database keeps other runs' subscriptions: assertions are about this file's agencies)
    expect((await network.notifySubscribers(post.id)).notified).toBeGreaterThanOrEqual(1);
    // a retried job raises nothing twice
    expect((await network.notifySubscribers(post.id)).notified).toBe(0);
    const told = mineOnly(await notificationsOf('NETWORK_POST', `network.post:${post.id}`));
    expect(told.map((t) => t.user_id)).toEqual([s.userId]);
    expect(told[0]?.params).toMatchObject({ subject: `Villa wanted ${RUN}`, kind: 'BUYER_REQUEST' });

    // a property offer without criteria: only the subscriptions without filters but kinds that include it
    const offer = await as(p, (ctx) =>
      network.createPost(ctx, { kind: 'PROPERTY_OFFER', title: `Off-market penthouse ${RUN}`, body: 'Ask us.' }),
    );
    await network.notifySubscribers(offer.post.id);
    const toldOffer = mineOnly(await notificationsOf('NETWORK_POST', `network.post:${offer.post.id}`));
    expect(toldOffer.map((t) => t.user_id).sort()).toEqual([s.userId, s3.userId].sort());
  });

  it('[S11-05] a member reads and changes only their own subscriptions, at most 20', async () => {
    const mine = await as(s3, (ctx) => network.listSubscriptions(ctx));
    expect(mine.items.map((i) => i.name).sort()).toEqual(['Flats', 'Offers']);
    const first = mine.items[0]?.id as string;
    // a colleague neither reads (RLS) nor changes it
    expect(
      (await asUser<{ id: string }>(s2, sql`select id from network_subscriptions where id = ${first}`)).length,
    ).toBe(0);
    expect(await refusal(as(s2, (ctx) => network.updateSubscription(ctx, first, { name: 'Mine now' })))).toBe(
      'NETWORK_SUBSCRIPTION_NOT_FOUND',
    );
    expect(await refusal(as(s2, (ctx) => network.deleteSubscription(ctx, first)))).toBe(
      'NETWORK_SUBSCRIPTION_NOT_FOUND',
    );
    const changed = await as(s3, (ctx) =>
      network.updateSubscription(ctx, first, { name: 'Renamed', kinds: ['DISTRESSED'] }),
    );
    expect(changed).toMatchObject({ name: 'Renamed', kinds: ['DISTRESSED'] });
    await as(s3, (ctx) => network.deleteSubscription(ctx, first));
    const many = await agent(s.agencyId, 'Max');
    for (let i = 0; i < 20; i++) await as(many, (ctx) => network.createSubscription(ctx, { name: `S${i}` }));
    expect(await refusal(as(many, (ctx) => network.createSubscription(ctx, { name: 'S20' })))).toBe(
      'NETWORK_SUBSCRIPTION_LIMIT',
    );
  });
});

describe('buyer request matching', () => {
  it('[S11-05] a buyer request matching 3 of my listings notifies me once with those 3', async () => {
    // m also subscribes to everything: told of the match, it is not told of the post again
    await as(m, (ctx) => network.createSubscription(ctx, { name: 'All' }));
    const { post } = await as(p, (ctx) => network.createPost(ctx, buyerRequest({ title: `Match me ${RUN}` })));
    const first = await network.matchBuyerRequest(post.id);
    expect(first.agencies).toBe(2);
    // a retried job raises nothing twice
    expect((await network.matchBuyerRequest(post.id)).notified).toBe(0);

    const told = await notificationsOf('NETWORK_MATCH', `network.match:${post.id}`);
    const mine = told.filter((t) => t.agency_id === m.agencyId);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.user_id).toBe(m.userId);
    expect(mine[0]?.params.count).toBe(3);
    const refs = String(mine[0]?.params.refs).split(', ').sort();
    expect(refs).toEqual([L.m1, L.m2, L.m3].map((id) => REF[id as string]).sort());
    // the other owner is told about its own listing only; the poster about nothing (its own listing is not matched)
    expect(told.filter((t) => t.agency_id === n.agencyId).map((t) => t.params.count)).toEqual([1]);
    expect(told.filter((t) => t.agency_id === p.agencyId)).toHaveLength(0);
    expect(String(told.find((t) => t.agency_id === n.agencyId)?.params.refs)).toBe(REF[L.n1 as string]);

    await network.notifySubscribers(post.id);
    const posted = mineOnly(await notificationsOf('NETWORK_POST', `network.post:${post.id}`));
    expect(posted.map((t) => t.user_id)).not.toContain(m.userId);
    expect(posted.map((t) => t.user_id)).toContain(s.userId);
  });

  it('[S11-05] only buyer requests are matched, and only while open', async () => {
    const offer = await as(p, (ctx) =>
      network.createPost(ctx, { ...buyerRequest(), kind: 'PROPERTY_OFFER', title: `Offer ${RUN}` }),
    );
    expect(await network.matchBuyerRequest(offer.post.id)).toEqual({ agencies: 0, notified: 0, truncated: false });
    const { post } = await as(p, (ctx) => network.createPost(ctx, buyerRequest({ title: `Closed ${RUN}` })));
    await as(p, (ctx) => network.closePost(ctx, post.id));
    expect(await network.matchBuyerRequest(post.id)).toEqual({ agencies: 0, notified: 0, truncated: false });
    expect((await network.notifySubscribers(post.id)).notified).toBe(0);
  });
});

describe('the board', () => {
  it('[S11-05] verified agencies read open posts; closed, expired and unverified readers see nothing', async () => {
    const { post } = await as(p, (ctx) => network.createPost(ctx, buyerRequest({ title: `Board ${RUN}` })));
    const board = await as(s, (ctx) => network.listPosts(ctx, { limit: 100 }));
    const seen = board.items.find((i) => i.id === post.id);
    expect(seen).toMatchObject({ own: false, status: 'OPEN', expired: false, agency: { id: p.agencyId } });
    // white label: the post names its agency, never its author
    expect(JSON.stringify(seen)).not.toContain(p.userId);
    expect(
      (await as(s, (ctx) => network.listPosts(ctx, { limit: 100, kind: 'DEVELOPER_ANNOUNCEMENT' }))).items.map(
        (i) => i.id,
      ),
    ).not.toContain(post.id);
    // the author's side is the poster's own (STRICT), and an unverified agency reads no post
    expect((await asUser(s, sql`select post_id from network_post_authors where post_id = ${post.id}`)).length).toBe(0);
    expect(await refusal(as(u, (ctx) => network.getPost(ctx, post.id)))).toBe('NETWORK_POST_NOT_FOUND');
    expect(await refusal(as(u, (ctx) => network.createPost(ctx, buyerRequest())))).toBe('VERIFICATION_REQUIRED');

    // only its author or an admin closes it; others cannot write it at all
    expect(await refusal(as(p2, (ctx) => network.closePost(ctx, post.id)))).toBe('FORBIDDEN');
    expect(
      await sqlState(asUser(s, sql`update network_posts set title = 'hijacked' where id = ${post.id} returning id`)),
    ).toBe('42501');
    expect((await as(s, (ctx) => network.getPost(ctx, post.id))).title).toBe(`Board ${RUN}`);
    // what was published never changes, not even by its own agency (column grants), and nobody deletes a post
    expect(await sqlState(asUser(p, sql`update network_posts set title = 'edited' where id = ${post.id}`))).toBe(
      '42501',
    );
    expect(
      await sqlState(
        asUser(p, sql`update network_posts set expires_at = now() + interval '9 years' where id = ${post.id}`),
      ),
    ).toBe('42501');
    expect(await sqlState(asUser(p, sql`delete from network_posts where id = ${post.id}`))).toBe('42501');
    const closed = await as(p, (ctx) => network.closePost(ctx, post.id));
    expect(closed.status).toBe('CLOSED');
    // a closed post is not reopened (`network_posts_guard`)
    expect(
      await sqlState(asUser(p, sql`update network_posts set status = 'OPEN', closed_at = null where id = ${post.id}`)),
    ).toBe('42501');
    expect(await refusal(as(s, (ctx) => network.getPost(ctx, post.id)))).toBe('NETWORK_POST_NOT_FOUND');
    // the poster still sees it among its own
    const own = await as(p, (ctx) => network.listPosts(ctx, { limit: 100, mine: true }));
    expect(own.items.find((i) => i.id === post.id)?.status).toBe('CLOSED');

    // expired: off the board for others
    const old = await as(p, (ctx) => network.createPost(ctx, buyerRequest({ title: `Old ${RUN}` })));
    await system((tx) =>
      tx.execute(sql`update network_posts set created_at = now() - interval '40 days',
        expires_at = now() - interval '1 day' where id = ${old.post.id}`),
    );
    expect(await refusal(as(s, (ctx) => network.getPost(ctx, old.post.id)))).toBe('NETWORK_POST_NOT_FOUND');
    expect((await as(p, (ctx) => network.getPost(ctx, old.post.id))).expired).toBe(true);
  });

  it('[S11-05] posts carry no contact details; an Idempotency-Key replays the first post', async () => {
    expect(
      await refusal(as(p, (ctx) => network.createPost(ctx, buyerRequest({ body: 'Call me on +34 600 123 456' })))),
    ).toBe('ZOD');
    expect(
      await refusal(as(p, (ctx) => network.createPost(ctx, buyerRequest({ body: 'Write to ana@agency.example' })))),
    ).toBe('ZOD');
    const key = `nb-key-${RUN}-0123456789`;
    const first = await as(p, (ctx) => network.createPost(ctx, buyerRequest(), { idempotencyKey: key }));
    const again = await as(p, (ctx) => network.createPost(ctx, buyerRequest(), { idempotencyKey: key }));
    expect(again).toMatchObject({ replayed: true, post: { id: first.post.id } });
    expect(
      await refusal(
        as(p, (ctx) => network.createPost(ctx, buyerRequest({ title: 'Another' }), { idempotencyKey: key })),
      ),
    ).toBe('IDEMPOTENCY_KEY_REUSED');
    // an unknown location is refused
    expect(
      await refusal(as(p, (ctx) => network.createPost(ctx, buyerRequest({ criteria: { locationIds: [newId()] } })))),
    ).toBe('VALIDATION_FAILED');
  });
});

describe('expiry', () => {
  it('[S11-05] the sweep closes open posts past their expiry, and only those', async () => {
    const old = await as(p, (ctx) => network.createPost(ctx, buyerRequest({ title: `Expired ${RUN}` })));
    const fresh = await as(p, (ctx) => network.createPost(ctx, buyerRequest({ title: `Fresh ${RUN}` })));
    await system((tx) =>
      tx.execute(sql`update network_posts set created_at = now() - interval '40 days',
        expires_at = now() - interval '1 minute' where id = ${old.post.id}`),
    );
    await network.closeExpiredPosts();
    const states = await rows<{ id: string; status: string; closed: boolean }>(sql`
      select id, status, closed_at is not null as closed from network_posts where id in (${old.post.id}, ${fresh.post.id})`);
    expect(Object.fromEntries(states.map((r) => [r.id, r.status]))).toEqual({
      [old.post.id]: 'CLOSED',
      [fresh.post.id]: 'OPEN',
    });
    expect((await network.closeExpiredPosts()).closed).toBeGreaterThanOrEqual(0);
  });
});

describe('replies', () => {
  it('[S11-05] a reply opens a NETWORK chat thread with the poster, whose author reads it', async () => {
    const { post } = await as(p, (ctx) => network.createPost(ctx, buyerRequest({ title: `Reply ${RUN}` })));
    const reply = await as(s, (ctx) => network.replyToPost(ctx, post.id, { body: 'We have two villas for you.' }));
    expect(reply.thread).toMatchObject({
      kind: 'NETWORK',
      networkPostId: post.id,
      subject: `Reply ${RUN}`,
      peerAgency: { id: p.agencyId },
    });
    // the poster's copy, its author seated, the message there
    const posterView = await as(p, (ctx) => chat.listThreads(ctx, { limit: 100 }));
    const t = posterView.items.find((i) => i.id === reply.thread.id);
    expect(t).toMatchObject({ kind: 'NETWORK', networkPostId: post.id, unread: true, peerAgency: { id: s.agencyId } });
    const msgs = await as(p, (ctx) => chat.listMessages(ctx, reply.thread.id, { limit: 25 }));
    expect(msgs.items.map((x) => x.body)).toEqual(['We have two villas for you.']);
    // the poster answers in the same thread
    await as(p, (ctx) => chat.sendMessage(ctx, reply.thread.id, { body: 'Send them over.' }));
    expect((await as(s, (ctx) => chat.listMessages(ctx, reply.thread.id, { limit: 25 }))).items).toHaveLength(2);

    // a colleague's reply joins the agency's thread; one thread per post and agency
    const again = await as(s2, (ctx) => network.replyToPost(ctx, post.id, { body: 'And a third one.' }));
    expect(again.thread.id).toBe(reply.thread.id);
    // nobody replies to their own post, nor to a closed one
    expect(await refusal(as(p2, (ctx) => network.replyToPost(ctx, post.id, { body: 'Me?' })))).toBe(
      'VALIDATION_FAILED',
    );
    await as(p, (ctx) => network.closePost(ctx, post.id));
    expect(await refusal(as(m, (ctx) => network.replyToPost(ctx, post.id, { body: 'Late' })))).toBe(
      'NETWORK_POST_NOT_FOUND',
    );
    // S12-F12: the post closed, so its threads take no more messages
    expect(await refusal(as(s, (ctx) => chat.sendMessage(ctx, reply.thread.id, { body: 'Still interested?' })))).toBe(
      'CHAT_THREAD_CLOSED',
    );
    // staff impersonating a member do not reply for them
    const other = await as(p, (ctx) => network.createPost(ctx, buyerRequest({ title: `Imp ${RUN}` })));
    expect(
      await refusal(
        as(n, async (ctx) => network.replyToPost(await impersonatedCtx(ctx, newId()), other.post.id, { body: 'x' })),
      ),
    ).toBe('FORBIDDEN');
  });

  it('[S11-05] a post whose author left seats the agency admins; an admin joins a reply thread, an agent does not', async () => {
    const author = await agent(p.agencyId, 'Lea');
    const pAgent = await agent(p.agencyId, 'Rui');
    const { post } = await as(author, (ctx) => network.createPost(ctx, buyerRequest({ title: `Left ${RUN}` })));
    await system((tx) =>
      tx.execute(sql`update agency_members set deactivated_at = now()
        where agency_id = ${p.agencyId} and user_id = ${author.userId}`),
    );
    const reply = await as(s, (ctx) => network.replyToPost(ctx, post.id, { body: 'Is it still open?' }));
    const seated = await rows<{ user_id: string }>(sql`
      select user_id from chat_participants where agency_id = ${p.agencyId} and thread_id = ${reply.thread.id}`);
    expect(seated.map((r) => r.user_id)).toEqual([p.userId]);

    // with the author seated, an admin joins on their own; an agent does not
    const live = await as(pAgent, (ctx) => network.createPost(ctx, buyerRequest({ title: `Join ${RUN}` })));
    const r2 = await as(s, (ctx) => network.replyToPost(ctx, live.post.id, { body: 'Hello' }));
    expect(await refusal(as(p, (ctx) => chat.getThread(ctx, r2.thread.id)))).toBe('CHAT_THREAD_NOT_FOUND');
    const joined = await as(p, (ctx) => network.joinReplyThread(ctx, r2.thread.id));
    expect(joined.participants.map((x) => x.userId).sort()).toEqual([p.userId, pAgent.userId].sort());
    expect(await refusal(as(p2, (ctx) => network.joinReplyThread(ctx, r2.thread.id)))).toBe('FORBIDDEN');
    // never a thread of another kind
    const direct = await as(p, (ctx) => chat.createDirectThread(ctx, { userIds: [p2.userId] }));
    expect(await refusal(as(p, (ctx) => network.joinReplyThread(ctx, direct.id)))).toBe('CHAT_THREAD_NOT_FOUND');
  });

  it('[S11-05] the database refuses a NETWORK thread that is not a reply to an open post of its peer', async () => {
    const { post } = await as(p, (ctx) => network.createPost(ctx, buyerRequest({ title: `Forge ${RUN}` })));
    const forge = (agencyId: string, peer: string, postId: string, who: Founder) =>
      asUser(
        who,
        sql`insert into chat_threads (agency_id, id, kind, peer_agency_id, network_post_id)
          values (${agencyId}, ${newId()}, 'NETWORK', ${peer}, ${postId})`,
      );
    // the post is p's, not n's
    expect(await sqlState(forge(s.agencyId, n.agencyId, post.id, s))).toBe('42501');
    // no such post
    expect(await sqlState(forge(s.agencyId, p.agencyId, newId(), s))).toBe('42501');
    // a real reply's thread passes (the control)
    expect(await sqlState(forge(s.agencyId, p.agencyId, post.id, s))).toBe(undefined);
  });
});

describe('audit (S12-F13)', () => {
  const auditOf = (postId: string) =>
    rows<{
      agency_id: string;
      type: string;
      actor_user_id: string | null;
      target_type: string;
      metadata: Record<string, unknown>;
    }>(sql`
      select agency_id, type, actor_user_id, target_type, metadata from audit_logs
      where target_id = ${postId} and type like 'network.post.%' order by occurred_at, id`);

  it('[S12-F13] publishing a post is audited with its id and kind, never its title or body', async () => {
    const key = `nb-audit-${RUN}-0123456789`;
    const { post } = await as(p, (ctx) =>
      network.createPost(ctx, buyerRequest({ title: `Audited ${RUN}` }), { idempotencyKey: key }),
    );
    // a replay is the same post: not published twice
    await as(p, (ctx) => network.createPost(ctx, buyerRequest({ title: `Audited ${RUN}` }), { idempotencyKey: key }));
    const log = await auditOf(post.id);
    expect(log).toEqual([
      {
        agency_id: p.agencyId,
        type: 'network.post.published',
        actor_user_id: p.userId,
        target_type: 'networkPost',
        metadata: { kind: 'BUYER_REQUEST' },
      },
    ]);
    expect(JSON.stringify(log)).not.toContain(`Audited ${RUN}`);
    expect(JSON.stringify(log)).not.toContain('Family relocating');
  });

  it('[S12-F13] closing a post is audited once; closing it again writes nothing', async () => {
    const { post } = await as(p, (ctx) => network.createPost(ctx, buyerRequest({ title: `Close audit ${RUN}` })));
    await as(p, (ctx) => network.closePost(ctx, post.id));
    await as(p, (ctx) => network.closePost(ctx, post.id));
    const log = await auditOf(post.id);
    expect(log.map((r) => r.type)).toEqual(['network.post.published', 'network.post.closed']);
    expect(log[1]).toMatchObject({
      agency_id: p.agencyId,
      actor_user_id: p.userId,
      metadata: { kind: 'BUYER_REQUEST' },
    });
    expect(JSON.stringify(log)).not.toContain(`Close audit ${RUN}`);
  });

  it('[S12-F13] staff impersonating a member neither publish nor close, and nothing is audited', async () => {
    const before = await rows<{ n: number }>(sql`
      select count(*)::int as n from audit_logs where agency_id = ${p.agencyId} and type like 'network.post.%'`);
    expect(
      await refusal(
        as(p, async (ctx) => network.createPost(await impersonatedCtx(ctx, newId()), buyerRequest({ title: 'Imp' }))),
      ),
    ).toBe('FORBIDDEN');
    const { post } = await as(p, (ctx) => network.createPost(ctx, buyerRequest({ title: `Imp close ${RUN}` })));
    expect(await refusal(as(p, async (ctx) => network.closePost(await impersonatedCtx(ctx, newId()), post.id)))).toBe(
      'FORBIDDEN',
    );
    expect((await as(p, (ctx) => network.getPost(ctx, post.id))).status).toBe('OPEN');
    const after = await rows<{ n: number }>(sql`
      select count(*)::int as n from audit_logs where agency_id = ${p.agencyId} and type like 'network.post.%'`);
    // only the member's own publish of the control post
    expect((after[0]?.n ?? 0) - (before[0]?.n ?? 0)).toBe(1);
    expect((await auditOf(post.id)).map((r) => r.type)).toEqual(['network.post.published']);
  });
});

describe('reply threads close with their post or an unlisted agency (S12-F12)', () => {
  const rawSend = (f: Founder, threadId: string) =>
    asUser(
      f,
      sql`insert into chat_messages (agency_id, id, thread_id, sender_agency_id, sender_user_id, sender_name, body)
        values (${f.agencyId}, ${newId()}, ${threadId}, ${f.agencyId}, ${f.userId}, 'x', 'raw')`,
    );
  const copies = (threadId: string) =>
    rows<{ agency_id: string; closed: boolean }>(sql`
      select agency_id, closed_at is not null as closed from chat_threads where id = ${threadId} order by agency_id`);

  it('[S12-F12] a closed post refuses messages in its threads (42501), and the close job makes both copies read-only', async () => {
    const { post } = await as(p, (ctx) => network.createPost(ctx, buyerRequest({ title: `Thread close ${RUN}` })));
    const a = await as(s, (ctx) => network.replyToPost(ctx, post.id, { body: 'Two villas.' }));
    const b = await as(n, (ctx) => network.replyToPost(ctx, post.id, { body: 'One villa.' }));
    // open: both sides write (the control)
    expect(await sqlState(rawSend(p, a.thread.id))).toBe(undefined);
    expect(await sqlState(rawSend(s, a.thread.id))).toBe(undefined);

    await as(p, (ctx) => network.closePost(ctx, post.id));
    const [event] = await rows<{ agency_id: string; payload: { postId: string; agencyId: string } }>(sql`
      select agency_id, payload from outbox_events where type = 'network.post.closed' and payload ->> 'postId' = ${post.id}`);
    expect(event).toMatchObject({ agency_id: p.agencyId, payload: { postId: post.id, agencyId: p.agencyId } });
    // before the job ran: the database refuses either side, the service answers CHAT_THREAD_CLOSED
    expect(await sqlState(rawSend(s, a.thread.id))).toBe('42501');
    expect(await sqlState(rawSend(p, b.thread.id))).toBe('42501');
    expect(await refusal(as(p, (ctx) => chat.sendMessage(ctx, a.thread.id, { body: 'Hello?' })))).toBe(
      'CHAT_THREAD_CLOSED',
    );

    // the job closes both copies of both threads, once
    expect(await network.closePostThreads({ agencyId: p.agencyId, postId: post.id })).toEqual({ closed: 4 });
    expect(await network.closePostThreads({ agencyId: p.agencyId, postId: post.id })).toEqual({ closed: 0 });
    for (const t of [a.thread.id, b.thread.id]) expect((await copies(t)).every((c) => c.closed)).toBe(true);
    expect((await copies(a.thread.id)).length).toBe(2);
    expect((await as(s, (ctx) => chat.getThread(ctx, a.thread.id))).closed).toBe(true);
    // an open post's threads, or an event naming another agency, close nothing (the job re-reads the post)
    const other = await as(p, (ctx) => network.createPost(ctx, buyerRequest({ title: `Other ${RUN}` })));
    const c = await as(s, (ctx) => network.replyToPost(ctx, other.post.id, { body: 'Hi.' }));
    expect(await network.closePostThreads({ agencyId: p.agencyId, postId: other.post.id })).toEqual({ closed: 0 });
    await as(p, (ctx) => network.closePost(ctx, other.post.id));
    expect(await network.closePostThreads({ agencyId: s.agencyId, postId: other.post.id })).toEqual({ closed: 0 });
    expect((await copies(c.thread.id)).some((x) => x.closed)).toBe(false);
  });

  it('[S12-F12] the expiry sweep emits network.post.closed for each post it closes', async () => {
    const old = await as(p, (ctx) => network.createPost(ctx, buyerRequest({ title: `Sweep close ${RUN}` })));
    const r = await as(s, (ctx) => network.replyToPost(ctx, old.post.id, { body: 'Still open?' }));
    await system((tx) =>
      tx.execute(sql`update network_posts set created_at = now() - interval '40 days',
        expires_at = now() - interval '1 minute' where id = ${old.post.id}`),
    );
    // expired, not yet swept: already refused
    expect(await sqlState(rawSend(s, r.thread.id))).toBe('42501');
    await network.closeExpiredPosts();
    const events = await rows<{ agency_id: string }>(sql`
      select agency_id from outbox_events where type = 'network.post.closed' and payload ->> 'postId' = ${old.post.id}`);
    expect(events).toEqual([{ agency_id: p.agencyId }]);
  });

  it('[S12-F12] a NETWORK thread refuses messages (42501) once either agency is no longer listed', async () => {
    const [q, r] = await Promise.all([createFounder(), createFounder()]);
    await Promise.all([setAgencyStatus(q.agencyId, 'VERIFIED'), setAgencyStatus(r.agencyId, 'VERIFIED')]);
    const { post } = await as(q, (ctx) => network.createPost(ctx, buyerRequest({ title: `Unlisted ${RUN}` })));
    const { thread } = await as(r, (ctx) => network.replyToPost(ctx, post.id, { body: 'Interested.' }));
    expect(await sqlState(rawSend(q, thread.id))).toBe(undefined);

    // the replier is no longer listed: neither side writes
    await setAgencyStatus(r.agencyId, 'PENDING');
    expect(await sqlState(rawSend(r, thread.id))).toBe('42501');
    expect(await sqlState(rawSend(q, thread.id))).toBe('42501');
    expect(await refusal(as(q, (ctx) => chat.sendMessage(ctx, thread.id, { body: 'Hello?' })))).toBe(
      'CHAT_THREAD_CLOSED',
    );
    // listed again: the thread works again
    await setAgencyStatus(r.agencyId, 'VERIFIED');
    expect(await sqlState(rawSend(r, thread.id))).toBe(undefined);
    // the poster is no longer listed
    await setAgencyStatus(q.agencyId, 'PENDING');
    expect(await sqlState(rawSend(r, thread.id))).toBe('42501');
    expect(await sqlState(rawSend(q, thread.id))).toBe('42501');
    // other threads are untouched: a DIRECT thread of the unlisted agency still takes messages
    const colleague = await agent(q.agencyId, 'Quinn');
    const direct = await as(q, (ctx) => chat.createDirectThread(ctx, { userIds: [colleague.userId] }));
    expect(await sqlState(rawSend(q, direct.id))).toBe(undefined);
  });
});
