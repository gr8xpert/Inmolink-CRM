import {
  type ConsentRecordDto,
  CreateContactBody,
  type CreateContactInput,
  UpdateContactBody,
} from '@inmolink/contracts';
import { closeDb, withSystem } from '@inmolink/db';
import { setupTestDb } from '@inmolink/db/testing';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as crm from '../index';

/**
 * Editing a contact from its page (S17-F28): what the dashboard form sends — the whole form, at the version it loaded —
 * keeps the optimistic version, the field rules and the consent history of `updateContact`.
 */

const RUN = newId().slice(-8).toLowerCase();
const email = (name: string) => `edit-${name}-${RUN}@example.com`;
let a: Founder;
let b: Founder;

const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);
const create = async (m: Founder, body: CreateContactInput) =>
  (await as(m, (ctx) => crm.createContact(ctx, CreateContactBody.parse(body)))).contact;
const edit = (m: Founder, id: string, body: unknown) =>
  as(m, (ctx) => crm.updateContact(ctx, id, UpdateContactBody.parse(body)));
const consents = async (m: Founder, id: string): Promise<ConsentRecordDto[]> =>
  (await as(m, (ctx) => crm.listContactConsents(ctx, id))).items;
const updatedEvents = (id: string) =>
  withSystem('crm.contactEdit.test', async (tx) => {
    const res = await tx.execute(
      sql`select (payload->>'version')::int as version from outbox_events
          where type = 'crm.contact.updated' and payload->>'contactId' = ${id}`,
    );
    return res.rows as { version: number }[];
  });

async function refusal(promise: Promise<unknown>): Promise<{ code: string; details?: Record<string, unknown> }> {
  try {
    await promise;
  } catch (err) {
    if (isAppError(err)) return { code: err.code, ...(err.details ? { details: err.details } : {}) };
    throw err;
  }
  return { code: 'accepted' };
}

/** The whole form as `contactEditBody` builds it from a loaded contact. */
const formOf = (c: Awaited<ReturnType<typeof create>>) => ({
  version: c.version,
  types: c.types,
  firstName: c.firstName,
  lastName: c.lastName,
  emails: c.emails,
  phones: c.phones,
  language: c.language,
  tags: c.tags,
  consentMarketing: c.consentMarketing,
  consentProcessing: c.consentProcessing,
  doNotContact: c.doNotContact,
});

beforeAll(async () => {
  await setupTestDb('worker');
  [a, b] = await Promise.all([createFounder(), createFounder()]);
});

afterAll(async () => {
  await closeDb();
});

describe('editing a contact', () => {
  it('[S17-F28] the form changes the fields, moves the version once and emits crm.contact.updated', async () => {
    const c = await create(a, { firstName: 'Ana', emails: [email('ana')], tags: ['old'], types: ['BUYER'] });
    const after = await edit(a, c.id, {
      ...formOf(c),
      firstName: 'Anna',
      lastName: 'Sol',
      emails: [email('ana.new'), email('ana')],
      tags: ['new'],
      types: ['SELLER'],
      language: 'es',
      doNotContact: true,
    });
    expect(after).toMatchObject({
      firstName: 'Anna',
      lastName: 'Sol',
      emails: [email('ana.new'), email('ana')],
      tags: ['new'],
      types: ['SELLER'],
      language: 'es',
      doNotContact: true,
      source: c.source,
      ownerUserId: c.ownerUserId,
      version: c.version + 1,
    });
    expect(await updatedEvents(c.id)).toEqual([{ version: c.version + 1 }]);
  });

  it('[S17-F28] a form loaded before someone else saved is refused and changes nothing', async () => {
    const c = await create(a, { firstName: 'Bea', emails: [email('bea')] });
    const saved = await edit(a, c.id, { ...formOf(c), firstName: 'Beatriz' });
    expect((await refusal(edit(a, c.id, { ...formOf(c), firstName: 'Stale', consentMarketing: true }))).code).toBe(
      'VERSION_CONFLICT',
    );
    const now = await as(a, (ctx) => crm.getContact(ctx, c.id));
    expect(now).toMatchObject({ firstName: 'Beatriz', consentMarketing: false, version: saved.version });
    expect(await consents(a, c.id)).toEqual([]);
  });

  it('[S17-F28] saving without touching a consent adds no consent record and keeps its time', async () => {
    const c = await create(a, { firstName: 'Cruz', emails: [email('cruz')], consentMarketing: true });
    const before = await consents(a, c.id);
    expect(before).toHaveLength(1);
    const after = await edit(a, c.id, { ...formOf(c), firstName: 'Cruz María' });
    expect(after.consentMarketing).toBe(true);
    expect(after.consentMarketingAt).toBe(c.consentMarketingAt);
    expect(await consents(a, c.id)).toEqual(before);
  });

  it('[S17-F28] changing a consent on the form is one record, source dashboard, naming the member', async () => {
    const c = await create(a, { firstName: 'Dani', emails: [email('dani')], consentMarketing: true });
    const after = await edit(a, c.id, { ...formOf(c), consentMarketing: false, consentProcessing: true });
    expect(after).toMatchObject({ consentMarketing: false, consentProcessing: true });
    expect(after.consentMarketingAt).not.toBe(c.consentMarketingAt);
    const records = await consents(a, c.id);
    expect(records.map((r) => [r.purpose, r.granted]).sort()).toEqual(
      [
        ['MARKETING', false],
        ['MARKETING', true],
        ['PROCESSING', true],
      ].sort(),
    );
    const added = records.filter((r) => !(r.purpose === 'MARKETING' && r.granted));
    for (const r of added) expect(r).toMatchObject({ source: 'DASHBOARD', actorUserId: a.userId });
  });

  it('[S17-F28] a contact keeps a name, an e-mail or a phone', async () => {
    const c = await create(a, { firstName: 'Eva', emails: [email('eva')] });
    const refused = await refusal(edit(a, c.id, { ...formOf(c), firstName: null, emails: [] }));
    expect(refused).toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'no_identity' } });
    // the e-mail alone still identifies the person
    expect((await edit(a, c.id, { ...formOf(c), firstName: null })).firstName).toBeNull();
  });

  it('[S17-F28] an e-mail of another contact is refused with that contact, and nothing changes', async () => {
    const other = await create(a, { firstName: 'Other', emails: [email('other')] });
    const c = await create(a, { firstName: 'Flor', emails: [email('flor')] });
    const refused = await refusal(edit(a, c.id, { ...formOf(c), firstName: 'X', emails: [email('other')] }));
    expect(refused).toMatchObject({
      code: 'CONTACT_DUPLICATE',
      details: { matches: [{ contactId: other.id, on: 'email' }] },
    });
    expect(await as(a, (ctx) => crm.getContact(ctx, c.id))).toMatchObject({
      firstName: 'Flor',
      emails: [email('flor')],
      version: c.version,
    });
  });

  it('[S17-F28] a contact of another agency cannot be edited', async () => {
    const c = await create(a, { firstName: 'Gala', emails: [email('gala')] });
    expect((await refusal(edit(b, c.id, { ...formOf(c), firstName: 'Mine' }))).code).toBe('CONTACT_NOT_FOUND');
  });
});
