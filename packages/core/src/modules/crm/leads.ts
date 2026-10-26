import {
  AppError,
  CONTACT_LIMITS,
  type CreateLeadBody,
  DEFAULT_PHONE_COUNTRY,
  type LeadDto,
  type LeadIntroductionDto,
  type LeadIntroductionPage,
  type LeadKind,
  type LeadListItemDto,
  type LeadPage,
  type LeadRoutingDto,
  type LeadSource,
  type LeadStatus,
  type LeadTargetKind,
  type ListLeadsQuery,
  type PageQuery,
  type UpdateLeadBody,
  type UpdateLeadRoutingBody,
} from '@inmolink/contracts';
import { type Tx, withTenant } from '@inmolink/db';
import { newId } from '@inmolink/platform/ids';
import { emit } from '@inmolink/platform/outbox';
import { type Ctx, userIdOf } from '../../context';
import { idempotencyOf, keyReusedOn, replayOf } from '../../idempotency';
import { decodeCursor, toPage } from '../../pagination';
import * as agencies from '../agencies';
import * as billing from '../billing';
import * as developments from '../developments';
import * as identity from '../identity';
import * as properties from '../properties';
import * as websites from '../websites';
import { auditImpersonatedRead } from './audit';
import { crmEvents } from './events';
import * as leadsRepo from './leads-repo';
import { linkedListing } from './listing-ref';
import { distinct, normalizeEmail, normalizePhone } from './normalize';
import { placement, stageForStatus } from './pipeline';
import * as pipelineRepo from './pipeline-repo';
import { assertCan } from './policy';
import * as repo from './repo';
import { humanResponseOf } from './response';
import { routeLead } from './routing';

/**
 * Leads, routing and inbox (S10-02, PLAN §3 #12, §7 M8). Every lead — promoted from a website form, entered by hand,
 * later from portals, selections and the chatbot — goes through `receiveLead`: routed by source (`routing.ts`), assigned
 * by the holder's rule, written with its introduction (when the target is another agency's) and `crm.lead.created`, in
 * the holder's transaction. Leads and their clients are PII: nothing here logs a value.
 */

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** Members considered by the round robin (the agency's active members who work clients). */
const ROUND_ROBIN_MEMBERS = 500;

function toListItem(row: leadsRepo.LeadListRow): LeadListItemDto {
  return {
    id: row.id,
    source: row.source as LeadSource,
    kind: row.kind as LeadKind,
    status: row.status as LeadStatus,
    stageId: row.stageId,
    contact: {
      id: row.contactId,
      firstName: row.contactFirstName,
      lastName: row.contactLastName,
      primaryEmail: row.contactEmail,
      primaryPhone: row.contactPhone,
    },
    presentingAgencyId: row.presentingAgencyId,
    ownerAgencyId: row.ownerAgencyId,
    target:
      row.targetKind && row.targetId
        ? { kind: row.targetKind as LeadTargetKind, id: row.targetId, shownRef: row.shownRef }
        : null,
    locale: row.locale,
    assignedUserId: row.assignedUserId,
    assignedAt: iso(row.assignedAt),
    firstRespondedAt: iso(row.firstRespondedAt),
    createdAt: row.createdAt.toISOString(),
  };
}

function toLeadDto(row: leadsRepo.LeadRow): LeadDto {
  const hasVisitor = row.visitorName !== null || row.visitorEmail !== null || row.visitorPhone !== null;
  return {
    ...toListItem(row),
    message: row.message,
    visitor: hasVisitor
      ? {
          name: row.visitorName,
          email: row.visitorEmail,
          phone: row.visitorPhone,
          marketingConsent: row.visitorMarketingConsent ?? false,
        }
      : null,
    inboundLeadId: row.inboundLeadId,
    createdBy: row.createdBy,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---- assignment -----------------------------------------------------------------------------------------------------

/**
 * The member the holder's rule (`rule`, read unlocked with the entry stage) assigns a new lead to, or null
 * (`UNASSIGNED`, no rule, nobody in the pool). ≤ 3 statements; only a round-robin turn locks the rule's row (until the transaction ends), so concurrent leads take turns
 * and leads of an `UNASSIGNED` agency never wait on each other.
 *
 * - `OWNER_AGENT`: the target listing's responsible agent when the holder owns it and they are an active member;
 *   otherwise the round robin.
 * - `ROUND_ROBIN`: the next member after the last one assigned, in user-id order, among the pool (`agent_user_ids`, or
 *   every active member who works clients) — members deactivated since are skipped.
 */
async function pickAssignee(
  tx: Tx,
  agencyId: string,
  listingAgentId: string | null,
  rule: leadsRepo.RoutingRow | null,
): Promise<string | null> {
  if (!rule || rule.mode === 'UNASSIGNED') return null;
  const active = await identity.activeClientMemberIds(tx, agencyId, ROUND_ROBIN_MEMBERS);
  if (rule.mode === 'OWNER_AGENT' && listingAgentId && active.includes(listingAgentId)) return listingAgentId;
  // a round-robin turn: re-read the rule under its row lock (the position another lead may just have moved)
  const locked = await leadsRepo.getRouting(tx, agencyId, { forUpdate: true });
  if (!locked || locked.mode === 'UNASSIGNED') return null;
  const wanted = new Set(locked.agentUserIds);
  const pool = locked.agentUserIds.length > 0 ? active.filter((id) => wanted.has(id)) : active;
  if (pool.length === 0) return null;
  const last = locked.lastAssignedUserId;
  const next = (last ? pool.find((id) => id > last) : undefined) ?? (pool[0] as string);
  await leadsRepo.setLastAssigned(tx, agencyId, next);
  return next;
}

// ---- receiving a lead (every channel) -------------------------------------------------------------------------------

/** The details a client gave through a channel (form fields), kept on the lead as given. */
export interface Visitor {
  name: string | null;
  email: string | null;
  phone: string | null;
  marketingConsent: boolean;
}

export interface IncomingLead {
  source: LeadSource;
  kind: LeadKind;
  contactId: string;
  /** The agency whose channel the client used; null: the owner's own channel (marketplace). */
  presentingAgencyId: string | null;
  target: { kind: LeadTargetKind; id: string; ownerAgencyId: string | null; shownRef: string | null } | null;
  /** The responsible agent of the target listing, when the holder owns it (`OWNER_AGENT`). */
  listingAgentId: string | null;
  message: string | null;
  locale: string | null;
  visitor: Visitor | null;
  inboundLeadId: string | null;
  /** The member who entered it by hand; null for a lead a channel delivered. */
  createdBy: string | null;
  idempotency: { hash: string; requestHash: string } | null;
  /** A member chosen by hand (`null`: leave it unassigned); `undefined`: the holder's rule decides. */
  assignedUserId?: string | null;
  /** When the website lead's automatic acknowledgement went out, when it already had (S10-09). */
  autoAckSentAt?: Date | null;
}

/** The lead as written (its own columns; the caller adds the contact summary for an answer). */
export type ReceivedLead = Omit<
  leadsRepo.LeadRow,
  'contactFirstName' | 'contactLastName' | 'contactEmail' | 'contactPhone'
>;

/**
 * Writes a lead in the holder's transaction (`tx` pinned to the holder by RLS): the route by source, the assignment,
 * the lead, the owner's introduction when the target is another agency's, and `crm.lead.created` — 3 statements plus
 * the assignment (≤ 4). The caller has checked that it is the holder (`routeLead`).
 */
export async function receiveLead(tx: Tx, holderAgencyId: string, lead: IncomingLead): Promise<ReceivedLead> {
  const route = routeLead({
    source: lead.source,
    presentingAgencyId: lead.presentingAgencyId,
    ownerAgencyId: lead.target?.ownerAgencyId ?? null,
  });
  if (route.holderAgencyId !== holderAgencyId) throw new AppError('FORBIDDEN');
  // S10-03: every lead starts in the holder's entry stage (seeded on its first lead), newest first in its column; the
  // same statement reads the assignment rule
  const start = await leadsRepo.entryStageAndRule(tx, holderAgencyId);
  const stageId = start.stageId ?? (await pipelineRepo.stageForStatus(tx, holderAgencyId, 'NEW'))?.id;
  if (!stageId) throw new AppError('INTERNAL', { reason: 'no_entry_stage' });
  const assignedUserId =
    lead.assignedUserId !== undefined
      ? lead.assignedUserId
      : await pickAssignee(tx, holderAgencyId, lead.listingAgentId, start.rule);
  const id = newId();
  const values = {
    id,
    agencyId: holderAgencyId,
    contactId: lead.contactId,
    source: lead.source,
    kind: lead.kind,
    status: 'NEW',
    stageId,
    ...placement(id, new Date()),
    presentingAgencyId: lead.presentingAgencyId,
    ownerAgencyId: route.introducedAgencyId,
    targetKind: lead.target?.kind ?? null,
    targetId: lead.target?.id ?? null,
    shownRef: lead.target ? lead.target.shownRef : null,
    inboundLeadId: lead.inboundLeadId,
    message: lead.message,
    locale: lead.locale,
    visitorName: lead.visitor?.name ?? null,
    visitorEmail: lead.visitor?.email ?? null,
    visitorPhone: lead.visitor?.phone ?? null,
    visitorMarketingConsent: lead.visitor ? lead.visitor.marketingConsent : null,
    assignedUserId,
    assignedAt: assignedUserId ? new Date() : null,
    firstRespondedAt: null,
    autoAckSentAt: lead.autoAckSentAt ?? null,
    createdBy: lead.createdBy,
    idempotencyHash: lead.idempotency?.hash ?? null,
    requestHash: lead.idempotency?.requestHash ?? null,
  };
  const written = await leadsRepo.insertLead(tx, values);
  if (route.introducedAgencyId && lead.target) {
    await leadsRepo.insertIntroduction(tx, {
      leadId: id,
      agencyId: holderAgencyId,
      ownerAgencyId: route.introducedAgencyId,
      source: lead.source,
      kind: lead.kind,
      targetKind: lead.target.kind,
      targetId: lead.target.id,
      handEntered: lead.createdBy !== null,
    });
  }
  await emit(
    tx,
    crmEvents.leadCreated({
      agencyId: holderAgencyId,
      leadId: id,
      source: lead.source,
      inboundLeadId: lead.inboundLeadId,
      assignedUserId,
      assignedBy: lead.createdBy,
      version: written.version,
      receivedMs: written.createdMs.getTime(),
    }),
  );
  return { ...values, ...written };
}

/** A `ContactLanguage` from a site locale (`en`, `es`, `pt-BR`), or null. */
const languageOf = (locale: string): string | null => (/^[a-z]{2}(-[A-Z]{2})?$/.test(locale) ? locale : null);

/**
 * The website visitor as a contact of the presenting agency: the contact owning the e-mail (else the phone) as it is —
 * an inbound form never rewrites a contact's name, identifiers or consent (S10-02 review: anyone can type anyone's
 * address); the form's details stay on the lead (`visitor_*`) for the agent to compare. Otherwise a new contact is
 * created from them (source `WEBSITE`, type `BUYER`). Identifiers another writer takes meanwhile fail the transaction;
 * the job's retry then finds that contact.
 * S13-F21: exempt from the plan's contact quota (`crm_contacts`, Free 100) by design — an inbound website or portal
 * lead is never refused or lost because of the agency's plan; only member creates and CSV imports are counted.
 */
async function contactForVisitor(tx: Tx, agencyId: string, visitor: websites.LeadRow): Promise<string> {
  // S15-02: a visitor from the public portal (no site) is a portal contact
  const source = visitor.siteId === null ? 'PORTAL' : 'WEBSITE';
  const email = normalizeEmail(visitor.email);
  const phone = visitor.phone ? normalizePhone(visitor.phone, DEFAULT_PHONE_COUNTRY) : null;
  const owners = await repo.identifierOwners(tx, agencyId, email ? [email] : [], phone ? [phone] : []);
  const match = owners.find((o) => o.on === 'email') ?? owners[0];
  if (match) return match.contactId;

  const id = newId();
  const now = new Date();
  await repo.insertContacts(tx, [
    {
      id,
      agencyId,
      ownerUserId: null,
      types: ['BUYER'],
      firstName: visitor.name.trim().slice(0, CONTACT_LIMITS.nameChars) || null,
      lastName: null,
      primaryEmail: email,
      primaryPhone: phone,
      language: languageOf(visitor.locale),
      source,
      tags: [],
      consentMarketing: visitor.marketingConsent,
      consentMarketingAt: visitor.marketingConsent ? now : null,
      consentProcessing: false,
      consentProcessingAt: null,
      doNotContact: false,
      idempotencyHash: null,
    },
  ]);
  await repo.insertIdentifiers(
    tx,
    agencyId,
    email ? [{ contactId: id, value: email, position: 0 }] : [],
    phone ? [{ contactId: id, value: phone, position: 0 }] : [],
  );
  await repo.syncFacets(tx, agencyId, [id]);
  await emit(tx, crmEvents.contactCreated({ agencyId, contactId: id, source }));
  return id;
}

/**
 * The `crm.promoteInboundLead` job (on `websites.lead.received`): the website lead becomes a lead in the presenting
 * agency's inbox (PLAN §3 #12: agency website → presenting agency), its visitor a contact, assigned by the agency's
 * rule — in one transaction as that agency (RLS). Idempotent per inbound lead: the promotion is serialized on the
 * inbound id and `leads_inbound_uq` holds one lead per inbound lead, so a redelivered event changes nothing.
 * S15-02: a portal lead (no site) is a `MARKETPLACE` lead of the listing's owner (§3 #12: marketplace → the listing
 * owner), with no presenting agency — the inbound row already belongs to the owner.
 */
export async function promoteInboundLead(p: {
  agencyId: string;
  inboundLeadId: string;
}): Promise<{ leadId: string | null; created: boolean }> {
  return withTenant({ agencyId: p.agencyId }, async (tx) => {
    await leadsRepo.lockInbound(tx, p.inboundLeadId);
    const existing = await leadsRepo.leadIdByInbound(tx, p.agencyId, p.inboundLeadId);
    if (existing) return { leadId: existing, created: false };
    const form = await websites.inboundLead(tx, p.inboundLeadId);
    if (!form || form.agencyId !== p.agencyId) return { leadId: null, created: false };

    const contactId = await contactForVisitor(tx, p.agencyId, form);
    const marketplace = form.siteId === null;
    const target =
      form.targetKind && form.targetId
        ? {
            kind: form.targetKind as LeadTargetKind,
            id: form.targetId,
            // routing reads the owner: a marketplace lead's owner is this agency (the lead stores no introduction)
            ownerAgencyId: marketplace ? p.agencyId : form.ownerAgencyId,
            shownRef: form.shownRef,
          }
        : null;
    // the responsible agent of the agency's own listing (OWNER_AGENT); a network listing's agent is not ours
    const listingAgentId =
      target?.kind === 'LISTING' && !form.ownerAgencyId
        ? ((await properties.leadTargetListing(tx, p.agencyId, target.id))?.ownerUserId ?? null)
        : null;
    const lead = await receiveLead(tx, p.agencyId, {
      source: marketplace ? 'MARKETPLACE' : 'WEBSITE',
      kind: form.kind,
      contactId,
      presentingAgencyId: marketplace ? null : p.agencyId,
      target,
      listingAgentId,
      message: form.message,
      locale: form.locale,
      visitor: { name: form.name, email: form.email, phone: form.phone, marketingConsent: form.marketingConsent },
      inboundLeadId: form.id,
      autoAckSentAt: form.ackSentAt,
      createdBy: null,
      idempotency: null,
    });
    return { leadId: lead.id, created: true };
  });
}

/**
 * Whether a website lead reached the agency's inbox (website-api's notification fallback: an inbound lead never
 * promoted is still announced to the agency). One statement as that agency.
 */
export function isInboundLeadPromoted(agencyId: string, inboundLeadId: string): Promise<boolean> {
  return withTenant(
    { agencyId },
    async (tx) => (await leadsRepo.leadIdByInbound(tx, agencyId, inboundLeadId)) !== null,
  );
}

// ---- the inbox (members) --------------------------------------------------------------------------------------------

async function loadLead(ctx: Ctx, id: string): Promise<LeadDto> {
  const row = await leadsRepo.getLead(ctx.tx, id);
  if (!row) throw new AppError('LEAD_NOT_FOUND');
  assertCan(ctx, 'crm.leads.read', row);
  return toLeadDto(row);
}

/** The assignee chosen by hand must be an active member of the agency. */
async function assertAssignee(ctx: Ctx, userId: string | null | undefined): Promise<void> {
  if (!userId) return;
  if (!(await identity.isActiveMember(ctx, userId))) {
    throw new AppError('VALIDATION_FAILED', { field: 'assignedUserId', reason: 'not_a_member' });
  }
}

/**
 * The target of a lead entered by hand, as the caller sees it: its owner agency (another agency's: the lead is
 * introduced to it) and, for the agency's own listing, its responsible agent and reference. One statement.
 */
async function resolveTarget(ctx: Ctx, target: NonNullable<CreateLeadBody['target']>) {
  const self = ctx.tenant.agencyId;
  if (target.kind === 'LISTING') {
    const listing = await linkedListing(ctx.tx, self, target.id);
    const own = listing.agencyId === self;
    return {
      ownerAgencyId: own ? null : listing.agencyId,
      listingAgentId: listing.ownerUserId,
      shownRef: target.shownRef ?? listing.ref,
    };
  }
  const owner = await developments.leadTargetOwner(ctx.tx, target.kind, target.id);
  if (!owner) throw new AppError('LEAD_TARGET_NOT_FOUND');
  return { ownerAgencyId: owner === self ? null : owner, listingAgentId: null, shownRef: target.shownRef ?? null };
}

/**
 * `POST /v1/crm/leads`: a lead entered by hand (phone call, portal e-mail, WhatsApp) for one of the agency's contacts —
 * presented by the caller's agency, so it lands in its own inbox (routing §3 #12), the owner of a network target
 * introduced. With an `Idempotency-Key`, a retry by the same member within 24 h with the same body answers the first
 * lead; another body with the key is `IDEMPOTENCY_KEY_REUSED`. ≤ 10 statements on the worst path (key lookup,
 * contact, target, a round-robin turn (4), lead, introduction, event); the answer is built from what was written.
 */
export async function createLead(
  ctx: Ctx,
  input: CreateLeadBody,
  opts: { idempotencyKey?: string } = {},
): Promise<{ lead: LeadDto; replayed: boolean }> {
  assertCan(ctx, 'crm.leads.write');
  const agencyId = ctx.tenant.agencyId;
  const idempotency = idempotencyOf('crm.lead', userIdOf(ctx), opts.idempotencyKey, input);
  const prior = await replayOf(ctx.tx, idempotency, (since, key) =>
    leadsRepo.leadByIdempotency(ctx.tx, agencyId, key.hash, since),
  );
  if (prior) return { lead: await loadLead(ctx, prior.id), replayed: true };
  const contact = await repo.getContact(ctx.tx, input.contactId);
  if (!contact) throw new AppError('CONTACT_NOT_FOUND');
  assertCan(ctx, 'crm.leads.write', contact);
  await assertAssignee(ctx, input.assignedUserId);
  const resolved = input.target ? await resolveTarget(ctx, input.target) : null;

  const lead: ReceivedLead = await receiveLead(ctx.tx, agencyId, {
    source: input.source,
    kind: input.kind,
    contactId: contact.id,
    presentingAgencyId: agencyId,
    target:
      input.target && resolved
        ? {
            kind: input.target.kind,
            id: input.target.id,
            ownerAgencyId: resolved.ownerAgencyId,
            shownRef: resolved.shownRef,
          }
        : null,
    listingAgentId: resolved?.listingAgentId ?? null,
    message: input.message ?? null,
    locale: contact.language,
    visitor: null,
    inboundLeadId: null,
    createdBy: userIdOf(ctx),
    idempotency,
    ...(input.assignedUserId !== undefined ? { assignedUserId: input.assignedUserId } : {}),
  }).catch(keyReusedOn('leads_idempotency_uq'));
  const dto = toLeadDto({
    ...lead,
    contactFirstName: contact.firstName,
    contactLastName: contact.lastName,
    contactEmail: contact.emails[0] ?? null,
    contactPhone: contact.phones[0] ?? null,
  });
  return { lead: dto, replayed: false };
}

export async function getLead(ctx: Ctx, id: string): Promise<LeadDto> {
  assertCan(ctx, 'crm.leads.read');
  const lead = await loadLead(ctx, id);
  await auditImpersonatedRead(ctx, 'leads', { target: { type: 'lead', id } });
  return lead;
}

/**
 * `GET /v1/crm/leads`: the unified inbox (website, portal, iFrame, selections, chatbot, manual …), newest first, keyset
 * (≤ 100 per page, one query with each lead's contact).
 */
export async function listLeads(ctx: Ctx, query: ListLeadsQuery): Promise<LeadPage> {
  assertCan(ctx, 'crm.leads.read');
  const cursor = decodeCursor(query.cursor);
  const filter: leadsRepo.LeadListFilter = {};
  if (query.status) filter.status = query.status;
  if (query.stageId) filter.stageId = query.stageId;
  if (query.source) filter.source = query.source;
  if (query.assigned === 'unassigned') filter.assignedUserId = null;
  else if (query.assigned === 'me') filter.assignedUserId = userIdOf(ctx);
  else if (query.assigned) filter.assignedUserId = query.assigned;
  const rows = await leadsRepo.listLeads(
    ctx.tx,
    ctx.tenant.agencyId,
    filter,
    cursor ? { limit: query.limit, cursor } : { limit: query.limit },
  );
  const page = toPage(rows, query.limit, (r) => ({ at: r.createdMs, id: r.id }), toListItem);
  await auditImpersonatedRead(ctx, 'leads', { count: page.items.length });
  return page;
}

/**
 * `PATCH /v1/crm/leads/:id` (optimistic concurrency on `version`): status and assignment. A status moves the lead to
 * the agency's first active stage standing for it (S10-03: like a drag to the top of that column — the history row
 * from the database, `crm.lead.stageChanged` here); an assignment emits `crm.lead.updated`. Leaving `NEW` the first
 * time records the response time (`firstRespondedAt`).
 */
export async function updateLead(ctx: Ctx, id: string, input: UpdateLeadBody): Promise<LeadDto> {
  assertCan(ctx, 'crm.leads.write');
  const current = await leadsRepo.getLead(ctx.tx, id, { forUpdate: true });
  if (!current) throw new AppError('LEAD_NOT_FOUND');
  assertCan(ctx, 'crm.leads.write', current);
  if (current.version !== input.version) throw new AppError('VERSION_CONFLICT');
  const patch: Parameters<typeof leadsRepo.updateLeadWithVersion>[3] = {};
  const now = new Date();
  let toStageId: string | null = null;
  if (input.status && input.status !== current.status) {
    // S10-03: a status is a move to the top of the first active stage standing for it
    toStageId = (await stageForStatus(ctx, input.status)).id;
    patch.stageId = toStageId;
    patch.status = input.status;
    Object.assign(patch, placement(id, now));
    if (current.status === 'NEW' && !current.firstRespondedAt) patch.firstRespondedAt = now;
  }
  if (input.assignedUserId !== undefined && input.assignedUserId !== current.assignedUserId) {
    await assertAssignee(ctx, input.assignedUserId);
    patch.assignedUserId = input.assignedUserId;
    patch.assignedAt = input.assignedUserId ? now : null;
  }
  if (Object.keys(patch).length === 0) return toLeadDto(current);
  const updated = await leadsRepo.updateLeadWithVersion(
    ctx.tx,
    id,
    input.version,
    patch,
    toStageId ? humanResponseOf(ctx, now) : undefined,
  );
  if (!updated) throw new AppError('VERSION_CONFLICT');
  if (toStageId) {
    await emit(
      ctx.tx,
      crmEvents.leadStageChanged({
        agencyId: current.agencyId,
        leadId: id,
        fromStageId: current.stageId,
        toStageId,
        status: patch.status ?? current.status,
        version: updated.version,
        receivedMs: current.createdMs.getTime(),
        movedMs: now.getTime(),
      }),
    );
  }
  if (patch.assignedUserId !== undefined) {
    await emit(
      ctx.tx,
      crmEvents.leadUpdated({
        agencyId: current.agencyId,
        leadId: id,
        version: updated.version,
        status: patch.status ?? current.status,
        assignedUserId: patch.assignedUserId,
        assignedBy: userIdOf(ctx),
      }),
    );
  }
  return loadLead(ctx, id);
}

// ---- introductions (the owner's side) -------------------------------------------------------------------------------

/**
 * `GET /v1/crm/lead-introductions`: leads other agencies received about the caller's listings, developments and units
 * — who introduced a client for which target, never the client (PLAN §3 #12). Newest first, keyset; two queries (the
 * page, the introducers' directory names).
 */
export async function listLeadIntroductions(ctx: Ctx, query: PageQuery): Promise<LeadIntroductionPage> {
  assertCan(ctx, 'crm.leads.read');
  const cursor = decodeCursor(query.cursor);
  const rows = await leadsRepo.listIntroductions(
    ctx.tx,
    ctx.tenant.agencyId,
    cursor ? { limit: query.limit, cursor } : { limit: query.limit },
  );
  const page = rows.slice(0, query.limit);
  const names =
    page.length > 0 ? await agencies.networkAgencyNames(ctx, distinct(page.map((r) => r.agencyId))) : new Map();
  return toPage(
    rows,
    query.limit,
    (r) => ({ at: r.createdMs, id: r.leadId }),
    (r): LeadIntroductionDto => ({
      leadId: r.leadId,
      introducerAgencyId: r.agencyId,
      introducerName: names.get(r.agencyId) ?? null,
      source: r.source as LeadSource,
      kind: r.kind as LeadKind,
      handEntered: r.handEntered,
      target: { kind: r.targetKind as LeadTargetKind, id: r.targetId },
      createdAt: r.createdAt.toISOString(),
    }),
  );
}

// ---- the assignment rule (admins) -----------------------------------------------------------------------------------

/** `GET /v1/crm/lead-routing`. */
export async function getLeadRouting(ctx: Ctx): Promise<LeadRoutingDto> {
  assertCan(ctx, 'crm.leads.read');
  const rule = await leadsRepo.getRouting(ctx.tx, ctx.tenant.agencyId);
  return rule
    ? { mode: rule.mode as LeadRoutingDto['mode'], agentUserIds: rule.agentUserIds, version: rule.version }
    : { mode: 'UNASSIGNED', agentUserIds: [], version: 0 };
}

/** `PUT /v1/crm/lead-routing` (admins, at `version`): every round-robin member must be an active client member. */
export async function updateLeadRouting(ctx: Ctx, input: UpdateLeadRoutingBody): Promise<LeadRoutingDto> {
  assertCan(ctx, 'crm.leads.routing');
  // S13-F21: lead routing rules are CRM Full (PLAN §11).
  await billing.requirePlan(ctx, 'crm_full');
  const agencyId = ctx.tenant.agencyId;
  const pool = distinct(input.agentUserIds);
  if (pool.length > 0) {
    const active = new Set(await identity.activeClientMemberIds(ctx.tx, agencyId, ROUND_ROBIN_MEMBERS));
    const index = pool.findIndex((id) => !active.has(id));
    if (index >= 0) throw new AppError('VALIDATION_FAILED', { field: 'agentUserIds', index, reason: 'not_a_member' });
  }
  const saved = await leadsRepo.saveRouting(ctx.tx, agencyId, input.version, { mode: input.mode, agentUserIds: pool });
  if (!saved) throw new AppError('VERSION_CONFLICT');
  return { mode: saved.mode as LeadRoutingDto['mode'], agentUserIds: saved.agentUserIds, version: saved.version };
}
