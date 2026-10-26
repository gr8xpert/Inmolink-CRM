/**
 * Legacy contacts and leads (S14-02, PLAN §14, ADR 0006): one batch of a legacy agency's contacts or leads, written in a
 * fixed number of statements whatever its size. The caller is the operator's load script (`withSystem()`): no member
 * acts, so no policy check and no plan quota (the agency's CRM moves as it is).
 *
 * Contacts: a legacy contact already loaded (its map, `knownId`) is kept as it stands now — v2 is authoritative once
 * migrated (a merged one resolves to its survivor). Otherwise a contact of the agency owning one of its e-mails or phones
 * (one the website created during the parallel run) takes it in; else a new contact is created with its identifiers,
 * note and legacy creation time, and `crm.contact.created` (as a CSV import's).
 *
 * Leads: historical records. A new lead keeps its legacy creation time, stands in the agency's first stage of its
 * status and emits no event — a migrated enquiry must not notify an agent, acknowledge a visitor or count as received
 * today; the caller rebuilds the report rollups afterwards (`rebuildReportRollups`).
 */
import type { ContactType, LeadSource, LeadStatus } from '@inmolink/contracts';
import type { Tx } from '@inmolink/db';
import { newId } from '@inmolink/platform/ids';
import { emit } from '@inmolink/platform/outbox';
import { crmEvents } from './events';
import * as legacyRepo from './legacy-repo';
import { distinct, normalizeEmail, normalizePhone } from './normalize';
import { placement } from './pipeline';
import * as pipelineRepo from './pipeline-repo';
import * as repo from './repo';

export type LegacyOutcome = 'created' | 'unchanged';

export interface LegacyContactInput {
  legacyId: string;
  /** The contact this legacy contact became in an earlier run (`legacy_id_maps`). */
  knownId: string | null;
  firstName: string | null;
  lastName: string | null;
  /** Raw values: normalized here; an invalid one is reported and left out. */
  emails: readonly string[];
  phones: readonly string[];
  language: string | null;
  types: readonly ContactType[];
  ownerUserId: string | null;
  consentMarketing: boolean;
  note: string | null;
  createdAt: Date | null;
}

export interface LegacyContactsResult {
  contacts: Map<string, { id: string; outcome: LegacyOutcome }>;
  /** Identifiers left out (not an e-mail / phone number), per legacy contact. */
  invalidIdentifiers: { legacyId: string; value: string }[];
}

/** Phone numbers without an international prefix are Spanish (the legacy agencies are). */
const PHONE_COUNTRY = 'ES';

export async function importLegacyContacts(
  tx: Tx,
  agencyId: string,
  inputs: readonly LegacyContactInput[],
): Promise<LegacyContactsResult> {
  const out: LegacyContactsResult = { contacts: new Map(), invalidIdentifiers: [] };
  const states = new Map(
    (
      await legacyRepo.contactStates(
        tx,
        agencyId,
        inputs.flatMap((i) => (i.knownId ? [i.knownId] : [])),
      )
    ).map((s) => [s.id, s]),
  );
  const normalized = inputs.map((i) => {
    const emails: string[] = [];
    const phones: string[] = [];
    for (const raw of i.emails) {
      const e = normalizeEmail(raw);
      if (e) emails.push(e);
      else out.invalidIdentifiers.push({ legacyId: i.legacyId, value: raw });
    }
    for (const raw of i.phones) {
      const p = normalizePhone(raw, PHONE_COUNTRY);
      if (p) phones.push(p);
      else out.invalidIdentifiers.push({ legacyId: i.legacyId, value: raw });
    }
    return { input: i, emails: distinct(emails), phones: distinct(phones) };
  });
  const todo = normalized.filter((n) => {
    const known = n.input.knownId ? states.get(n.input.knownId) : undefined;
    if (!known) return true;
    out.contacts.set(n.input.legacyId, { id: known.mergedIntoId ?? known.id, outcome: 'unchanged' });
    return false;
  });
  const owners = await repo.identifierOwners(
    tx,
    agencyId,
    distinct(todo.flatMap((n) => n.emails)),
    distinct(todo.flatMap((n) => n.phones)),
  );
  const claimed = new Map<string, string>(
    owners.map((o) => [`${o.on === 'email' ? 'e' : 'p'}:${o.value}`, o.contactId]),
  );
  const created: legacyRepo.LegacyContactInsert[] = [];
  const emails: repo.NewIdentifier[] = [];
  const phones: repo.NewIdentifier[] = [];
  const notes: { agencyId: string; contactId: string; authorUserId: null; body: string }[] = [];
  for (const n of todo) {
    const keys = [...n.emails.map((e) => `e:${e}`), ...n.phones.map((p) => `p:${p}`)];
    const match = keys.map((k) => claimed.get(k)).find((c) => c !== undefined);
    if (match) {
      out.contacts.set(n.input.legacyId, { id: match, outcome: 'unchanged' });
      continue;
    }
    const id = newId();
    for (const k of keys) claimed.set(k, id);
    const i = n.input;
    const at = i.createdAt ?? new Date();
    created.push({
      id,
      agencyId,
      ownerUserId: i.ownerUserId,
      types: [...i.types],
      firstName: i.firstName,
      lastName: i.lastName,
      language: i.language,
      source: 'IMPORT',
      consentMarketing: i.consentMarketing,
      consentMarketingAt: i.consentMarketing ? at : null,
      createdAt: at,
    });
    n.emails.forEach((value, position) => {
      emails.push({ contactId: id, value, position });
    });
    n.phones.forEach((value, position) => {
      phones.push({ contactId: id, value, position });
    });
    if (i.note) notes.push({ agencyId, contactId: id, authorUserId: null, body: i.note });
    out.contacts.set(i.legacyId, { id, outcome: 'created' });
  }
  if (created.length === 0) return out;
  const ids = created.map((c) => c.id);
  await legacyRepo.insertLegacyContacts(tx, created);
  await repo.insertIdentifiers(tx, agencyId, emails, phones);
  await repo.insertNotes(tx, notes);
  await repo.refreshPrimaries(tx, agencyId, ids);
  await repo.syncFacets(tx, agencyId, ids);
  await emit(
    tx,
    ids.map((contactId) => crmEvents.contactCreated({ agencyId, contactId, source: 'IMPORT' })),
  );
  return out;
}

export interface LegacyLeadInput {
  legacyId: string;
  /** The lead this legacy lead became in an earlier run (`legacy_id_maps`). */
  knownId: string | null;
  contactId: string;
  source: LeadSource;
  status: LeadStatus;
  message: string | null;
  locale: string | null;
  /** A member of the agency, or null. */
  assignedUserId: string | null;
  /** The agency's own listing, development or unit the enquiry was about. */
  target: { kind: 'LISTING' | 'DEVELOPMENT' | 'UNIT'; id: string; shownRef: string | null } | null;
  createdAt: Date | null;
}

export interface LegacyLeadsResult {
  leads: Map<string, { id: string; outcome: LegacyOutcome }>;
}

export async function importLegacyLeads(
  tx: Tx,
  agencyId: string,
  inputs: readonly LegacyLeadInput[],
): Promise<LegacyLeadsResult> {
  const out: LegacyLeadsResult = { leads: new Map() };
  const existing = await legacyRepo.existingLeads(
    tx,
    agencyId,
    inputs.flatMap((i) => (i.knownId ? [i.knownId] : [])),
  );
  const todo: LegacyLeadInput[] = [];
  for (const i of inputs) {
    if (i.knownId && existing.has(i.knownId)) out.leads.set(i.legacyId, { id: i.knownId, outcome: 'unchanged' });
    else todo.push(i);
  }
  if (todo.length === 0) return out;
  // The agency's stages (seeded when it has none): a lead stands in the first active stage of its status.
  await pipelineRepo.seedStages(tx, agencyId);
  const stageOf = new Map<string, string>();
  for (const s of await pipelineRepo.listStages(tx, agencyId)) if (!stageOf.has(s.status)) stageOf.set(s.status, s.id);
  const rows: legacyRepo.LegacyLeadInsert[] = [];
  for (const i of todo) {
    const id = i.knownId ?? newId();
    const at = i.createdAt ?? new Date();
    const stageId = stageOf.get(i.status) ?? stageOf.get('NEW');
    if (!stageId) throw new Error('the agency has no pipeline stage');
    const status = stageOf.has(i.status) ? i.status : 'NEW';
    rows.push({
      id,
      agencyId,
      contactId: i.contactId,
      source: i.source,
      kind: 'ENQUIRY',
      status,
      stageId,
      ...placement(id, at),
      targetKind: i.target?.kind ?? null,
      targetId: i.target?.id ?? null,
      shownRef: i.target?.shownRef ?? null,
      message: i.message,
      locale: i.locale,
      assignedUserId: i.assignedUserId,
      assignedAt: i.assignedUserId ? at : null,
      createdAt: at,
    });
    out.leads.set(i.legacyId, { id, outcome: 'created' });
  }
  await legacyRepo.insertLegacyLeads(tx, rows);
  return out;
}
