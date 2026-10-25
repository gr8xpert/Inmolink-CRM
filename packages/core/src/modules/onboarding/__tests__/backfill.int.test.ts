import { CreateListingBody, type CreateSiteInput, InviteMemberBody, UpdateListingBody } from '@inmolink/contracts';
import { closeDb, type Tx, withSystem } from '@inmolink/db';
import { loadStackEnv, setupTestDb } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as identity from '../../identity';
import * as properties from '../../properties';
import * as taxonomy from '../../taxonomy';
import * as websites from '../../websites';
import * as onboarding from '../index';

/**
 * The onboarding backfill (S13-F26) on the test database: agencies with data but no projection rows (no subscriber
 * is registered here, as before S13-04) get the matching steps with the earliest known time; a rerun writes nothing.
 */

const RUN = newId().slice(-8).toLowerCase();
const system = <T>(fn: (tx: Tx) => Promise<T>) => withSystem('onboarding.backfill.test', fn);
const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);

let full: Founder;
let listingOnly: Founder;
let empty: Founder;
let ids: { city: string; villa: string };

const steps = (agencyId: string) =>
  system(
    async (tx) =>
      (
        await tx.execute(sql`select step, completed_at, event_id from onboarding_steps where agency_id = ${agencyId}
          order by step`)
      ).rows as { step: string; completed_at: string | Date; event_id: string }[],
  );

async function listing(m: Founder): Promise<string> {
  const { id } = await as(m, (ctx) =>
    properties.createListing(
      ctx,
      CreateListingBody.parse({
        propertyTypeId: ids.villa,
        locationId: ids.city,
        priceCents: 45_000_000,
        energyRating: 'C',
        commission: { type: 'PCT', basisPoints: 400, includesVat: true },
        splitBp: 5000,
      }),
    ),
  );
  return id;
}

const SITE: CreateSiteInput = {
  name: `Backfill ${RUN}`,
  domains: [`www.backfill-${RUN}.example`],
  mode: 'IFRAME',
  inventoryPolicy: 'OWN_ONLY',
  inventoryFilters: null,
  referencePrefix: 'BF',
  locales: ['en'],
  contact: { name: 'Backfill Homes', email: `hello@backfill-${RUN}.example`, phone: '+34 600 000 026' },
};

beforeAll(async () => {
  await setupTestDb('worker');
  loadStackEnv('test');
  [full, listingOnly, empty] = await Promise.all([createFounder(), createFounder(), createFounder()]);
  ids = await system(async (tx) => {
    const name = (n: string) => [{ locale: 'en', name: `${n} ${RUN}`, slug: `${n.toLowerCase()}-${RUN}` }];
    const city = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: `bf-${RUN}`,
      translations: name('Bfcountry'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: `bf-g-${RUN}`,
      sort: 0,
      translations: name('Bfhomes'),
    });
    const villa = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: `bf-v-${RUN}`,
      sort: 0,
      translations: name('Bfvilla'),
    });
    return { city, villa };
  });

  // `full`: verified, a listing shared with everyone, a site, an invite
  await system((tx) => tx.execute(sql`update agencies set status = 'VERIFIED' where agency_id = ${full.agencyId}`));
  const listingId = await listing(full);
  await as(full, async (ctx) =>
    properties.updateListing(
      ctx,
      listingId,
      UpdateListingBody.parse({
        status: 'ACTIVE',
        visibility: 'SHARED',
        shareScope: 'ALL',
        version: (await properties.getListing(ctx, listingId)).version,
      }),
    ),
  );
  await as(full, (ctx) => websites.createSite(ctx, SITE));
  await as(full, (ctx) =>
    identity.inviteMember(ctx, InviteMemberBody.parse({ email: `bf-invitee-${RUN}@example.com`, role: 'AGENT' })),
  );
  // `listingOnly`: a private listing and nothing else
  await listing(listingOnly);
}, 180_000);

afterAll(async () => {
  await closeDb();
});

describe('onboarding backfill', () => {
  it('[S13-F26] an agency with existing data shows the matching steps done after the backfill', async () => {
    expect(await steps(full.agencyId)).toEqual([]);

    const result = await onboarding.backfillOnboarding({ agencyId: full.agencyId });
    expect(result).toMatchObject({ agencies: 1, changed: 5 });
    const rows = await steps(full.agencyId);
    expect(rows.map((r) => r.step).sort()).toEqual([
      'CONNECT_WEBSITE',
      'IMPORT_LISTINGS',
      'INVITE_TEAM',
      'SHARE_LISTING',
      'VERIFY_AGENCY',
    ]);
    expect(rows.every((r) => r.event_id === onboarding.BACKFILL_EVENT_ID)).toBe(true);
    // the earliest known time: the listing's creation, not "now"
    const listingAt = await system(
      async (tx) =>
        (await tx.execute(sql`select min(created_at) as at from properties where agency_id = ${full.agencyId}`))
          .rows[0] as { at: string | Date },
    );
    const importAt = rows.find((r) => r.step === 'IMPORT_LISTINGS')?.completed_at;
    expect(new Date(importAt as string).getTime()).toBe(new Date(listingAt.at).getTime());

    // a private listing alone completes the import step only; an agency with no data completes nothing
    await onboarding.backfillOnboarding({ agencyId: listingOnly.agencyId });
    expect((await steps(listingOnly.agencyId)).map((r) => r.step)).toEqual(['IMPORT_LISTINGS']);
    await onboarding.backfillOnboarding({ agencyId: empty.agencyId });
    expect(await steps(empty.agencyId)).toEqual([]);
  });

  it('[S13-F26] a rerun changes nothing, a full keyset walk covers every agency and resumes after a cursor', async () => {
    const before = await steps(full.agencyId);
    expect(await onboarding.backfillAgency(full.agencyId)).toBe(0);
    expect(await steps(full.agencyId)).toEqual(before);

    const pages: onboarding.BackfillProgress[] = [];
    const all = await onboarding.backfillOnboarding({ batch: 2, onPage: (p) => pages.push(p) });
    const count = await system(async (tx) =>
      Number((await tx.execute(sql`select count(*) as n from agencies`)).rows[0]?.n),
    );
    expect(all.agencies).toBe(count);
    expect(pages.length).toBe(Math.ceil(count / 2));
    expect(all.changed).toBeGreaterThanOrEqual(0);
    expect(await steps(full.agencyId)).toEqual(before);

    // resumable: starting after the last agency visits nothing
    const resumed = await onboarding.backfillOnboarding({ after: all.lastAgencyId, batch: 2 });
    expect(resumed).toMatchObject({ agencies: 0, changed: 0 });

    // idempotent over everything: a second full run writes no row
    expect((await onboarding.backfillOnboarding({ batch: 500 })).changed).toBe(0);
  });

  it('[S13-F26] an earlier real event wins over the backfill and a page is capped at 1,000 agencies', async () => {
    const early = new Date('2020-01-01T00:00:00Z');
    await system((tx) =>
      tx.execute(sql`update onboarding_steps set completed_at = ${early.toISOString()}
        where agency_id = ${full.agencyId} and step = 'IMPORT_LISTINGS'`),
    );
    expect(await onboarding.backfillAgency(full.agencyId)).toBe(0);
    const row = (await steps(full.agencyId)).find((r) => r.step === 'IMPORT_LISTINGS');
    expect(new Date(row?.completed_at as string).getTime()).toBe(early.getTime());
    await expect(
      system((tx) =>
        onboarding.backfillAgencySteps(
          tx,
          Array.from({ length: 1_001 }, () => newId()),
        ),
      ),
    ).rejects.toThrow(RangeError);
  });
});
