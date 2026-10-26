import {
  CreateListingBody,
  type CreateSiteInput,
  DecideVerificationBody,
  InviteMemberBody,
  type OnboardingStep,
  UpdateAgencyDetailsBody,
  UpdateListingBody,
} from '@inmolink/contracts';
import { closeDb, type Tx, withSystem, withTenant } from '@inmolink/db';
import { createStaffUser, loadStackEnv, setupTestDb } from '@inmolink/db/testing';
import { loadConfig, storageEnv } from '@inmolink/platform/config';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { defaultSubscribers } from '@inmolink/platform/outbox';
import { configureStorage, createS3Store, storageConfigFromEnv } from '@inmolink/platform/storage';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx, CtxRunner, StaffCtx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { withStaffCtx } from '../../../staff';
import { createFounder, type Founder } from '../../../testing/factories';
import * as agencies from '../../agencies';
import * as identity from '../../identity';
import * as properties from '../../properties';
import * as taxonomy from '../../taxonomy';
import * as websites from '../../websites';
import * as onboarding from '../index';

/**
 * The onboarding checklist end to end on the test database and MinIO (S13-04): members and staff act through the real
 * services (invite, listing editor, verification, website, feed import batch), the outbox rows those actions wrote are
 * delivered to the registered `onboarding.progress.*` subscribers (as the dispatcher does), and the checklist and the
 * staff view read the projection.
 */

const RUN = newId().slice(-8).toLowerCase();
const PDF = new TextEncoder().encode('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n');
const system = <T>(fn: (tx: Tx) => Promise<T>) => withSystem('onboarding.test', fn);

let a: Founder;
let b: Founder;
let c: Founder;
let agentOfA: Founder;
let staffUser: string;
let ids: { city: string; villa: string };

const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);
const runner =
  (m: Founder): CtxRunner =>
  (fn) =>
    as(m, fn);
const asStaff = <T>(fn: (ctx: StaffCtx) => Promise<T>) =>
  withStaffCtx({ userId: staffUser, requestId: newId(), reason: 'onboarding int test' }, fn);

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (isAppError(err)) return err.code;
    const cause = (err as { cause?: { message?: string } }).cause?.message ?? (err as Error).message;
    return /row-level security|permission denied/.test(cause) ? 'RLS' : `unexpected: ${cause}`;
  }
  return 'accepted';
}

type Row = {
  id: string;
  agency_id: string;
  type: string;
  version: number;
  payload: unknown;
  created_at: string | Date;
};

/**
 * Delivers the agency's outbox rows not delivered yet (or all of them with `all`) to the onboarding subscribers —
 * what the dispatcher does — each `times` over.
 */
const delivered = new Set<string>();
async function deliver(agencyId: string, opts: { times?: number; all?: boolean } = {}): Promise<number> {
  const events = await system(
    async (tx) =>
      (
        await tx.execute(sql`select id, agency_id, type, version, payload, created_at from outbox_events
          where agency_id = ${agencyId} order by created_at, id`)
      ).rows as Row[],
  );
  let handled = 0;
  for (let i = 0; i < (opts.times ?? 1); i++) {
    for (const e of events) {
      if (!opts.all && delivered.has(e.id)) continue;
      delivered.add(e.id);
      handled += await handle(e.type, e.version, e.payload, {
        eventId: e.id,
        agencyId: e.agency_id,
        createdAt: new Date(e.created_at),
      });
    }
  }
  return handled;
}

/** Runs the onboarding subscribers of one event; the number that ran. */
async function handle(
  type: string,
  version: number,
  payload: unknown,
  meta: { eventId: string; agencyId: string; createdAt: Date },
): Promise<number> {
  let n = 0;
  for (const sub of defaultSubscribers.get(type, version)) {
    if (!sub.name.startsWith('onboarding.progress.')) continue;
    await sub.handler(sub.def.schema.parse(payload), { ...meta, type, version, attempt: 1 });
    n++;
  }
  return n;
}

const done = (list: { steps: { step: OnboardingStep; completedAt: string | null }[] }) =>
  list.steps.filter((s) => s.completedAt).map((s) => s.step);
const doneOf = async (m: Founder) => done(await as(m, (ctx) => onboarding.getChecklist(ctx)));
const stepRows = (agencyId: string) =>
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

async function share(m: Founder, listingId: string, shareScope: 'ALL' | 'PREFERRED'): Promise<void> {
  await as(m, async (ctx) =>
    properties.updateListing(
      ctx,
      listingId,
      UpdateListingBody.parse({
        status: 'ACTIVE',
        visibility: 'SHARED',
        shareScope,
        version: (await properties.getListing(ctx, listingId)).version,
      }),
    ),
  );
}

/** The agency fills in its company details, uploads a document and submits; the request id and version. */
async function submitVerification(m: Founder, fileName: string): Promise<{ requestId: string; version: number }> {
  const agency = await as(m, (ctx) => agencies.getMyAgency(ctx));
  if (!agency.onboarded) {
    await as(m, (ctx) =>
      agencies.updateAgencyDetails(
        ctx,
        UpdateAgencyDetailsBody.parse({
          version: agency.version,
          name: `Onboarding ${RUN} S.L.`,
          taxId: 'B12345674',
          addressLine: 'Calle Mayor 1',
          city: 'Marbella',
          postalCode: '29601',
          region: 'ES-AN',
          languages: ['es', 'en'],
        }),
      ),
    );
  }
  await agencies.uploadVerificationDocument(runner(m), { kind: 'TAX_ID', fileName, body: PDF });
  const { agencyVersion } = await as(m, (ctx) => agencies.getAgencyVerification(ctx));
  const after = await as(m, (ctx) => agencies.submitVerification(ctx, { version: agencyVersion }));
  if (!after.latestRequest) throw new Error('no verification request');
  return { requestId: after.latestRequest.id, version: agencyVersion };
}

const decide = (requestId: string, decision: 'APPROVE' | 'REJECT', agencyVersion: number) =>
  asStaff((ctx) =>
    agencies.decideVerification(ctx, {
      id: requestId,
      ...DecideVerificationBody.parse({ decision, agencyVersion, reason: 'Checked against the AEAT register' }),
    }),
  );

const SITE: CreateSiteInput = {
  name: `Onboarding ${RUN}`,
  domains: [`www.onboarding-${RUN}.example`],
  mode: 'IFRAME',
  inventoryPolicy: 'CUSTOM',
  inventoryFilters: null,
  referencePrefix: 'ON',
  locales: ['en'],
  contact: { name: 'Onboarding Homes', email: `hello@onboarding-${RUN}.example`, phone: '+34 600 000 019' },
};

async function memberOf(agencyId: string, role: string): Promise<Founder> {
  const userId = newId();
  const email = `onb-${role.toLowerCase()}-${userId}@example.com`;
  await system(async (tx) => {
    await tx.execute(sql`insert into users (id, email, password_hash, name, locale, status)
      values (${userId}, ${email}, 'x', 'Onboarding agent', 'en', 'ACTIVE')`);
    await tx.execute(sql`insert into agency_members (agency_id, user_id, role, name, email)
      values (${agencyId}, ${userId}, ${role}, 'Onboarding agent', ${email})`);
  });
  return { userId, agencyId, email, password: 'x' };
}

beforeAll(async () => {
  await setupTestDb('worker');
  loadStackEnv('test');
  configureStorage(createS3Store(storageConfigFromEnv(loadConfig(storageEnv))));
  [a, b, c] = await Promise.all([createFounder(), createFounder(), createFounder()]);
  agentOfA = await memberOf(a.agencyId, 'AGENT');
  staffUser = (await createStaffUser('STAFF_SUPPORT')).userId;
  ids = await system(async (tx) => {
    const name = (n: string) => [{ locale: 'en', name: `${n} ${RUN}`, slug: `${n.toLowerCase()}-${RUN}` }];
    const city = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: `onb-${RUN}`,
      translations: name('Onbcountry'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: `onb-g-${RUN}`,
      sort: 0,
      translations: name('Onbhomes'),
    });
    const villa = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: `onb-v-${RUN}`,
      sort: 0,
      translations: name('Onbvilla'),
    });
    return { city, villa };
  });
  onboarding.registerOnboardingSubscriptions();
}, 180_000);

afterAll(async () => {
  onboarding.unregisterOnboardingSubscriptions();
  await closeDb();
});

describe('the checklist completes from real events', () => {
  it('[S13-04] checklist steps complete automatically from the agency events (not manual ticks)', async () => {
    const start = await as(a, (ctx) => onboarding.getChecklist(ctx));
    expect(start).toMatchObject({ role: 'AGENCY_ADMIN', completed: 0, total: 5 });
    expect(start.steps.map((s) => s.step)).toEqual([
      'VERIFY_AGENCY',
      'IMPORT_LISTINGS',
      'CONNECT_WEBSITE',
      'INVITE_TEAM',
      'SHARE_LISTING',
    ]);

    // invite team: the admin's invite; import listings: a listing added in the editor (PRIVATE: nothing shared)
    await as(a, (ctx) =>
      identity.inviteMember(ctx, InviteMemberBody.parse({ email: `onb-invitee-${RUN}@example.com`, role: 'AGENT' })),
    );
    const listingId = await listing(a);
    await deliver(a.agencyId);
    expect(await doneOf(a)).toEqual(['IMPORT_LISTINGS', 'INVITE_TEAM']);

    // verify agency: staff's rejection completes nothing, their approval of the resubmission does
    const first = await submitVerification(a, 'cif.pdf');
    await decide(first.requestId, 'REJECT', first.version);
    await deliver(a.agencyId);
    expect(await doneOf(a)).not.toContain('VERIFY_AGENCY');
    const second = await submitVerification(a, 'cif-clear.pdf');
    await decide(second.requestId, 'APPROVE', second.version);
    await deliver(a.agencyId);
    expect(await doneOf(a)).toContain('VERIFY_AGENCY');

    // share first listing: shared with preferred agencies only is not "on the network" yet; shared with all is
    await share(a, listingId, 'PREFERRED');
    await deliver(a.agencyId);
    expect(await doneOf(a)).not.toContain('SHARE_LISTING');
    await share(a, listingId, 'ALL');

    // connect website: the admin creates the agency's site
    const filters = {
      includeOwn: true,
      includeNetwork: false,
      locationIds: [ids.city],
      propertyTypeIds: [],
      newBuilds: true,
    };
    await as(a, (ctx) => websites.createSite(ctx, { ...SITE, inventoryFilters: filters }));
    await deliver(a.agencyId);
    expect(await as(a, (ctx) => onboarding.getChecklist(ctx))).toMatchObject({ completed: 5, total: 5 });

    // redelivery (or a staff replay) changes nothing — also with the in-process memory forgotten
    const before = await stepRows(a.agencyId);
    onboarding.unregisterOnboardingSubscriptions();
    onboarding.registerOnboardingSubscriptions();
    expect(await deliver(a.agencyId, { all: true, times: 2 })).toBeGreaterThan(0);
    expect(await stepRows(a.agencyId)).toEqual(before);
  });

  it('[S13-04] a feed run completes import listings; imported listings are not shared (imports keep them PRIVATE)', async () => {
    const run: properties.ImportRun = {
      agencyId: b.agencyId,
      runId: newId(),
      connectionId: newId(),
      source: 'KYERO',
      ownerUserId: b.userId,
      commission: { type: 'PCT', basisPoints: 500, includesVat: false },
      splitBp: 5000,
    };
    const result = await withTenant({ agencyId: b.agencyId, userId: b.userId }, (tx) =>
      properties.importListingBatch(tx, run, [
        {
          ref: `ONB-${RUN}`,
          hash: 'a'.repeat(64),
          imagesHash: null,
          held: [],
          status: 'ACTIVE',
          transactionType: 'SALE',
          priceCents: 30_000_000,
          currency: 'EUR',
          pricePeriod: null,
          priceOnRequest: false,
          builtM2: 120,
          plotM2: null,
          terraceM2: null,
          bedrooms: 3,
          bathrooms: 2,
          yearBuilt: null,
          energyRating: 'C',
          energyEmissionsRating: null,
          coordinates: null,
          locationPrecision: 'APPROX',
          propertyTypeId: ids.villa,
          locationId: ids.city,
          featureIds: [],
          translations: [{ locale: 'en', title: `Imported villa ${RUN}`, description: null }],
        },
      ]),
    );
    expect(result.created).toBe(1);
    await deliver(b.agencyId);
    const progress = await asStaff((ctx) => onboarding.getStaffOnboarding(ctx, { agencyId: b.agencyId }));
    expect(done(progress)).toEqual(['IMPORT_LISTINGS']);
  });

  it('[S13-04] the earliest event wins: an older event delivered late moves the step back, a newer one does not', async () => {
    const event = (at: string) => ({ eventId: newId(), agencyId: c.agencyId, createdAt: new Date(at) });
    const site = { siteId: newId(), agencyId: c.agencyId };
    const newer = event('2026-06-02T10:00:00Z');
    const older = event('2026-06-01T10:00:00Z');
    await handle('websites.site.created', 1, site, newer);
    await handle('websites.site.created', 1, site, older);
    await handle('websites.site.created', 1, site, event('2026-06-03T10:00:00Z'));
    const rows = await stepRows(c.agencyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ step: 'CONNECT_WEBSITE', event_id: older.eventId });
    expect(new Date(rows[0]?.completed_at ?? 0).toISOString()).toBe('2026-06-01T10:00:00.000Z');
  });

  it('[S13-04] events are only their own agency: a payload naming another agency and a sweep hide are ignored', async () => {
    const meta = { eventId: newId(), agencyId: c.agencyId, createdAt: new Date() };
    // the payload names b, the row is c's: neither agency gets the step
    await handle('identity.invite.created', 1, { agencyId: b.agencyId, inviteId: newId() }, meta);
    // the freshness sweep hid a shared listing (visibility unchanged): not a share
    const hide = { listingId: newId(), agencyId: c.agencyId, version: 2, visibility: 'SHARED', shareScope: 'ALL' };
    await handle('properties.listing.visibilityChanged', 1, { ...hide, networkHidden: true }, meta);
    expect((await stepRows(c.agencyId)).map((r) => r.step)).toEqual(['CONNECT_WEBSITE']);
    expect((await stepRows(b.agencyId)).map((r) => r.step)).not.toContain('INVITE_TEAM');
    // an event emitted before the flag existed (no `networkHidden`) still counts
    await handle('properties.listing.visibilityChanged', 1, hide, { ...meta, eventId: newId() });
    expect((await stepRows(c.agencyId)).map((r) => r.step)).toContain('SHARE_LISTING');
  });

  it('[S13 review] an event of an agency that no longer exists is skipped (no throw, no row), not dead-lettered', async () => {
    const gone = newId(); // no such agency: deleted by the time the event is delivered
    const meta = { eventId: newId(), agencyId: gone, createdAt: new Date() };
    await expect(handle('websites.site.created', 1, { siteId: newId(), agencyId: gone }, meta)).resolves.toBe(1);
    await expect(handle('identity.invite.created', 1, { agencyId: gone, inviteId: newId() }, meta)).resolves.toBe(1);
    expect(await stepRows(gone)).toEqual([]);
  });

  it('[S13-04] members cannot tick a step: no write path, and the table refuses their writes', async () => {
    expect(
      await refusal(
        withTenant({ agencyId: b.agencyId, userId: b.userId }, (tx) =>
          tx.execute(sql`insert into onboarding_steps (agency_id, step, completed_at, event_id)
            values (${b.agencyId}, 'CONNECT_WEBSITE', now(), ${newId()})`),
        ),
      ),
    ).toBe('RLS');
    expect(
      await refusal(
        withTenant({ agencyId: b.agencyId, userId: b.userId }, (tx) =>
          tx.execute(sql`delete from onboarding_steps where agency_id = ${b.agencyId}`),
        ),
      ),
    ).toBe('RLS');
  });
});

describe('role-based checklist and staff view', () => {
  it('[S13-04] admins and agents see the steps of their role, with the agency progress', async () => {
    const admin = await as(a, (ctx) => onboarding.getChecklist(ctx));
    const agent = await as(agentOfA, (ctx) => onboarding.getChecklist(ctx));
    expect(admin.total).toBe(5);
    expect(agent).toMatchObject({ role: 'AGENT', completed: 2, total: 2 });
    expect(agent.steps.map((s) => s.step)).toEqual(['IMPORT_LISTINGS', 'SHARE_LISTING']);
  });

  it('[S13-04] staff see every step of an agency (404 for an unknown one); Client Mode reaches nothing', async () => {
    const progress = await asStaff((ctx) => onboarding.getStaffOnboarding(ctx, { agencyId: a.agencyId }));
    expect(progress).toMatchObject({ agencyId: a.agencyId, completed: 5, total: 5 });
    expect(progress.steps.every((s) => s.completedAt)).toBe(true);
    expect(await refusal(asStaff((ctx) => onboarding.getStaffOnboarding(ctx, { agencyId: newId() })))).toBe(
      'NOT_FOUND',
    );
    expect(await refusal(as(a, (ctx) => onboarding.getChecklist({ ...ctx, clientMode: true })))).toBe('FORBIDDEN');
  });
});
