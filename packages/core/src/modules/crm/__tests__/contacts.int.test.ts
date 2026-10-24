import {
  CreateActivityBody,
  CreateContactBody,
  type CreateContactInput,
  CreateLeadBody,
  ListActivitiesQuery,
  StartContactImportBody,
} from '@inmolink/contracts';
import { closeDb, countQueries, withSystem, withTenant } from '@inmolink/db';
import * as crmSchema from '@inmolink/db/schema/crm';
import { contactEmails, contactFacets, contactPhones } from '@inmolink/db/schema/crm';
import { setupTestDb, withAdminRollback } from '@inmolink/db/testing';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { configureStorage, createMemoryStore } from '@inmolink/platform/storage';
import { getTableName, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import { contactImportKey, importBatch, runContactImport, sweepContactImports } from '../import';
import * as crm from '../index';
import { CONTACT_REFERENCES } from '../repo';

/**
 * Contacts (S10-01): duplicate detection on normalized e-mail and phone offers the merge instead of a second contact;
 * a merge moves everything that points at the closed contact to the survivor; CSV import with a mapping.
 */

const RUN = newId().slice(-8).toLowerCase();
const log = createLogger({ service: 'crm-test', level: 'silent' });
const job = () => ({ log, signal: new AbortController().signal, lastAttempt: true });
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('crm.contacts.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);
const store = createMemoryStore();

let a: Founder;
let b: Founder;
/** A second, plain member of `a`'s agency. */
let agentId: string;
const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);
const createResult = (m: Founder, body: CreateContactInput, opts: { idempotencyKey?: string } = {}) =>
  as(m, (ctx) => crm.createContact(ctx, CreateContactBody.parse(body), opts));
const create = async (m: Founder, body: CreateContactInput) => (await createResult(m, body)).contact;
const lookup = (m: Founder, body: { emails?: string[]; phones?: string[] }) =>
  as(m, (ctx) => crm.lookupContacts(ctx, { emails: body.emails ?? [], phones: body.phones ?? [] }));
const email = (name: string) => `${name}-${RUN}@example.com`;
/** A Spanish mobile unique to this run's agencies: `6` + 8 digits. */
let phoneSeq = Number.parseInt(RUN.replaceAll(/[^0-9]/g, '').slice(0, 4) || '1', 10) * 1_000;
const mobile = () => {
  phoneSeq += 1;
  return `6${String(phoneSeq).padStart(8, '0').slice(-8)}`;
};
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function refusal(promise: Promise<unknown>): Promise<{ code: string; details?: Record<string, unknown> }> {
  try {
    await promise;
  } catch (err) {
    if (isAppError(err)) return { code: err.code, ...(err.details ? { details: err.details } : {}) };
    throw err;
  }
  return { code: 'accepted' };
}

beforeAll(async () => {
  await setupTestDb('worker');
  configureStorage(store);
  [a, b] = await Promise.all([createFounder(), createFounder()]);
  agentId = newId();
  await system(async (tx) => {
    await tx.execute(sql`insert into users (id, email, password_hash, name, locale, status)
      values (${agentId}, ${`crm-agent-${agentId}@example.com`}, 'x', 'Agent', 'es', 'ACTIVE')`);
    await tx.execute(sql`insert into agency_members (agency_id, user_id, role, name, email)
      values (${a.agencyId}, ${agentId}, 'AGENT', 'Agent', ${`crm-agent-${agentId}@example.com`})`);
  });
});

afterAll(async () => {
  await closeDb();
});

describe('duplicate detection', () => {
  it('[S10-01] creating a contact with an existing email offers merge instead of duplicating', async () => {
    const first = await create(a, { firstName: 'Ana', emails: [email('ana')] });
    const before = await rows<{ n: number }>(
      sql`select count(*)::int as n from contacts where agency_id = ${a.agencyId}`,
    );
    const refused = await refusal(create(a, { firstName: 'Ana B.', emails: [`  ${email('ANA').toUpperCase()} `] }));
    expect(refused.code).toBe('CONTACT_DUPLICATE');
    expect(refused.details?.matches).toEqual([{ contactId: first.id, on: 'email' }]);
    const after = await rows<{ n: number }>(
      sql`select count(*)::int as n from contacts where agency_id = ${a.agencyId}`,
    );
    expect(after[0]?.n).toBe(before[0]?.n);
  });

  it('[S10-01] creating a contact with an existing phone (written another way) offers merge instead of duplicating', async () => {
    const national = mobile();
    const first = await create(a, { firstName: 'Bea', phones: [national] });
    expect(first.phones).toEqual([`+34${national}`]);
    const refused = await refusal(
      create(a, { firstName: 'Beatriz', phones: [`0034 ${national.slice(0, 3)} ${national.slice(3)}`] }),
    );
    expect(refused).toMatchObject({
      code: 'CONTACT_DUPLICATE',
      details: { matches: [{ contactId: first.id, on: 'phone' }] },
    });
    // the lookup the form uses before submitting finds it too
    const found = await lookup(a, { phones: [`+34 ${national}`] });
    expect(found).toMatchObject({ items: [{ id: first.id }], matches: [{ contactId: first.id, on: 'phone' }] });
  });

  it('[S10-01] accepting the merge adds the new details to the existing contact, never a second contact', async () => {
    const first = await create(a, { firstName: 'Carla', emails: [email('carla')], types: ['BUYER'], tags: ['golf'] });
    const phone = mobile();
    const result = await createResult(a, {
      firstName: 'Carla X',
      lastName: 'Ruiz',
      emails: [email('carla'), email('carla.work')],
      phones: [phone],
      types: ['SELLER'],
      tags: ['beach'],
      consentMarketing: true,
      mergeInto: first.id,
    });
    expect(result.outcome).toBe('MERGED');
    const merged = result.contact;
    expect(merged.id).toBe(first.id);
    expect(merged.firstName).toBe('Carla'); // kept
    expect(merged.lastName).toBe('Ruiz'); // filled
    expect(merged.emails).toEqual([email('carla'), email('carla.work')]);
    expect(merged.phones).toEqual([`+34${phone}`]);
    expect(merged.types).toEqual(['BUYER', 'SELLER']);
    expect(merged.tags).toEqual(['golf', 'beach']);
    expect(merged.consentMarketing).toBe(true); // never chose before: the tick records consent
    expect(merged.consentMarketingAt).not.toBeNull();
    expect(merged.version).toBe(first.version + 1);
    const n = await rows<{ n: number }>(
      sql`select count(*)::int as n from contact_emails where agency_id = ${a.agencyId} and email = ${email('carla')}`,
    );
    expect(n[0]?.n).toBe(1);
    // mergeInto must name a contact the details match
    const other = await create(a, { firstName: 'Dora', emails: [email('dora')] });
    expect((await refusal(create(a, { emails: [email('nobody')], mergeInto: other.id }))).code).toBe(
      'CONTACT_MERGE_INVALID',
    );
  });

  it('[S10-01] a retried create with the same Idempotency-Key answers the first contact', async () => {
    const key = `crm-test-key-${RUN}-0001`;
    const first = await createResult(a, { firstName: 'Idem', emails: [email('idem')] }, { idempotencyKey: key });
    expect(first.outcome).toBe('CREATED');
    const again = await createResult(a, { firstName: 'Idem', emails: [email('idem')] }, { idempotencyKey: key });
    expect(again).toMatchObject({ outcome: 'REPLAYED', contact: { id: first.contact.id } });
    // another member's key is their own
    const other = await refusal(
      as(a, (ctx) =>
        crm.createContact(
          { ...ctx, actor: { kind: 'user', userId: agentId, role: 'AGENT' } },
          CreateContactBody.parse({ emails: [email('idem')] }),
          { idempotencyKey: key },
        ),
      ),
    );
    expect(other.code).toBe('CONTACT_DUPLICATE');
  });

  it('[S10-01] an update that adds another contact’s e-mail is refused; stale versions conflict', async () => {
    const one = await create(a, { firstName: 'Eva', emails: [email('eva')] });
    await create(a, { firstName: 'Fran', emails: [email('fran')] });
    const refused = await refusal(
      as(a, (ctx) => crm.updateContact(ctx, one.id, { version: one.version, emails: [email('eva'), email('fran')] })),
    );
    expect(refused.code).toBe('CONTACT_DUPLICATE');
    const updated = await as(a, (ctx) =>
      crm.updateContact(ctx, one.id, {
        version: one.version,
        emails: [email('eva2'), email('eva3')],
        doNotContact: true,
      }),
    );
    expect(updated).toMatchObject({
      emails: [email('eva2'), email('eva3')],
      doNotContact: true,
      version: one.version + 1,
    });
    // reorder keeps both, the first is primary
    const reordered = await as(a, (ctx) =>
      crm.updateContact(ctx, one.id, { version: updated.version, emails: [email('eva3'), email('eva2')] }),
    );
    expect(reordered.emails).toEqual([email('eva3'), email('eva2')]);
    expect((await lookup(a, { emails: [email('eva3')] })).items[0]?.primaryEmail).toBe(email('eva3'));
    expect(
      (await refusal(as(a, (ctx) => crm.updateContact(ctx, one.id, { version: one.version, firstName: 'X' })))).code,
    ).toBe('VERSION_CONFLICT');
    // the released address is free again
    await create(a, { firstName: 'Eva old', emails: [email('eva')] });
  });

  it('[S10-01] an update costs at most 10 queries', async () => {
    const one = await create(a, { firstName: 'Qc', emails: [email('qc')], phones: [mobile()] });
    const setup = await countQueries(() => as(a, async () => null));
    const n = await countQueries(() =>
      as(a, (ctx) =>
        crm.updateContact(ctx, one.id, {
          version: one.version,
          emails: [email('qc2')],
          phones: [mobile()],
          ownerUserId: agentId,
          consentMarketing: true,
        }),
      ),
    );
    expect(n - setup).toBeLessThanOrEqual(10);
  });

  it('[S10-01] phones that are not valid numbers are refused with their index', async () => {
    const refused = await refusal(create(a, { firstName: 'Gil', phones: [mobile(), '12345'] }));
    expect(refused).toMatchObject({ code: 'CONTACT_PHONE_INVALID', details: { index: 1 } });
  });

  it('[S10-01] the responsible agent must be an active member of the agency', async () => {
    const mine = await create(a, { firstName: 'Own', emails: [email('own')], ownerUserId: agentId });
    expect(mine.ownerUserId).toBe(agentId);
    expect(
      (await refusal(create(a, { firstName: 'Own2', emails: [email('own2')], ownerUserId: b.userId }))).details,
    ).toMatchObject({ field: 'ownerUserId' });
    expect(
      (await refusal(as(a, (ctx) => crm.updateContact(ctx, mine.id, { version: mine.version, ownerUserId: newId() }))))
        .code,
    ).toBe('VALIDATION_FAILED');
  });
});

describe('consent', () => {
  it('[S10-01] a recorded choice is never overturned by a form tick or an import default; a merge keeps the most recent', async () => {
    const withdrawn = await create(a, { firstName: 'Cons', emails: [email('cons')], consentMarketing: true });
    const off = await as(a, (ctx) =>
      crm.updateContact(ctx, withdrawn.id, { version: withdrawn.version, consentMarketing: false }),
    );
    expect(off.consentMarketing).toBe(false);
    // the form's "agrees to marketing" tick on a duplicate does not re-opt-in
    const merged = (await createResult(a, { emails: [email('cons')], consentMarketing: true, mergeInto: withdrawn.id }))
      .contact;
    expect(merged).toMatchObject({ consentMarketing: false, consentMarketingAt: off.consentMarketingAt });

    // merge: the more recent recorded choice wins (the duplicate consented after the survivor withdrew)
    const later = await create(a, { firstName: 'Cons2', emails: [email('cons2')], consentMarketing: true });
    const survivor = await as(a, (ctx) => crm.getContact(ctx, withdrawn.id));
    const result = await as(a, (ctx) =>
      crm.mergeContacts(ctx, survivor.id, { duplicateId: later.id, version: survivor.version }),
    );
    expect(result).toMatchObject({ consentMarketing: true, consentMarketingAt: later.consentMarketingAt });
  });
});

describe('merge', () => {
  it('[S10-01] merge moves leads, activities, tasks and registrations to the surviving contact', async () => {
    // Leads (S10-02) and activities (S10-04) move with the merge; tasks (S10-05) do not exist yet: they plug into the
    // same mechanism — every table in CONTACT_REFERENCES (notes, leads, activities) moves in the merge, and
    // crm.contact.merged is emitted for registrations and other modules (the next test fails when a crm table with
    // contact_id is not registered).
    const survivor = await create(a, {
      firstName: 'Hugo',
      emails: [email('hugo')],
      types: ['BUYER'],
      tags: ['vip'],
    });
    const phone = mobile();
    const duplicate = await create(a, {
      firstName: 'H.',
      lastName: 'Lopez',
      emails: [email('hugo.old')],
      phones: [phone],
      types: ['SELLER'],
      doNotContact: true,
      consentProcessing: true,
    });
    await as(a, (ctx) => crm.addContactNote(ctx, duplicate.id, { body: 'Called about the villa' }));
    await as(a, (ctx) => crm.addContactNote(ctx, survivor.id, { body: 'First visit' }));
    const lead = await as(a, (ctx) => crm.createLead(ctx, CreateLeadBody.parse({ contactId: duplicate.id })));
    expect(lead.lead.contact.id).toBe(duplicate.id);
    const call = await as(a, (ctx) =>
      crm.logActivity(ctx, CreateActivityBody.parse({ type: 'CALL', contactId: duplicate.id, body: 'Wants a pool' })),
    );

    const merged = await as(a, (ctx) =>
      crm.mergeContacts(ctx, survivor.id, { duplicateId: duplicate.id, version: survivor.version }),
    );
    expect(merged).toMatchObject({
      id: survivor.id,
      firstName: 'Hugo',
      lastName: 'Lopez',
      emails: [email('hugo'), email('hugo.old')],
      phones: [`+34${phone}`],
      types: ['BUYER', 'SELLER'],
      tags: ['vip'],
      doNotContact: true,
      consentProcessing: true,
    });
    expect(merged.consentProcessingAt).toBe(duplicate.consentProcessingAt);

    for (const ref of CONTACT_REFERENCES) {
      const left = await rows<{ n: number }>(
        sql`select count(*)::int as n from ${sql.identifier(ref.name)} where contact_id = ${duplicate.id}`,
      );
      expect(left[0]?.n, ref.name).toBe(0);
    }
    const notes = await as(a, (ctx) => crm.listContactNotes(ctx, survivor.id, { limit: 10 }));
    expect(notes.items.map((n) => n.body).sort()).toEqual(['Called about the villa', 'First visit']);
    // the duplicate's lead now belongs to the survivor, at a new version (S10-02)
    const movedLead = await as(a, (ctx) => crm.getLead(ctx, lead.lead.id));
    expect(movedLead.contact.id).toBe(survivor.id);
    expect(movedLead.version).toBe(lead.lead.version + 1);
    // the duplicate's activities (its logged call, its note) are on the survivor's timeline (S10-04)
    const activities = await as(a, (ctx) =>
      crm.listActivities(ctx, ListActivitiesQuery.parse({ subject: 'CONTACT', subjectId: survivor.id })),
    );
    expect(activities.items.map((i) => i.id)).toContain(call.activity.id);
    expect(activities.items.filter((i) => i.type === 'NOTE_ADDED')).toHaveLength(2);
    expect(activities.items.every((i) => i.contactId === survivor.id)).toBe(true);

    const events = await rows<{ payload: { survivorId: string; mergedId: string } }>(
      sql`select payload from outbox_events where type = 'crm.contact.merged' and agency_id = ${a.agencyId}
          and payload->>'mergedId' = ${duplicate.id}`,
    );
    expect(events.map((e) => e.payload)).toEqual([
      { agencyId: a.agencyId, survivorId: survivor.id, mergedId: duplicate.id },
    ]);

    // the duplicate is closed and points at the survivor
    expect((await refusal(as(a, (ctx) => crm.getContact(ctx, duplicate.id)))).code).toBe('CONTACT_NOT_FOUND');
    const [closed] = await rows<{ merged_into_id: string; deleted_at: Date | null }>(
      sql`select merged_into_id, deleted_at from contacts where id = ${duplicate.id}`,
    );
    expect(closed?.merged_into_id).toBe(survivor.id);
    expect(closed?.deleted_at).not.toBeNull();
    // and its old e-mail now finds the survivor
    expect((await lookup(a, { emails: [email('hugo.old')] })).items.map((c) => c.id)).toEqual([survivor.id]);
  });

  it('[S10-01] every crm table with a contact_id column is re-pointed by a merge (CONTACT_REFERENCES)', async () => {
    const crmTables = Object.values(crmSchema)
      .filter((t) => typeof t === 'object' && t !== null && Symbol.for('drizzle:IsDrizzleTable') in t)
      .map((t) => getTableName(t as Parameters<typeof getTableName>[0]));
    const withContact = await rows<{ table_name: string }>(
      sql`select table_name from information_schema.columns where table_schema = 'public' and column_name = 'contact_id'`,
    );
    const moved = new Set<string>([
      ...CONTACT_REFERENCES.map((r) => r.name),
      // identifiers move by their own statement (positions after the survivor's)
      getTableName(contactEmails),
      getTableName(contactPhones),
      // facets are rebuilt from the contacts' arrays (`syncFacets`: the closed contact's go, the survivor's follow)
      getTableName(contactFacets),
    ]);
    const missing = withContact.map((r) => r.table_name).filter((t) => crmTables.includes(t) && !moved.has(t));
    expect(missing).toEqual([]);
  });

  it('[S10-01] a merge costs at most 10 queries, whatever CONTACT_REFERENCES holds', async () => {
    const one = await create(a, { firstName: 'Mq', emails: [email('mq')] });
    const two = await create(a, { firstName: 'Mq2', emails: [email('mq2')], phones: [mobile()] });
    await as(a, (ctx) => crm.addContactNote(ctx, two.id, { body: 'note' }));
    const setup = await countQueries(() => as(a, async () => null));
    const n = await countQueries(() =>
      as(a, (ctx) => crm.mergeContacts(ctx, one.id, { duplicateId: two.id, version: one.version })),
    );
    expect(n - setup).toBeLessThanOrEqual(10);
  });

  it('[S10-01] a merge over the contact limits is refused', async () => {
    const many = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => email(`${prefix}${i}`));
    const one = await create(a, { firstName: 'Lim', emails: many('lim-a', 6) });
    const two = await create(a, { firstName: 'Lim2', emails: many('lim-b', 5) });
    const refused = await refusal(
      as(a, (ctx) => crm.mergeContacts(ctx, one.id, { duplicateId: two.id, version: one.version })),
    );
    expect(refused).toMatchObject({ code: 'CONTACT_MERGE_LIMIT', details: { field: 'emails' } });
  });

  it('[S10-01] a merge into itself, a stale version or another agency’s contact is refused', async () => {
    const one = await create(a, { firstName: 'Ines', emails: [email('ines')] });
    const theirs = await create(b, { firstName: 'Jon', emails: [email('jon')] });
    expect(
      (await refusal(as(a, (ctx) => crm.mergeContacts(ctx, one.id, { duplicateId: one.id, version: 1 })))).code,
    ).toBe('CONTACT_MERGE_INVALID');
    expect(
      (await refusal(as(a, (ctx) => crm.mergeContacts(ctx, one.id, { duplicateId: theirs.id, version: one.version }))))
        .code,
    ).toBe('CONTACT_NOT_FOUND');
    const two = await create(a, { firstName: 'Ines 2', emails: [email('ines2')] });
    expect(
      (await refusal(as(a, (ctx) => crm.mergeContacts(ctx, one.id, { duplicateId: two.id, version: one.version + 5 }))))
        .code,
    ).toBe('VERSION_CONFLICT');
  });
});

describe('isolation and Client Mode', () => {
  it('[S10-01] another agency neither sees a contact nor is told it exists as a duplicate', async () => {
    const mine = await create(a, { firstName: 'Kai', emails: [email('kai')] });
    expect((await refusal(as(b, (ctx) => crm.getContact(ctx, mine.id)))).code).toBe('CONTACT_NOT_FOUND');
    expect((await lookup(b, { emails: [email('kai')] })).items).toEqual([]);
    // the same address is a different contact in another agency
    const theirs = await create(b, { firstName: 'Kai', emails: [email('kai')] });
    expect(theirs.id).not.toBe(mine.id);
  });

  it('[S10-01] Client Mode never shows contacts (owner contacts stay hidden from the client)', async () => {
    const mine = await create(a, { firstName: 'Leo', emails: [email('leo')] });
    const client = <T>(fn: (ctx: Ctx) => Promise<T>) => as(a, (ctx) => fn({ ...ctx, clientMode: true }));
    expect((await refusal(client((ctx) => crm.getContact(ctx, mine.id)))).code).toBe('FORBIDDEN');
    expect((await refusal(client((ctx) => crm.listContacts(ctx, { limit: 10 })))).code).toBe('FORBIDDEN');
    expect((await refusal(client((ctx) => crm.lookupContacts(ctx, { emails: [email('leo')], phones: [] })))).code).toBe(
      'FORBIDDEN',
    );
    expect((await refusal(client((ctx) => crm.listContactNotes(ctx, mine.id, { limit: 10 })))).code).toBe('FORBIDDEN');
  });
});

describe('list', () => {
  it('[S10-01] lists newest first by keyset in one query, filtered by tag and type', async () => {
    const tag = `list-${RUN}`;
    const made: string[] = [];
    for (let i = 0; i < 5; i += 1) made.push((await create(a, { firstName: `M${i}`, tags: [tag] })).id);
    const landlord = await create(a, { firstName: 'P', tags: [tag], types: ['LANDLORD'] });
    made.push(landlord.id);

    const first = await as(a, (ctx) => crm.listContacts(ctx, { limit: 4, tag }));
    expect(first.items.map((c) => c.id)).toEqual(made.slice(-4).reverse());
    expect(first.nextCursor).not.toBeNull();
    const second = await as(a, (ctx) => crm.listContacts(ctx, { limit: 4, tag, cursor: first.nextCursor ?? '' }));
    expect(second.items.map((c) => c.id)).toEqual(made.slice(0, 2).reverse());
    expect(second.nextCursor).toBeNull();
    const landlords = await as(a, (ctx) => crm.listContacts(ctx, { limit: 10, tag, type: 'LANDLORD' }));
    expect(landlords.items.map((c) => c.id)).toEqual([landlord.id]);

    const setup = await countQueries(() => as(a, async () => null)); // the member's ctx (membership, tenant)
    const queries = await countQueries(() => as(a, (ctx) => crm.listContacts(ctx, { limit: 100, tag })));
    expect(queries - setup).toBe(1); // the page
  });

  it('[S10-01] the tag and type filters are index conditions under RLS (contact_facets); so is a deep page cursor (S10-02 review)', async () => {
    // At scale: a 5,000-contact agency among 200 others (25k contacts with their facets; FK checks off in this
    // rolled-back seed), a rare tag and a rare type; analysed, EXPLAINed as app_user (RLS on).
    const plan = await withAdminRollback(['contacts', 'contact_facets'], async (q) => {
      await q('set local session_replication_role = replica');
      await q(
        `insert into contacts (id, agency_id, tags, types, created_at)
         select gen_random_uuid(), $1, array['bulk-' || (g % 50)], array['BUYER'], now() - g * interval '1 minute'
         from generate_series(1, 5000) g`,
        [a.agencyId],
      );
      await q(
        `insert into contacts (id, agency_id, tags, types)
         select gen_random_uuid(), ag.id, array['bulk-' || (g % 50)], array['BUYER']
         from (select gen_random_uuid() as id from generate_series(1, 200)) ag, generate_series(1, 100) g`,
      );
      await q(
        `insert into contact_facets (agency_id, contact_id, facet)
         select agency_id, id, 'tag:' || tags[1] from contacts where tags[1] like 'bulk-%'
         union all select agency_id, id, 'type:BUYER' from contacts where tags[1] like 'bulk-%'
         on conflict do nothing`,
      );
      await q('analyze contacts');
      await q('analyze contact_facets');
      await q(`select set_config('app.agency_id', $1, true)`, [a.agencyId]);
      await q('set local role app_user');
      const out: string[] = [];
      for (const facet of ['tag:vip-rare', 'type:LANDLORD']) {
        const rows = await q(
          `explain select id from contacts
           where agency_id = $1 and deleted_at is null
             and id in (select contact_id from contact_facets where agency_id = $1 and facet = $2)
           order by created_ms desc, id desc limit 26`,
          [a.agencyId, facet],
        );
        out.push(rows.map((r) => String(Object.values(r)[0])).join('\n'));
      }
      // S10-02 review: a deep page of the plain list — the cursor is a row comparison on the stored `created_ms`
      const deep = await q(
        `explain select id from contacts where agency_id = $1 and deleted_at is null
           and (created_ms, id) < (now() - interval '2500 minutes', 'ffffffff-ffff-7fff-bfff-ffffffffffff'::uuid)
         order by created_ms desc, id desc limit 26`,
        [a.agencyId],
      );
      return { facets: out, deep: deep.map((r) => String(Object.values(r)[0])).join('\n') };
    });
    for (const text of plan.facets) {
      expect(text).toContain('contact_facets_agency_facet_idx');
      expect(text).not.toMatch(/Seq Scan/);
    }
    expect(plan.deep).toContain('contacts_agency_created_idx');
    expect(plan.deep).toMatch(/Index Cond: .*ROW\(created_ms, id\) </);
    expect(plan.deep).not.toMatch(/Filter: .*created_ms/);
  });
});

describe('CSV import', () => {
  const csv = (lines: string[]) => new TextEncoder().encode(`${lines.join('\n')}\n`);
  const runner =
    (m: Founder) =>
    <T>(fn: (ctx: Ctx) => Promise<T>) =>
      as(m, fn);
  const start = (id: string, body: Parameters<typeof StartContactImportBody.parse>[0]) =>
    as(a, (ctx) => crm.startContactImport(ctx, id, StartContactImportBody.parse(body)));

  it('[S10-01] imports a CSV with a mapping: creates contacts, skips duplicates, reports bad rows without values', async () => {
    const existing = await create(a, { firstName: 'Old', emails: [email('imp.old')] });
    const p1 = mobile();
    const file = csv([
      'Nombre,Apellidos,Email,Teléfono,Tipo,Etiquetas,Notas',
      `Nuria,Sanz,${email('imp.nuria')},${p1},comprador,feria;golf,Wants a sea view`,
      `Nuria again,,${email('imp.nuria.2')},${p1},,,`, // same phone as the row above: one contact
      `Oscar,,${email('imp.old')},,vendedor,,`, // an existing contact: skipped
      `,,not-an-email,,,,`,
      `,,,,,vip,`, // no name, e-mail or phone
      `Pia,,,+44 20 7946 0958,tenant,,`,
    ]);
    const upload = await crm.uploadContactImport(runner(a), file);
    expect(upload.headers[0]).toBe('Nombre');
    expect(upload.rows).toHaveLength(5);
    expect(upload.suggested).toMatchObject({
      firstName: 0,
      lastName: 1,
      emails: [2],
      phones: [3],
      types: 4,
      tags: 5,
      note: 6,
    });

    const started = await start(upload.id, {
      mapping: { firstName: 0, lastName: 1, emails: [2], phones: [3], types: 4, tags: 5, note: 6 },
      tags: ['import-test'],
    });
    expect(started.status).toBe('QUEUED');
    const queued = await rows<{ n: number }>(
      sql`select count(*)::int as n from outbox_events where type = 'crm.import.requested' and payload->>'importId' = ${upload.id}`,
    );
    expect(queued[0]?.n).toBe(1);

    expect(await runContactImport({ agencyId: a.agencyId, importId: upload.id }, job())).toEqual({
      status: 'SUCCEEDED',
    });
    const done = await as(a, (ctx) => crm.getContactImport(ctx, upload.id));
    expect(done).toMatchObject({
      status: 'SUCCEEDED',
      createdCount: 2,
      mergedCount: 0,
      skippedCount: 2,
      invalidCount: 2,
    });
    expect(done.errors).toEqual([
      { row: 5, code: 'INVALID_EMAIL' },
      { row: 6, code: 'NO_IDENTITY' },
    ]);
    expect(JSON.stringify(done)).not.toContain('not-an-email');

    const nuria = await lookup(a, { emails: [email('imp.nuria')] });
    const contact = await as(a, (ctx) => crm.getContact(ctx, nuria.items[0]?.id ?? ''));
    expect(contact).toMatchObject({
      firstName: 'Nuria',
      lastName: 'Sanz',
      emails: [email('imp.nuria')],
      phones: [`+34${p1}`],
      types: ['BUYER'],
      tags: ['import-test', 'feria', 'golf'],
      source: 'IMPORT',
    });
    const notes = await as(a, (ctx) => crm.listContactNotes(ctx, contact.id, { limit: 5 }));
    expect(notes.items.map((n) => n.body)).toEqual(['Wants a sea view']);
    expect((await lookup(a, { phones: ['+442079460958'] })).items).toHaveLength(1);
    // the existing contact was not changed in SKIP mode
    expect((await as(a, (ctx) => crm.getContact(ctx, existing.id))).version).toBe(existing.version);

    // the file is gone (and recorded so); a second run of the same job does nothing
    expect(await store.get('private', contactImportKey(a.agencyId, upload.id), { maxBytes: 1_000_000 })).toBeNull();
    const [state] = await rows<{ file_deleted_at: Date | null }>(
      sql`select file_deleted_at from contact_imports where id = ${upload.id}`,
    );
    expect(state?.file_deleted_at).not.toBeNull();
    expect(await runContactImport({ agencyId: a.agencyId, importId: upload.id }, job())).toEqual({ status: 'SKIPPED' });
    expect((await refusal(start(upload.id, { mapping: { emails: [2] } }))).code).toBe('CONTACT_IMPORT_STARTED');
  });

  it('[S10-01] MERGE mode adds a row’s new details to the contact it matches, never overturning a consent choice', async () => {
    const existing = await create(a, { firstName: 'Quim', emails: [email('imp.quim')], tags: ['old'] });
    // the contact withdrew processing consent: the import's "consent collected" default must not re-record it
    const withdrawn = await as(a, (ctx) =>
      crm.updateContact(ctx, existing.id, { version: existing.version, consentProcessing: true }),
    );
    const off = await as(a, (ctx) =>
      crm.updateContact(ctx, existing.id, { version: withdrawn.version, consentProcessing: false }),
    );
    const phone = mobile();
    const upload = await crm.uploadContactImport(
      runner(a),
      csv(['email,phone,name,tags,newsletter', `${email('imp.quim')},${phone},Quim Full,new,yes`]),
    );
    await start(upload.id, {
      mapping: { emails: [0], phones: [1], fullName: 2, tags: 3, consentMarketing: 4 },
      onDuplicate: 'MERGE',
      consentProcessing: true,
    });
    await runContactImport({ agencyId: a.agencyId, importId: upload.id }, job());
    const done = await as(a, (ctx) => crm.getContactImport(ctx, upload.id));
    expect(done).toMatchObject({ status: 'SUCCEEDED', createdCount: 0, mergedCount: 1 });
    const after = await as(a, (ctx) => crm.getContact(ctx, existing.id));
    expect(after).toMatchObject({
      firstName: 'Quim',
      lastName: 'Full',
      phones: [`+34${phone}`],
      tags: ['old', 'new'],
      consentProcessing: false,
      consentProcessingAt: off.consentProcessingAt,
      consentMarketing: true, // never chose: the row's "yes" records it
      version: off.version + 1,
    });
    const [event] = await rows<{ version: number }>(
      sql`select (payload->>'version')::int as version from outbox_events where type = 'crm.contact.updated'
          and payload->>'contactId' = ${existing.id} order by id desc limit 1`,
    );
    expect(event?.version).toBe(after.version);
  });

  it('[S10-01] a retried run resumes after its checkpoint and never imports a row twice', async () => {
    const upload = await crm.uploadContactImport(
      runner(a),
      csv(['email', email('res1'), email('res2'), email('res3'), email('res4')]),
    );
    await start(upload.id, { mapping: { emails: [0] } });
    // an earlier attempt imported the first two rows, then died (RUNNING, checkpoint 2)
    await withTenant({ agencyId: a.agencyId }, (tx) =>
      importBatch(
        tx,
        { agencyId: a.agencyId, importId: upload.id, onDuplicate: 'SKIP', processedRows: 0 },
        StartContactImportBody.omit({ onDuplicate: true }).parse({ mapping: { emails: [0] } }),
        [
          { row: 2, cells: [email('res1')] },
          { row: 3, cells: [email('res2')] },
        ],
      ),
    );
    await system((tx) => tx.execute(sql`update contact_imports set status = 'RUNNING' where id = ${upload.id}`));
    await runContactImport({ agencyId: a.agencyId, importId: upload.id }, job());
    const done = await as(a, (ctx) => crm.getContactImport(ctx, upload.id));
    expect(done).toMatchObject({ status: 'SUCCEEDED', totalRows: 4, createdCount: 4, skippedCount: 0 });
    const found = await lookup(a, { emails: [email('res1'), email('res2'), email('res3'), email('res4')] });
    expect(found.items).toHaveLength(4);
  });

  it('[S10-01] an identifier another writer takes during a batch is left out and reported (DUPLICATE_RACE)', async () => {
    const racedEmail = email('race');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held!: () => void;
    const holding = new Promise<void>((resolve) => {
      held = resolve;
    });
    // another writer holds the address in an open transaction while the batch looks it up (and does not see it)
    const holder = system(async (tx) => {
      const id = newId();
      await tx.execute(sql`insert into contacts (id, agency_id, first_name) values (${id}, ${a.agencyId}, 'Other')`);
      await tx.execute(sql`insert into contact_emails (id, agency_id, contact_id, email)
        values (${newId()}, ${a.agencyId}, ${id}, ${racedEmail})`);
      held();
      await gate;
    });
    await holding;
    const batch = withTenant({ agencyId: a.agencyId }, (tx) =>
      importBatch(
        tx,
        { agencyId: a.agencyId, importId: newId(), onDuplicate: 'SKIP', processedRows: 0 },
        StartContactImportBody.omit({ onDuplicate: true }).parse({ mapping: { firstName: 0, emails: [1] } }),
        [
          { row: 2, cells: ['Racer', racedEmail] },
          { row: 3, cells: ['Calm', email('calm')] },
        ],
      ),
    );
    await pause(300); // the batch's insert now waits on the holder's row
    release();
    await holder;
    const out = await batch;
    expect(out.created).toBe(2);
    expect(out.errors).toEqual([{ row: 2, code: 'DUPLICATE_RACE' }]);
  });

  it('[S10-01] only admins import; a file that is not a sheet is refused; idle uploads expire', async () => {
    const agent = <T>(fn: (ctx: Ctx) => Promise<T>) =>
      as(a, (ctx) =>
        fn({ ...ctx, actor: { ...(ctx.actor as { kind: 'user'; userId: string; role: string }), role: 'AGENT' } }),
      );
    expect((await refusal(crm.uploadContactImport(agent, csv(['email', 'x@example.com'])))).code).toBe('FORBIDDEN');
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0x01, 0x02]);
    expect((await refusal(crm.uploadContactImport(runner(a), pdf))).code).toBe('CONTACT_IMPORT_FILE_INVALID');

    const idle = await crm.uploadContactImport(runner(a), csv(['email', email('idle')]));
    const result = await sweepContactImports({ now: new Date(Date.now() + 25 * 3_600_000) });
    expect(result.expired).toBeGreaterThanOrEqual(1);
    expect((await as(a, (ctx) => crm.getContactImport(ctx, idle.id))).status).toBe('EXPIRED');
    expect(await store.get('private', contactImportKey(a.agencyId, idle.id), { maxBytes: 1_000_000 })).toBeNull();
    // b cannot read a's import
    expect((await refusal(as(b, (ctx) => crm.getContactImport(ctx, idle.id)))).code).toBe('CONTACT_IMPORT_NOT_FOUND');
  });

  it('[S10-01] the sweep deletes a finished run’s file when the run’s own delete failed', async () => {
    const upload = await crm.uploadContactImport(runner(a), csv(['email', email('left')]));
    await start(upload.id, { mapping: { emails: [0] } });
    await runContactImport({ agencyId: a.agencyId, importId: upload.id }, job());
    // the run's delete "failed": the file is back and file_deleted_at null
    const key = contactImportKey(a.agencyId, upload.id);
    await store.put('private', key, csv(['email', email('left')]), { contentType: 'text/csv' });
    await system((tx) => tx.execute(sql`update contact_imports set file_deleted_at = null where id = ${upload.id}`));

    const result = await sweepContactImports({ now: new Date(Date.now() + 2 * 3_600_000) });
    expect(result.filesDeleted).toBeGreaterThanOrEqual(1);
    expect(await store.get('private', key, { maxBytes: 1_000_000 })).toBeNull();
    const [state] = await rows<{ status: string; file_deleted_at: Date | null }>(
      sql`select status, file_deleted_at from contact_imports where id = ${upload.id}`,
    );
    expect(state).toMatchObject({ status: 'SUCCEEDED' });
    expect(state?.file_deleted_at).not.toBeNull();
  });
});
