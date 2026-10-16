import { BookmarkFolderBody, CreateBookmarkBody, ListBookmarksQuery, UpdateBookmarkBody } from '@inmolink/contracts';
import { closeDb, countQueries, withSystem } from '@inmolink/db';
import { setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as taxonomy from '../../taxonomy';
import * as properties from '../index';

/** Bookmark folders and bookmarks on the real database (S3-09). */

const RUN = newId().slice(-8);
const code = (s: string) => `${s}-${RUN}`;
const tr = (name: string, slug: string) => [{ locale: 'en', name, slug: code(slug) }];

type Member = { userId: string; agencyId: string };
let owner: Founder;
let agent: Member;
let other: Founder;
let ids: { location: string; type: string };

const as = <T>(m: Member, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);
const refusal = (p: Promise<unknown>) =>
  p.then(
    () => 'resolved',
    (err: { code?: string }) => err.code ?? String(err),
  );
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('properties.bookmarks.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);

const folder = (m: Member, name: string) =>
  as(m, (ctx) => properties.createBookmarkFolder(ctx, BookmarkFolderBody.parse({ name })));
const bookmark = (m: Member, folderId: string, listingId: string, note?: string) =>
  as(m, (ctx) => properties.createBookmark(ctx, CreateBookmarkBody.parse({ folderId, listingId, note })));
const page = (m: Member, folderId: string, q: Record<string, unknown> = {}) =>
  as(m, (ctx) => properties.listBookmarks(ctx, folderId, ListBookmarksQuery.parse(q)));

/** One listing straight into the table: a shared, active, rated listing unless `over` says otherwise. */
async function seedListing(
  m: Member,
  ref: string,
  over: { status?: string; visibility?: string } = {},
): Promise<string> {
  const [row] = await rows<{ id: string }>(sql`
    insert into properties (id, agency_id, owner_user_id, ref, status, visibility, transaction_type, price_cents,
                            bedrooms, built_m2, energy_rating, property_type_id, location_id)
    values (gen_random_uuid(), ${m.agencyId}, ${m.userId}, ${code(ref)}, ${over.status ?? 'ACTIVE'}::listing_status,
            ${over.visibility ?? 'SHARED'}::visibility, 'SALE', 35000000, 3, 120.5, 'C', ${ids.type}, ${ids.location})
    returning id`);
  return (row as { id: string }).id;
}

beforeAll(async () => {
  await setupTestDb('worker');
  [owner, other] = await Promise.all([createFounder(), createFounder()]);
  for (const f of [owner, other]) await setAgencyStatus(f.agencyId, 'VERIFIED');
  const agentId = newId();
  await system(async (tx) => {
    await tx.execute(sql`insert into users (id, email, password_hash, name, locale, status)
      values (${agentId}, ${`agent-${agentId}@example.com`}, 'x', 'Agent', 'es', 'ACTIVE')`);
    await tx.execute(sql`insert into agency_members (agency_id, user_id, role, name, email)
      values (${owner.agencyId}, ${agentId}, 'AGENT', 'Agent', ${`agent-${agentId}@example.com`})`);
  });
  agent = { userId: agentId, agencyId: owner.agencyId };
  ids = await system(async (tx) => {
    const location = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('bm'),
      translations: tr(`Bookmarkland ${RUN}`, 'bookmarkland'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: code('bm-houses'),
      sort: 0,
      translations: tr(`Houses ${RUN}`, 'bm-houses'),
    });
    const type = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: code('bm-villa'),
      sort: 0,
      translations: tr(`Villa ${RUN}`, 'bm-villa'),
    });
    return { location, type };
  });
}, 120_000);

afterAll(async () => {
  // The shared test database keeps every run's rows: drop this file's listings and folders (bookmarks cascade).
  await system(async (tx) => {
    for (const agencyId of [owner.agencyId, other.agencyId]) {
      await tx.execute(sql`delete from bookmark_folders where agency_id = ${agencyId}`);
      await tx.execute(sql`delete from properties where agency_id = ${agencyId}`);
    }
  });
  await closeDb();
}, 120_000);

describe('bookmarks (S3-09)', () => {
  it("[S4-F1] a member cannot read a colleague's bookmark notes through withTenant (RLS, not only the app filter)", async () => {
    const listingId = await seedListing(owner, 'rls-note');
    const f = await folder(owner, `RLS ${RUN}`);
    const note = `private note ${RUN}`;
    await bookmark(owner, f.id, listingId, note);
    const read = (m: Member, q: ReturnType<typeof sql>) => as(m, async (ctx) => (await ctx.tx.execute(q)).rows);
    // the colleague's own tenant transaction, no app filter: nothing of the owner's folders or bookmarks
    expect(await read(agent, sql`select id from bookmark_folders where id = ${f.id}`)).toEqual([]);
    expect(await read(agent, sql`select note from listing_bookmarks where folder_id = ${f.id}`)).toEqual([]);
    expect(await read(agent, sql`select note from listing_bookmarks where note = ${note}`)).toEqual([]);
    // nor change them
    expect(
      await read(agent, sql`update listing_bookmarks set note = 'x' where folder_id = ${f.id} returning id`),
    ).toEqual([]);
    expect(await read(agent, sql`delete from bookmark_folders where id = ${f.id} returning id`)).toEqual([]);
    // the member themselves still reads them
    expect(await read(owner, sql`select note from listing_bookmarks where folder_id = ${f.id}`)).toEqual([{ note }]);
    await as(owner, (ctx) => properties.deleteBookmarkFolder(ctx, f.id));
  });

  it('[S3-09] a member bookmarks own and network listings into folders with notes; folders stay private to the member', async () => {
    const own = await seedListing(owner, 'OWN1', { visibility: 'PRIVATE', status: 'DRAFT' });
    const network = await seedListing(other, 'NET1');
    const villas = await folder(agent, 'Villas for the Smiths');
    expect(villas).toMatchObject({ name: 'Villas for the Smiths', count: 0 });
    expect(await refusal(folder(agent, 'Villas for the Smiths'))).toBe('BOOKMARK_FOLDER_NAME_TAKEN');

    const a = await bookmark(agent, villas.id, own, '  Owner flexible on price ');
    expect(a).toMatchObject({ available: true, note: 'Owner flexible on price', listingId: own });
    expect(a.listing).toMatchObject({ ref: code('OWN1'), status: 'DRAFT', own: true, builtM2: 120.5, bedrooms: 3 });
    const b = await bookmark(agent, villas.id, network);
    expect(b.listing).toMatchObject({
      ref: code('NET1'),
      own: false,
      price: { amountCents: 35000000, currency: 'EUR' },
    });
    // The owner agency is never named.
    expect(b.listing).not.toHaveProperty('agencyId');
    expect(await refusal(bookmark(agent, villas.id, network))).toBe('BOOKMARK_EXISTS');

    const listed = await page(agent, villas.id);
    expect(listed.items.map((i) => i.listingId)).toEqual([network, own]);
    expect((await as(agent, (ctx) => properties.listBookmarkFolders(ctx))).items).toEqual([
      expect.objectContaining({ id: villas.id, count: 2 }),
    ]);
    expect((await as(agent, (ctx) => properties.listListingBookmarks(ctx, network))).items).toEqual([
      { id: b.id, folderId: villas.id, note: null },
    ]);

    // The admin of the same agency neither sees nor touches the agent's folders and bookmarks.
    expect((await as(owner, (ctx) => properties.listBookmarkFolders(ctx))).items).toEqual([]);
    expect(await refusal(page(owner, villas.id))).toBe('BOOKMARK_FOLDER_NOT_FOUND');
    expect(await refusal(bookmark(owner, villas.id, own))).toBe('BOOKMARK_FOLDER_NOT_FOUND');
    expect(
      await refusal(as(owner, (ctx) => properties.updateBookmark(ctx, a.id, UpdateBookmarkBody.parse({ note: 'x' })))),
    ).toBe('BOOKMARK_NOT_FOUND');
    expect(await refusal(as(owner, (ctx) => properties.deleteBookmark(ctx, a.id)))).toBe('BOOKMARK_NOT_FOUND');
    expect(await refusal(as(owner, (ctx) => properties.deleteBookmarkFolder(ctx, villas.id)))).toBe(
      'BOOKMARK_FOLDER_NOT_FOUND',
    );
    expect((await as(owner, (ctx) => properties.listListingBookmarks(ctx, network))).items).toEqual([]);

    // A listing the member cannot see (another agency's private one) cannot be bookmarked.
    const hidden = await seedListing(other, 'HID1', { visibility: 'PRIVATE' });
    expect(await refusal(bookmark(agent, villas.id, hidden))).toBe('LISTING_NOT_FOUND');

    const renamed = await as(agent, (ctx) =>
      properties.renameBookmarkFolder(ctx, villas.id, BookmarkFolderBody.parse({ name: 'Smiths' })),
    );
    expect(renamed).toMatchObject({ name: 'Smiths', count: 2 });
  });

  it('[S3-09] bookmarks of listings that are no longer visible show as unavailable instead of erroring', async () => {
    const shared = await seedListing(other, 'GONE1');
    const deletedLater = await seedListing(owner, 'GONE2');
    const stays = await seedListing(other, 'STAY1');
    const f = await folder(agent, 'Shortlist');
    const gone = await bookmark(agent, f.id, shared, 'Sea views');
    await bookmark(agent, f.id, deletedLater);
    await bookmark(agent, f.id, stays);

    // The other agency takes its listing off the network; the owner agency deletes its own.
    await system(async (tx) => {
      await tx.execute(sql`update properties set visibility = 'PRIVATE' where id = ${shared}`);
      await tx.execute(sql`update properties set deleted_at = now() where id = ${deletedLater}`);
    });

    const listed = await page(agent, f.id);
    const byListing = new Map(listed.items.map((i) => [i.listingId, i]));
    expect(byListing.get(shared)).toMatchObject({ available: false, listing: null, note: 'Sea views' });
    expect(byListing.get(deletedLater)).toMatchObject({ available: false, listing: null });
    expect(byListing.get(stays)).toMatchObject({ available: true, listing: expect.objectContaining({ own: false }) });
    // Still counted, still editable and removable; never an error.
    expect((await as(agent, (ctx) => properties.listBookmarkFolders(ctx))).items).toContainEqual(
      expect.objectContaining({ id: f.id, count: 3 }),
    );
    const edited = await as(agent, (ctx) =>
      properties.updateBookmark(ctx, gone.id, UpdateBookmarkBody.parse({ note: 'Ask if it comes back' })),
    );
    expect(edited).toMatchObject({ available: false, listing: null, note: 'Ask if it comes back' });
    // A selection made from the folder starts from the visible listings only (S12-04 hook).
    expect(await as(agent, (ctx) => properties.bookmarkFolderListingIds(ctx, f.id))).toEqual([stays]);
    // Re-bookmarking a listing that left the view is refused like any invisible listing.
    const g = await folder(agent, 'Later');
    expect(await refusal(bookmark(agent, g.id, shared))).toBe('LISTING_NOT_FOUND');
    expect(await refusal(bookmark(agent, g.id, deletedLater))).toBe('LISTING_NOT_FOUND');
    await as(agent, (ctx) => properties.deleteBookmark(ctx, gone.id));
    expect((await page(agent, f.id)).items).toHaveLength(2);
  });

  it('[S3-09] bookmarks move between folders and page by keyset; caps hold; deleting a folder deletes its bookmarks', async () => {
    const listings = await Promise.all([1, 2, 3].map((i) => seedListing(owner, `PG${i}`)));
    const [l0, l1] = listings as [string, string, string];
    const from = await folder(owner, 'From');
    const to = await folder(owner, 'To');
    const saved = [];
    for (const l of listings) saved.push(await bookmark(owner, from.id, l));

    const first = await page(owner, from.id, { limit: 2 });
    expect(first.items).toHaveLength(2);
    const second = await page(owner, from.id, { limit: 2, cursor: first.nextCursor });
    expect([...first.items, ...second.items].map((i) => i.id).sort()).toEqual(saved.map((s) => s.id).sort());
    expect(second.nextCursor).toBeNull();
    const firstId = (saved[0] as { id: string }).id;
    // A page is the member context + 2 statements (folder, bookmarks joined to listings): no N+1.
    expect(await countQueries(() => page(owner, from.id, { limit: 100 }))).toBeLessThanOrEqual(10);

    const moved = await as(owner, (ctx) =>
      properties.updateBookmark(ctx, firstId, UpdateBookmarkBody.parse({ folderId: to.id })),
    );
    expect(moved.folderId).toBe(to.id);
    await bookmark(owner, from.id, l0);
    expect(
      await refusal(
        as(owner, (ctx) => properties.updateBookmark(ctx, firstId, UpdateBookmarkBody.parse({ folderId: from.id }))),
      ),
    ).toBe('BOOKMARK_EXISTS');
    expect(
      await refusal(
        as(owner, (ctx) => properties.updateBookmark(ctx, firstId, UpdateBookmarkBody.parse({ folderId: newId() }))),
      ),
    ).toBe('BOOKMARK_FOLDER_NOT_FOUND');

    // 500 per folder: the folder row lock makes it exact.
    const full = await folder(owner, 'Full');
    await system((tx) =>
      tx.execute(sql`insert into listing_bookmarks (id, agency_id, user_id, folder_id, property_id)
        select gen_random_uuid(), ${owner.agencyId}, ${owner.userId}, ${full.id}, gen_random_uuid()
          from generate_series(1, 500)`),
    );
    expect(await refusal(bookmark(owner, full.id, l1))).toBe('BOOKMARK_FOLDER_FULL');

    // Deleting a folder takes its bookmarks with it.
    await as(owner, (ctx) => properties.deleteBookmarkFolder(ctx, full.id));
    const [left] = await rows<{ n: number }>(
      sql`select count(*)::int as n from listing_bookmarks where folder_id = ${full.id}`,
    );
    expect(left?.n).toBe(0);

    // 100 folders per member.
    await system((tx) =>
      tx.execute(sql`insert into bookmark_folders (id, agency_id, user_id, name)
        select gen_random_uuid(), ${other.agencyId}, ${other.userId}, 'f' || i from generate_series(1, 100) as i`),
    );
    expect(await refusal(folder(other, 'One more'))).toBe('BOOKMARK_FOLDER_LIMIT');
    expect((await as(other, (ctx) => properties.listBookmarkFolders(ctx))).items).toHaveLength(100);
  });

  it('[S3-09] Client Mode never reads or writes bookmarks (notes are internal)', async () => {
    const f = await folder(owner, 'Client mode');
    const l = await seedListing(owner, 'CM1');
    const client = <T>(fn: (ctx: Ctx) => Promise<T>) => as(owner, (ctx) => fn({ ...ctx, clientMode: true }));
    expect(await refusal(client((ctx) => properties.listBookmarkFolders(ctx)))).toBe('FORBIDDEN');
    expect(await refusal(client((ctx) => properties.listBookmarks(ctx, f.id, ListBookmarksQuery.parse({}))))).toBe(
      'FORBIDDEN',
    );
    expect(
      await refusal(
        client((ctx) => properties.createBookmark(ctx, CreateBookmarkBody.parse({ folderId: f.id, listingId: l }))),
      ),
    ).toBe('FORBIDDEN');
    expect(await refusal(client((ctx) => properties.listListingBookmarks(ctx, l)))).toBe('FORBIDDEN');
  });
});
