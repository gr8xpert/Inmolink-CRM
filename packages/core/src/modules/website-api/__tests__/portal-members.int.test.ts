import { CreateListingBody, MEMBER_PHOTO_MAX_BYTES, PortalQuery, UpdateListingBody } from '@inmolink/contracts';
import { closeDb, countQueries, withSystem } from '@inmolink/db';
import { adminQuery, setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { closeCache, configureCache } from '@inmolink/platform/cache';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { defaultSubscribers } from '@inmolink/platform/outbox';
import { configureSearch, createMeiliEngine } from '@inmolink/platform/search';
import { configureStorage, createMemoryStore, storage } from '@inmolink/platform/storage';
import { sql } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx, CtxRunner } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder, impersonatedCtx } from '../../../testing/factories';
import * as agencies from '../../agencies';
import * as identity from '../../identity';
import * as media from '../../media';
import * as properties from '../../properties';
import * as search from '../../search';
import * as taxonomy from '../../taxonomy';
import * as websiteApi from '../index';

/**
 * Portal member profiles and agency logos (S15-F10): a member's opt-in published profile (name, photo, languages, the
 * phone / e-mail they publish) has a portal page linked from their agency's profile — only while published, the member
 * active and the agency verified and listed; the logo's and photo's public copies (re-encoded, metadata stripped) are
 * made by the portal-images job and shown on cards and profiles — within the page budget.
 */

const RUN = newId().slice(-8).toLowerCase();
const slug = (s: string) => `${s}-pm-${RUN}`;

let a: Founder;
let pending: Founder;
let agent: { userId: string; agencyId: string };
let quiet: { userId: string; agencyId: string };
let ids: { city: string; villa: string };
let listingId = '';

const as = <T>(
  m: { userId: string; agencyId: string },
  fn: (ctx: Ctx) => Promise<T>,
  over: { clientMode?: boolean; impersonatedBy?: string } = {},
) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, async (ctx) => {
    const base = over.impersonatedBy ? await impersonatedCtx(ctx, over.impersonatedBy) : ctx;
    return fn({ ...base, clientMode: over.clientMode ?? false });
  });
const runner =
  (m: { userId: string; agencyId: string }): CtxRunner =>
  (fn) =>
    as(m, fn);

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (isAppError(err)) return err.code;
    throw err;
  }
  return 'accepted';
}

/** An AGENT of the founder's agency. */
async function agentOf(f: Founder, name: string): Promise<{ userId: string; agencyId: string }> {
  const userId = newId();
  const email = `agent-${userId}@example.com`;
  await withSystem('portal-members.test: agent', async (tx) => {
    await tx.execute(sql`insert into users (id, email, password_hash, name, locale)
                         values (${userId}, ${email}, 'x', ${name}, 'en')`);
    await tx.execute(sql`insert into agency_members (user_id, agency_id, role, name, email)
                         values (${userId}, ${f.agencyId}, 'AGENT', ${name}, ${email})`);
  });
  return { userId, agencyId: f.agencyId };
}

const PROFILE = {
  published: true,
  displayName: `Marta Ruiz ${RUN}`,
  languages: ['es', 'en', 'de'],
  phone: '+34 611 222 333',
  email: 'marta@profile.example',
};

/** A photo with EXIF (the public copy must carry none). */
const photoBytes = async () =>
  new Uint8Array(
    await sharp({ create: { width: 900, height: 600, channels: 3, background: '#2a6f97' } })
      .jpeg()
      .withMetadata({ exif: { IFD0: { Copyright: 'secret-exif' } } })
      .toBuffer(),
  );
const logoBytes = async () =>
  new Uint8Array(
    await sharp({ create: { width: 800, height: 200, channels: 4, background: { r: 0, g: 80, b: 120, alpha: 1 } } })
      .png()
      .toBuffer(),
  );

const publicKeys = (agencyId: string) =>
  withSystem('portal-members.test: keys', async (tx) => ({
    logo:
      (
        await tx.execute<{ k: string | null }>(
          sql`select logo_public_key as k from agency_profiles where agency_id = ${agencyId}`,
        )
      ).rows[0]?.k ?? null,
    photos: (
      await tx.execute<{ user_id: string; k: string | null }>(
        sql`select user_id, photo_public_key as k from member_public_profiles where agency_id = ${agencyId}`,
      )
    ).rows,
  }));

beforeAll(async () => {
  await setupTestDb('worker');
  await configureCache({ prefix: `t:portal-members:${RUN}` });
  configureStorage(createMemoryStore());
  taxonomy.dropLocalTaxonomyCopies();
  websiteApi.resetPortalCaches();
  websiteApi.configureWebsiteApi({
    mediaBaseUrl: 'https://media.example',
    cursorKey: 'test-cursor-key-0123456789abcdef0123',
  });
  configureSearch(createMeiliEngine({ url: 'http://127.0.0.1:9', apiKey: 'x', timeoutMs: 200 }));
  search.resetSearchBreaker();
  a = await createFounder({ companyName: `Team Homes ${RUN}` });
  pending = await createFounder({ companyName: `Pending Team ${RUN}` });
  await setAgencyStatus(a.agencyId, 'VERIFIED');
  agent = await agentOf(a, 'Marta');
  quiet = await agentOf(a, 'Quiet Agent');
  ids = await withSystem('portal-members.test', async (tx) => {
    const name = (n: string, s: string) => [
      { locale: 'en', name: `${n} ${RUN}`, slug: slug(s) },
      { locale: 'es', name: `${n} ${RUN}`, slug: slug(`${s}-es`) },
    ];
    const country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: slug('c'),
      translations: name('Teamland', 'teamland'),
    });
    const region = await taxonomy.createLocation(tx, {
      level: 'REGION',
      parentId: country,
      code: slug('r'),
      translations: name('Costa', 'costa'),
    });
    const city = await taxonomy.createLocation(tx, {
      level: 'CITY',
      parentId: region,
      code: slug('ci'),
      translations: name('Puerto', 'puerto'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: slug('houses'),
      sort: 0,
      translations: name('Houses', 'houses'),
    });
    const villa = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: slug('villa'),
      sort: 0,
      translations: name('Villa', 'villa'),
    });
    return { city, villa };
  });
  const { id } = await as(a, (ctx) =>
    properties.createListing(
      ctx,
      CreateListingBody.parse({
        propertyTypeId: ids.villa,
        locationId: ids.city,
        priceCents: 41_000_000,
        bedrooms: 3,
        energyRating: 'B',
      }),
    ),
  );
  await as(a, async (ctx) =>
    properties.saveListingTranslation(ctx, id, 'en', {
      version: (await properties.getListing(ctx, id)).version,
      title: `Team home ${RUN}`,
      description: 'A bright home near the sea.',
    }),
  );
  await as(a, async (ctx) =>
    properties.updateListing(
      ctx,
      id,
      UpdateListingBody.parse({
        status: 'ACTIVE',
        visibility: 'PUBLIC',
        shareScope: 'ALL',
        version: (await properties.getListing(ctx, id)).version,
      }),
    ),
  );
  listingId = id;
  await withSystem('portal-members.test', (tx) => search.rebuildReadModels(tx, 'LISTING', [listingId]));
  websiteApi.resetPortalCaches();
}, 180_000);

afterAll(async () => {
  await closeCache();
  await closeDb();
});

describe('portal member profiles (S15-F10)', () => {
  it('[S15-F10] a member who publishes a profile has a portal page linked from the agency profile; one who has not has none', async () => {
    const before = await as(agent, (ctx) => identity.getMyPublicProfile(ctx));
    // Opt-in: nothing exists or shows until the member saves it; the default name is their team name.
    expect(before).toMatchObject({ id: null, published: false, displayName: 'Marta', version: 0 });
    const saved = await as(agent, (ctx) => identity.updateMyPublicProfile(ctx, { version: 0, ...PROFILE }));
    expect(saved).toMatchObject({ published: true, displayName: PROFILE.displayName, version: 1 });
    // A colleague who saved but did not publish has no page, and nobody else is listed.
    const draft = await as(quiet, (ctx) =>
      identity.updateMyPublicProfile(ctx, { ...PROFILE, version: 0, published: false, displayName: 'Quiet One' }),
    );
    websiteApi.resetPortalCaches();

    const profile = await websiteApi.portalAgency('en', a.agencyId);
    expect(profile?.members).toEqual([
      {
        id: saved.id,
        name: PROFILE.displayName,
        photoUrl: null,
        paths: websiteApi.portalMemberPaths({ id: saved.id as string, name: PROFILE.displayName }),
      },
    ]);
    expect(profile?.members[0]?.paths.en).toMatch(new RegExp(`^/en/agent/${saved.id}/marta-ruiz-`));

    const page = await websiteApi.portalMember(saved.id as string);
    expect(page).toMatchObject({
      id: saved.id,
      name: PROFILE.displayName,
      languages: ['es', 'en', 'de'],
      phone: PROFILE.phone,
      email: PROFILE.email,
      agency: { id: a.agencyId, name: expect.stringContaining('Team Homes') },
    });
    expect(page?.agency.paths.en).toBe(profile?.paths.en);
    // Only what the member published: never the user id, the login e-mail or the role.
    const text = JSON.stringify(page);
    expect(text).not.toContain(agent.userId);
    expect(text).not.toContain(`agent-${agent.userId}@example.com`);
    expect(text).not.toContain('AGENT');

    expect(await websiteApi.portalMember(draft.id as string)).toBeNull();
    expect(await websiteApi.portalMember(newId())).toBeNull();
    // A legacy numeric `/agent/<id>` never reads (its 301 to the agency's profile is the legacy redirects').
    expect(await websiteApi.portalMember('42')).toBeNull();
  });

  it('[S15-F10] nothing unpublished: unpublishing, deactivation and an agency off the directory take the page down', async () => {
    const mine = await as(agent, (ctx) => identity.getMyPublicProfile(ctx));
    const id = mine.id as string;
    await as(agent, (ctx) =>
      identity.updateMyPublicProfile(ctx, { ...PROFILE, version: mine.version, published: false }),
    );
    websiteApi.resetPortalCaches();
    expect(await websiteApi.portalMember(id)).toBeNull();
    expect((await websiteApi.portalAgency('en', a.agencyId))?.members).toEqual([]);

    const again = await as(agent, (ctx) =>
      identity.updateMyPublicProfile(ctx, { ...PROFILE, version: mine.version + 1 }),
    );
    websiteApi.resetPortalCaches();
    expect(await websiteApi.portalMember(id)).not.toBeNull();

    // The agency is suspended (off the directory): no page, no team.
    await setAgencyStatus(a.agencyId, 'SUSPENDED');
    websiteApi.resetPortalCaches();
    expect(await websiteApi.portalMember(id)).toBeNull();
    expect(await websiteApi.portalAgency('en', a.agencyId)).toBeNull();
    await setAgencyStatus(a.agencyId, 'VERIFIED');
    websiteApi.resetPortalCaches();
    expect(await websiteApi.portalMember(id)).not.toBeNull();

    // A member of an agency never verified: saved and published, still no page.
    const p = await as(pending, (ctx) =>
      identity.updateMyPublicProfile(ctx, { ...PROFILE, version: 0, displayName: 'Pending Person' }),
    );
    expect(p.published).toBe(true);
    expect(await websiteApi.portalMember(p.id as string)).toBeNull();

    // Deactivation takes the page down (the lookups check the membership) and the photo copy with it.
    const temp = await agentOf(a, 'Leaving Agent');
    const leaving = await as(temp, (ctx) =>
      identity.updateMyPublicProfile(ctx, { ...PROFILE, version: 0, displayName: 'Leaving Agent' }),
    );
    await identity.uploadMyPublicProfilePhoto(runner(temp), { body: await photoBytes() });
    expect((await media.publishPortalImages(a.agencyId)).photos.published).toBe(1);
    websiteApi.resetPortalCaches();
    expect((await websiteApi.portalMember(leaving.id as string))?.photoUrl).toMatch(/^https:\/\/media\.example\//);
    await as(a, (ctx) => identity.deactivateMember(ctx, { userId: temp.userId }));
    websiteApi.resetPortalCaches();
    expect(await websiteApi.portalMember(leaving.id as string)).toBeNull();
    expect((await media.publishPortalImages(a.agencyId)).photos.removed).toBe(1);
    const keys = await publicKeys(a.agencyId);
    expect(keys.photos.find((p) => p.user_id === temp.userId)?.k).toBeNull();
    expect(again.version).toBeGreaterThan(mine.version);
  });

  it('[S15-F10] each member changes only their own profile: never a colleague’s, in Client Mode or while staff act as them', async () => {
    // RLS (`userSelect` + `write`): a session of one member cannot write another's row even with a raw statement.
    const raw = await as(quiet, (ctx) =>
      ctx.tx.execute(sql`update member_public_profiles set display_name = 'Hijacked'
                          where agency_id = ${a.agencyId} and user_id = ${agent.userId}`),
    );
    expect(raw.rowCount).toBe(0);
    const current = await as(agent, (ctx) => identity.getMyPublicProfile(ctx));
    expect(current.displayName).toBe(PROFILE.displayName);
    expect(
      await refusal(
        as(agent, (ctx) => identity.updateMyPublicProfile(ctx, { ...PROFILE, version: current.version }), {
          clientMode: true,
        }),
      ),
    ).toBe('FORBIDDEN');
    // Optimistic: a stale version is a conflict; languages are content locales only.
    expect(
      await refusal(
        as(agent, (ctx) => identity.updateMyPublicProfile(ctx, { ...PROFILE, version: 1, displayName: 'X Y' })),
      ),
    ).toBe('VERSION_CONFLICT');
    expect(
      await refusal(
        as(agent, (ctx) =>
          identity.updateMyPublicProfile(ctx, { ...PROFILE, version: current.version, languages: ['xx'] }),
        ),
      ),
    ).toBe('VALIDATION_FAILED');
  });

  it('[S15-F10] the agency logo and the member photo get public copies on publish, shown on cards and profiles', async () => {
    await agencies.uploadAgencyLogo(runner(a), { body: await logoBytes() });
    await identity.uploadMyPublicProfilePhoto(runner(agent), { body: await photoBytes() });
    // Not public until the portal-images job made the copies.
    expect((await publicKeys(a.agencyId)).logo).toBeNull();
    const run = await media.publishPortalImages(a.agencyId);
    expect(run.logo).toBe('published');
    expect(run.photos.published).toBe(1);
    const keys = await publicKeys(a.agencyId);
    expect(keys.logo).toMatch(new RegExp(`^portal/agency-logos/${a.agencyId}/[0-9a-f-]+\\.webp$`));
    const photoKey = keys.photos.find((p) => p.user_id === agent.userId)?.k as string;
    expect(photoKey).toMatch(new RegExp(`^portal/member-photos/${a.agencyId}/[0-9a-f-]+\\.webp$`));
    // Re-encoded WebP: within its box, no metadata (the EXIF of the upload is gone).
    const logo = await storage().get('media', keys.logo as string, { maxBytes: 5_000_000 });
    const photo = await storage().get('media', photoKey, { maxBytes: 5_000_000 });
    const logoMeta = await sharp(logo as Uint8Array).metadata();
    const photoMeta = await sharp(photo as Uint8Array).metadata();
    expect([logoMeta.format, logoMeta.width, logoMeta.height]).toEqual(['webp', media.PORTAL_LOGO_PX, 100]);
    expect([photoMeta.format, photoMeta.width, photoMeta.height]).toEqual([
      'webp',
      media.PORTAL_PHOTO_PX,
      media.PORTAL_PHOTO_PX,
    ]);
    expect(photoMeta.exif).toBeUndefined();
    // Idempotent: a second run finds nothing to do.
    expect(await media.publishPortalImages(a.agencyId)).toMatchObject({
      logo: 'unchanged',
      photos: { published: 0, removed: 0, stale: 0 },
    });

    websiteApi.resetPortalCaches();
    const logoUrl = `https://media.example/${keys.logo}`;
    const profile = await websiteApi.portalAgency('en', a.agencyId);
    expect(profile?.logoUrl).toBe(logoUrl);
    expect(profile?.members[0]?.photoUrl).toBe(`https://media.example/${photoKey}`);
    const cards = await websiteApi.portalSearch({
      locale: 'en',
      agencyId: a.agencyId,
      query: PortalQuery.parse({}),
      requestId: newId(),
    });
    expect(cards.items.map((i) => i.agency?.logoUrl)).toContain(logoUrl);
    const page = await websiteApi.portalMember(profile?.members[0]?.id as string);
    expect(page).toMatchObject({ photoUrl: `https://media.example/${photoKey}`, agency: { logoUrl } });

    // Off the directory: the copies are cleared and deleted (nothing public of an unlisted agency).
    await setAgencyStatus(a.agencyId, 'SUSPENDED');
    expect(await media.publishPortalImages(a.agencyId)).toMatchObject({ logo: 'removed', photos: { removed: 1 } });
    expect(await publicKeys(a.agencyId)).toMatchObject({ logo: null });
    expect(await storage().head('media', keys.logo as string)).toBeNull();
    expect(await storage().head('media', photoKey)).toBeNull();
    await setAgencyStatus(a.agencyId, 'VERIFIED');
    expect((await media.publishPortalImages(a.agencyId)).logo).toBe('published');
    websiteApi.resetPortalCaches();
  });

  it('[S15-F10] budget: a profile page with its team ≤ 3 statements cold, a member page ≤ 2 cold, both 0 cached', async () => {
    websiteApi.resetPortalCaches();
    await websiteApi.portalSearch({ locale: 'en', query: PortalQuery.parse({}), requestId: newId() });
    const cold = await countQueries(async () => {
      await websiteApi.portalAgency('en', a.agencyId);
      await websiteApi.portalSearch({
        locale: 'en',
        agencyId: a.agencyId,
        query: PortalQuery.parse({}),
        requestId: newId(),
      });
    });
    expect(cold).toBeLessThanOrEqual(3);
    const id = (await websiteApi.portalAgency('en', a.agencyId))?.members[0]?.id as string;
    expect(await countQueries(() => websiteApi.portalAgency('en', a.agencyId))).toBe(0);
    websiteApi.resetPortalCaches();
    expect(await countQueries(() => websiteApi.portalMember(id))).toBeLessThanOrEqual(2);
    expect(await countQueries(() => websiteApi.portalMember(id))).toBe(0);
    const unknown = newId();
    expect(await countQueries(() => websiteApi.portalMember(unknown))).toBe(1);
    expect(await countQueries(() => websiteApi.portalMember(unknown))).toBe(0);
    expect(await countQueries(() => websiteApi.portalMember('42'))).toBe(0);
  });

  it('[S15-F10] the public lookups read only published rows through their definer functions (no Seq Scan)', async () => {
    // S15-F10 review: the functions' own bodies as the database holds them (what `pnpm db:rls` applied), not a copy —
    // the parameter bound to a value, then explained. The test tables are tiny, so sequential scans are disabled (as
    // in tests/isolation/preferred): a plan that still has one has no usable index for it.
    const plans = await withSystem('portal-members.test: explain', async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      const fns = await tx.execute<{ proname: string; prosrc: string }>(
        sql`select proname, prosrc from pg_proc
             where pronamespace = 'public'::regnamespace
               and proname in ('member_public_profile', 'agency_public_members') order by proname`,
      );
      expect(fns.rows.map((r) => r.proname)).toEqual(['agency_public_members', 'member_public_profile']);
      const out: string[] = [];
      for (const fn of fns.rows) {
        const body = fn.prosrc.replace(/\bm_id\b/g, `'${newId()}'::uuid`).replace(/\ba_id\b/g, `'${a.agencyId}'::uuid`);
        expect(body).not.toMatch(/\b[am]_id\b/);
        const plan = await tx.execute<{ 'QUERY PLAN': string }>(sql.raw(`explain (costs off) ${body}`));
        out.push(`${fn.proname}\n${plan.rows.map((x) => x['QUERY PLAN']).join('\n')}`);
      }
      return out;
    });
    for (const plan of plans) expect(plan).not.toMatch(/Seq Scan/);
    expect(plans[0]).toMatch(/member_public_profiles_agency_published_idx/);
    expect(plans[1]).toMatch(/member_public_profiles_id_uq/);
  });

  it('[S15-F10] staff acting as a member may look at the profile, never change it', async () => {
    const staffUserId = newId();
    const look = await as(agent, (ctx) => identity.getMyPublicProfile(ctx), { impersonatedBy: staffUserId });
    expect(look.displayName).toBe(PROFILE.displayName);
    expect(
      await refusal(
        as(agent, (ctx) => identity.updateMyPublicProfile(ctx, { ...PROFILE, version: look.version }), {
          impersonatedBy: staffUserId,
        }),
      ),
    ).toBe('FORBIDDEN');
  });
});

const privateKeyOf = async (m: { userId: string; agencyId: string }) =>
  (
    await withSystem('portal-members.test: key', (tx) =>
      tx.execute<{ k: string | null }>(
        sql`select photo_storage_key as k from member_public_profiles
             where agency_id = ${m.agencyId} and user_id = ${m.userId}`,
      ),
    )
  ).rows[0]?.k ?? null;

describe('portal member profiles — review fixes (S15-F10)', () => {
  it('[S15-F10] photo upload guards: empty, too large, wrong magic bytes, before the first save; a replaced upload is deleted', async () => {
    const upload = (m: { userId: string; agencyId: string }, body: Uint8Array) =>
      refusal(identity.uploadMyPublicProfilePhoto(runner(m), { body }));
    expect(await upload(agent, new Uint8Array(0))).toBe('VALIDATION_FAILED');
    const big = new Uint8Array(MEMBER_PHOTO_MAX_BYTES + 1);
    big.set([0xff, 0xd8, 0xff, 0xe0]);
    expect(await upload(agent, big)).toBe('PAYLOAD_TOO_LARGE');
    // A PDF (and plain text) sent as a photo: refused by its magic bytes.
    expect(await upload(agent, new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n'))).toBe(
      'UNSUPPORTED_MEDIA_TYPE',
    );
    expect(await upload(agent, new TextEncoder().encode('just text, not an image'))).toBe('UNSUPPORTED_MEDIA_TYPE');

    // Before the first save: refused, and nothing is stored for them.
    const stored = await storage().list('private', `member-photos/${a.agencyId}/`, { limit: 1000 });
    const fresh = await agentOf(a, 'Fresh Agent');
    expect(await upload(fresh, await photoBytes())).toBe('VALIDATION_FAILED');
    expect((await storage().list('private', `member-photos/${a.agencyId}/`, { limit: 1000 })).objects).toHaveLength(
      stored.objects.length,
    );
    const before = await privateKeyOf(agent);
    expect(stored.objects.map((o) => o.key)).toContain(before);

    // A replacement: the new upload is stored, the replaced private object is deleted.
    await identity.uploadMyPublicProfilePhoto(runner(agent), { body: await photoBytes() });
    const after = await privateKeyOf(agent);
    expect(after).not.toBe(before);
    expect(await storage().head('private', after as string)).not.toBeNull();
    expect(await storage().head('private', before as string)).toBeNull();
    const total = (await storage().list('private', `member-photos/${a.agencyId}/`, { limit: 1000 })).objects.length;
    expect(total).toBe(stored.objects.length);
  });

  it('[S15-F10] a user who is no longer ACTIVE loses the photo copy (the job’s live test matches the portal lookups)', async () => {
    const temp = await agentOf(a, 'Disabled Agent');
    const saved = await as(temp, (ctx) =>
      identity.updateMyPublicProfile(ctx, { ...PROFILE, version: 0, displayName: 'Disabled Agent' }),
    );
    await identity.uploadMyPublicProfilePhoto(runner(temp), { body: await photoBytes() });
    expect((await media.publishPortalImages(a.agencyId)).photos.published).toBeGreaterThanOrEqual(1);
    expect((await publicKeys(a.agencyId)).photos.find((p) => p.user_id === temp.userId)?.k).toBeTruthy();
    await adminQuery(`update users set status = 'DISABLED' where id = $1`, [temp.userId]);
    websiteApi.resetPortalCaches();
    expect(await websiteApi.portalMember(saved.id as string)).toBeNull();
    expect((await media.publishPortalImages(a.agencyId)).photos.removed).toBe(1);
    expect((await publicKeys(a.agencyId)).photos.find((p) => p.user_id === temp.userId)?.k).toBeNull();
  });

  it('[S15-F10] the job pages through profiles by user id (keyset), so no profile is left out', async () => {
    const all = await withSystem('portal-members.test: states', (tx) =>
      identity.memberPhotoStates(tx, a.agencyId, { after: null, limit: 500 }),
    );
    expect(all.length).toBeGreaterThanOrEqual(2);
    const paged: string[] = [];
    let after: string | null = null;
    for (;;) {
      const cursor: string | null = after;
      const page: identity.MemberPhotoState[] = await withSystem('portal-members.test: states', (tx) =>
        identity.memberPhotoStates(tx, a.agencyId, { after: cursor, limit: 1 }),
      );
      if (page.length === 0) break;
      expect(page).toHaveLength(1);
      paged.push(page[0]?.userId as string);
      after = page[0]?.userId ?? null;
    }
    expect(paged).toEqual(all.map((p) => p.userId));
  });

  it('[S15-F10] a public copy published or removed emits media.portalImages.changed (the agency’s portal pages are marked)', async () => {
    const count = () =>
      withSystem('portal-members.test: events', async (tx) =>
        Number(
          (
            await tx.execute<{ n: string }>(
              sql`select count(*) as n from outbox_events
                   where agency_id = ${a.agencyId} and type = 'media.portalImages.changed'`,
            )
          ).rows[0]?.n ?? 0,
        ),
      );
    await media.publishPortalImages(a.agencyId);
    const start = await count();
    await setAgencyStatus(a.agencyId, 'SUSPENDED');
    const removed = await media.publishPortalImages(a.agencyId);
    expect(removed.logo).toBe('removed');
    const afterRemove = await count();
    expect(afterRemove - start).toBe(1 + removed.photos.removed);
    await setAgencyStatus(a.agencyId, 'VERIFIED');
    const back = await media.publishPortalImages(a.agencyId);
    expect(back.logo).toBe('published');
    expect((await count()) - afterRemove).toBe(1 + back.photos.published);
    // Nothing to do: nothing emitted.
    const idle = await count();
    await media.publishPortalImages(a.agencyId);
    expect(await count()).toBe(idle);
    // The copies are written with a short cache lifetime, never immutable (a withdrawn photo must not stay cached).
    expect(media.PORTAL_IMAGE_CACHE).toBe('public, max-age=300');
  });

  it('[S15-F10] RLS: a member reads only their own profile row and cannot insert one carrying a public photo key', async () => {
    const seen = await as(quiet, (ctx) =>
      ctx.tx.execute<{ user_id: string }>(
        sql`select user_id from member_public_profiles where agency_id = ${a.agencyId}`,
      ),
    );
    expect(seen.rows.map((r) => r.user_id)).toEqual([quiet.userId]);
    const planter = await agentOf(a, 'Planting Agent');
    await expect(
      as(planter, (ctx) =>
        ctx.tx.execute(sql`insert into member_public_profiles (agency_id, user_id, id, display_name, photo_public_key)
                           values (${a.agencyId}, ${planter.userId}, ${newId()}, 'Planter',
                                   ${`portal/member-photos/${a.agencyId}/x.webp`})`),
      ),
    ).rejects.toThrow();
    // Without the key the same member's insert is accepted (their own row).
    const ok = await as(planter, (ctx) =>
      identity.updateMyPublicProfile(ctx, { ...PROFILE, version: 0, published: false, displayName: 'Planter' }),
    );
    expect(ok.version).toBe(1);
  });

  it('[S15-F10] agency erasure deletes the members’ profiles and both photo prefixes', async () => {
    const mine = await as(pending, (ctx) => identity.getMyPublicProfile(ctx));
    expect(mine.id).not.toBeNull();
    await identity.uploadMyPublicProfilePhoto(runner(pending), { body: await photoBytes() });
    const copy = `portal/member-photos/${pending.agencyId}/${newId()}.webp`;
    await storage().put('media', copy, new Uint8Array([1, 2, 3]), { contentType: 'image/webp' });
    const aBefore = (await publicKeys(a.agencyId)).photos.length;

    const r = await identity.eraseAgencyPublicProfiles({ agencyId: pending.agencyId });
    expect(r).toEqual({ profiles: 1, objects: 2, more: false });
    expect((await publicKeys(pending.agencyId)).photos).toEqual([]);
    expect((await storage().list('private', `member-photos/${pending.agencyId}/`, { limit: 10 })).objects).toEqual([]);
    expect((await storage().list('media', `portal/member-photos/${pending.agencyId}/`, { limit: 10 })).objects).toEqual(
      [],
    );
    // Another agency's are untouched; a second call finds nothing.
    expect((await publicKeys(a.agencyId)).photos.length).toBe(aBefore);
    expect(await identity.eraseAgencyPublicProfiles({ agencyId: pending.agencyId })).toEqual({
      profiles: 0,
      objects: 0,
      more: false,
    });
  });
});

describe('portal member profiles — second review fixes (S15-F10)', () => {
  const profileOf = async (m: { userId: string; agencyId: string }) =>
    (
      await withSystem('portal-members.test: profile', (tx) =>
        tx.execute<{ published: boolean; k: string | null; s: string | null }>(
          sql`select published, photo_public_key as k, photo_storage_key as s from member_public_profiles
               where agency_id = ${m.agencyId} and user_id = ${m.userId}`,
        ),
      )
    ).rows[0];

  it('[S15-F10] a withdrawn copy whose delete fails stays on its row and the job throws; the retry deletes it', async () => {
    const temp = await agentOf(a, 'Flaky Agent');
    await as(temp, (ctx) =>
      identity.updateMyPublicProfile(ctx, { ...PROFILE, version: 0, displayName: 'Flaky Agent' }),
    );
    await identity.uploadMyPublicProfilePhoto(runner(temp), { body: await photoBytes() });
    await media.publishPortalImages(a.agencyId);
    const copy = (await profileOf(temp))?.k as string;
    expect(copy).toMatch(/^portal\/member-photos\//);
    const current = await as(temp, (ctx) => identity.getMyPublicProfile(ctx));
    await as(temp, (ctx) =>
      identity.updateMyPublicProfile(ctx, { ...PROFILE, version: current.version, published: false }),
    );

    const real = storage();
    configureStorage({
      ...real,
      delete: async (bucket, key) => {
        if (bucket === 'media') throw new Error('storage DELETE failed (503)');
        return real.delete(bucket, key);
      },
    });
    try {
      await expect(media.publishPortalImages(a.agencyId)).rejects.toThrow(/DELETE failed/);
    } finally {
      configureStorage(real);
    }
    // The row still names the copy (nothing forgets it), and the object is still there for the retry to delete.
    expect((await profileOf(temp))?.k).toBe(copy);
    expect(await storage().head('media', copy)).not.toBeNull();

    expect((await media.publishPortalImages(a.agencyId)).photos.removed).toBe(1);
    expect((await profileOf(temp))?.k).toBeNull();
    expect(await storage().head('media', copy)).toBeNull();
  });

  it('[S15-F10] a public key is recorded only while the profile is live and the agency listed (else false)', async () => {
    const temp = await agentOf(a, 'Racing Agent');
    await as(temp, (ctx) =>
      identity.updateMyPublicProfile(ctx, { ...PROFILE, version: 0, published: false, displayName: 'Racing Agent' }),
    );
    await identity.uploadMyPublicProfilePhoto(runner(temp), { body: await photoBytes() });
    const source = (await profileOf(temp))?.s as string;
    const key = media.portalImageKey('member-photos', a.agencyId, source);
    const setPhoto = (k: string | null) =>
      withSystem('portal-members.test: set photo', (tx) =>
        identity.setMemberPhotoPublicKey(tx, a.agencyId, temp.userId, source, k),
      );
    // Unpublished: the key is refused, clearing it is not.
    expect(await setPhoto(key)).toBe(false);
    expect(await setPhoto(null)).toBe(true);
    // Published but the user no longer ACTIVE: refused too.
    const current = await as(temp, (ctx) => identity.getMyPublicProfile(ctx));
    await as(temp, (ctx) =>
      identity.updateMyPublicProfile(ctx, { ...PROFILE, version: current.version, displayName: 'Racing Agent' }),
    );
    await adminQuery(`update users set status = 'DISABLED' where id = $1`, [temp.userId]);
    expect(await setPhoto(key)).toBe(false);
    await adminQuery(`update users set status = 'ACTIVE' where id = $1`, [temp.userId]);
    expect(await setPhoto(key)).toBe(true);
    expect(await setPhoto(null)).toBe(true);

    // The logo: refused while the agency is off the directory.
    const logo = await withSystem('portal-members.test: logo', (tx) => agencies.portalLogoState(tx, a.agencyId));
    expect(logo?.logoStorageKey).toBeTruthy();
    const logoKey = media.portalImageKey('agency-logos', a.agencyId, logo?.logoStorageKey as string);
    const setLogo = (k: string | null) =>
      withSystem('portal-members.test: set logo', (tx) =>
        agencies.setLogoPublicKey(tx, a.agencyId, logo?.logoStorageKey ?? null, k),
      );
    await setAgencyStatus(a.agencyId, 'SUSPENDED');
    try {
      expect(await setLogo(logoKey)).toBe(false);
    } finally {
      await setAgencyStatus(a.agencyId, 'VERIFIED');
    }
    expect(await setLogo(logo?.logoPublicKey ?? logoKey)).toBe(true);
    await media.publishPortalImages(a.agencyId);
  });

  it('[S15-F10] a deactivated member’s profile is unpublished: reactivation needs a fresh opt-in', async () => {
    const temp = await agentOf(a, 'Returning Agent');
    const saved = await as(temp, (ctx) =>
      identity.updateMyPublicProfile(ctx, { ...PROFILE, version: 0, displayName: 'Returning Agent' }),
    );
    await as(a, (ctx) => identity.deactivateMember(ctx, { userId: temp.userId }));
    expect(await identity.unpublishDeactivatedMember({ agencyId: a.agencyId, userId: temp.userId })).toBe(true);
    expect((await profileOf(temp))?.published).toBe(false);
    const events = await withSystem('portal-members.test: events', (tx) =>
      tx.execute<{ n: string }>(
        sql`select count(*) as n from outbox_events
             where agency_id = ${a.agencyId} and type = 'identity.publicProfile.updated'
               and payload->>'userId' = ${temp.userId}`,
      ),
    );
    expect(Number(events.rows[0]?.n)).toBe(2);
    // Idempotent (a redelivered event changes nothing); a member with no profile is a no-op.
    expect(await identity.unpublishDeactivatedMember({ agencyId: a.agencyId, userId: temp.userId })).toBe(false);
    expect(await identity.unpublishDeactivatedMember({ agencyId: a.agencyId, userId: newId() })).toBe(false);
    // Reactivated: still no page until they publish again.
    await adminQuery(`update agency_members set deactivated_at = null where user_id = $1`, [temp.userId]);
    websiteApi.resetPortalCaches();
    expect(await websiteApi.portalMember(saved.id as string)).toBeNull();
  });

  it('[S15-F10] profile and deactivation events mark the agency’s portal pages and unpublish the profile', async () => {
    websiteApi.registerWebsiteApiSubscriptions();
    identity.registerIdentitySubscriptions();
    try {
      const names = (type: string) => defaultSubscribers.entries().find((e) => e.type === type)?.names ?? [];
      expect(names('identity.publicProfile.updated')).toContain('websiteApi.portal.memberProfile');
      expect(names('identity.member.deactivated')).toEqual(
        expect.arrayContaining(['websiteApi.portal.memberDeactivated', 'identity.publicProfile.memberDeactivated']),
      );
    } finally {
      websiteApi.unregisterWebsiteApiSubscriptions();
      identity.unregisterIdentitySubscriptions();
    }
  });

  it('[S15-F10] agency erasure deletes many photo objects with a few deletes in flight (none left behind)', async () => {
    const other = await createFounder({ companyName: `Erased Team ${RUN}` });
    for (let i = 0; i < 20; i++)
      await storage().put('media', `portal/member-photos/${other.agencyId}/${newId()}.webp`, new Uint8Array([1]), {
        contentType: 'image/webp',
      });
    const r = await identity.eraseAgencyPublicProfiles({ agencyId: other.agencyId });
    expect(r).toEqual({ profiles: 0, objects: 20, more: false });
    expect((await storage().list('media', `portal/member-photos/${other.agencyId}/`, { limit: 100 })).objects).toEqual(
      [],
    );
  });
});
