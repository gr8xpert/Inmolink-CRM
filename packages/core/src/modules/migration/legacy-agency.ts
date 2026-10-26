/**
 * Transform and load of one legacy agency (S14-02, PLAN §14 Path A step 3, ADR 0006): users → members, listings (with
 * texts, features and their images queued for the media pipeline), developments and units (S4-04), contacts and leads,
 * each in checkpointed batches (`batches.ts`) with a `legacy_id_maps` row per loaded row and a report per entity.
 *
 * Every batch is a fixed number of statements: its staged rows are validated (contracts), the maps it needs are read in
 * one statement per entity kind, the rows transformed in memory and written through the owning module's legacy bulk
 * path. Nothing is guessed: a row that cannot be loaded is listed with a reason, and so is anything left out of a row
 * that was loaded (an unmapped feature, an invalid phone number). Entities run in dependency order and the run stops at
 * the first failed batch; a re-run resumes there.
 */
import {
  type ContactType,
  type LeadSource,
  type LeadStatus,
  LegacyContactRow,
  LegacyLeadRow,
  LegacyListingRow,
  type LegacyLoadReport,
  LegacyUserRow,
  type MemberRole,
} from '@inmolink/contracts';
import { type Tx, withSystem } from '@inmolink/db';
import { isUiLocale } from '@inmolink/i18n';
import { newId } from '@inmolink/platform/ids';
import { withMemberCtx } from '../../member';
import * as agencies from '../agencies';
import * as billing from '../billing';
import * as crm from '../crm';
import * as identity from '../identity';
import * as media from '../media';
import * as onboarding from '../onboarding';
import * as properties from '../properties';
import { type BatchStep, runBatches, type StepOutcome } from './batches';
import { LEGACY_DEVELOPMENT_ENTITIES, loadDevelopmentsInto } from './legacy-developments';
import { cents, idsOf } from './legacy-rows';
import {
  AGENCY_MAP_METHOD,
  addIssue,
  addWarning,
  agencyTargets,
  contentLocale,
  countOutcome,
  countsOf,
  dropCollisions,
  enumKey,
  finishReport,
  newLoadReport,
  recordAgencyMaps,
  targetsOf,
  validateRows,
} from './load';
import * as repo from './repo';

/** Staging file names (S14-01 `DEFAULT_ENTITIES`), in load order. */
export const LEGACY_STAGING = {
  users: 'users',
  listings: 'properties',
  developments: LEGACY_DEVELOPMENT_ENTITIES.development,
  units: LEGACY_DEVELOPMENT_ENTITIES.unit,
  contacts: 'contacts',
  leads: 'leads',
} as const;

/** Rows per batch (each batch is one transaction and one checkpoint). */
export const LEGACY_BATCH_ROWS = { users: 200, listings: 250, contacts: 500, leads: 500 } as const;

const truthy = (v: unknown) =>
  v === true || v === 1 || (typeof v === 'string' && ['1', 'true', 'yes', 'y', 'si', 'sí', 'x'].includes(enumKey(v)));
export const listOf = (v: string | readonly string[] | undefined) =>
  v === undefined ? [] : (typeof v === 'string' ? v.split(/[;,|]/) : [...v]).map((x) => x.trim()).filter(Boolean);

// ── Users ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const ROLES: Record<string, MemberRole> = {
  admin: 'AGENCY_ADMIN',
  administrator: 'AGENCY_ADMIN',
  administrador: 'AGENCY_ADMIN',
  owner: 'AGENCY_ADMIN',
  manager: 'AGENCY_ADMIN',
  agency_admin: 'AGENCY_ADMIN',
};

/**
 * S14 review: the agency's own e-mail domains — the operator's (`--email-domain`) and those of the members the load did
 * not create — and those members. Read once per run, before the users step.
 */
export interface AgencyEmailDomains {
  known: ReadonlySet<string>;
  /** Members that were there before the load (their e-mail was verified in v2, not taken from the dump). */
  preexisting: ReadonlySet<string>;
}

const domainOf = (email: string) => email.slice(email.lastIndexOf('@') + 1).toLowerCase();

async function agencyEmailDomains(
  tx: Tx,
  agencyId: string,
  given: readonly string[] = [],
): Promise<AgencyEmailDomains> {
  const members = await identity.activeMemberEmails(tx, agencyId);
  const imported = await repo.importedAmong(
    tx,
    'user',
    agencyId,
    members.map((m) => m.userId),
  );
  const own = members.filter((m) => !imported.has(m.userId));
  return {
    known: new Set([
      ...given.map((d) => d.trim().toLowerCase().replace(/^@/, '')),
      ...own.map((m) => domainOf(m.email)),
    ]),
    preexisting: new Set(own.map((m) => m.userId)),
  };
}

async function loadUsers(
  tx: Tx,
  agencyId: string,
  passwordHash: string,
  domains: AgencyEmailDomains,
  rows: readonly unknown[],
  report: LegacyLoadReport,
) {
  const inputs: identity.LegacyMemberInput[] = [];
  const valid = validateRows(report, 'user', LegacyUserRow, rows);
  const { foreign } = await agencyTargets(tx, 'user', idsOf(valid, 'id'), agencyId);
  for (const u of dropCollisions(report, 'user', valid, foreign)) {
    if (u.active !== undefined && !truthy(u.active)) {
      addIssue(report, 'user', u.id, 'invalid', 'inactive legacy user: not migrated');
      continue;
    }
    const locale = u.locale && isUiLocale(u.locale.toLowerCase()) ? u.locale.toLowerCase() : 'es';
    inputs.push({
      legacyId: u.id,
      email: u.email,
      name: u.name || u.email.split('@')[0] || u.email,
      locale,
      // Unknown legacy roles are agents: never more rights than the legacy role said.
      role: (u.role && ROLES[enumKey(u.role)]) || 'AGENT',
    });
  }
  const result = await identity.importLegacyMembers(tx, agencyId, inputs, passwordHash);
  for (const s of result.skipped) addIssue(report, 'user', s.legacyId, s.reason, s.detail);
  for (const { outcome } of result.members.values()) countOutcome(report, 'user', outcome);
  // `import` only for the members this load created: the cutover's ENABLE_ACCESS mails those (never an existing member
  // matched by e-mail); a re-run's `matched` answer for a created member keeps its `import` map (`upsertMaps`).
  await recordAgencyMaps(
    tx,
    'user',
    agencyId,
    [...result.members].map(([legacyId, m]) => [
      legacyId,
      m.userId,
      m.outcome === 'created' ? AGENCY_MAP_METHOD.imported : AGENCY_MAP_METHOD.matched,
    ]),
  );
  // A migrated user's e-mail is marked verified from the dump: one outside the agency's own domains is for staff to
  // check before cutover (a warning; no e-mail or domain in the report).
  const emailOf = new Map(inputs.map((i) => [i.legacyId, i.email]));
  for (const [legacyId, m] of result.members) {
    if (domains.preexisting.has(m.userId)) continue;
    const email = emailOf.get(legacyId);
    if (email && !domains.known.has(domainOf(email))) {
      addWarning(report, 'user', legacyId, 'email_domain', "e-mail domain is not one of the agency's");
    }
  }
}

// ── Listings ───────────────────────────────────────────────────────────────────────────────────────────────────────

export const LISTING_STATUS: Record<string, properties.LegacyListingInput['status'] | 'DRAFT' | 'WITHDRAWN'> = {
  active: 'ACTIVE',
  available: 'ACTIVE',
  published: 'ACTIVE',
  disponible: 'ACTIVE',
  reserved: 'UNDER_OFFER',
  under_offer: 'UNDER_OFFER',
  reservado: 'UNDER_OFFER',
  sold: 'SOLD',
  vendido: 'SOLD',
  rented: 'RENTED',
  alquilado: 'RENTED',
  draft: 'DRAFT',
  inactive: 'WITHDRAWN',
  withdrawn: 'WITHDRAWN',
  archived: 'WITHDRAWN',
};
export const TRANSACTION: Record<string, properties.LegacyListingInput['transactionType']> = {
  sale: 'SALE',
  sell: 'SALE',
  venta: 'SALE',
  resale: 'SALE',
  new_build: 'SALE',
  rent: 'RENT_LONG_TERM',
  long_term: 'RENT_LONG_TERM',
  long_term_rental: 'RENT_LONG_TERM',
  alquiler: 'RENT_LONG_TERM',
  holiday: 'RENT_SHORT_TERM',
  short_term: 'RENT_SHORT_TERM',
  holiday_rental: 'RENT_SHORT_TERM',
  vacacional: 'RENT_SHORT_TERM',
};
const PERIOD: Record<string, 'NIGHT' | 'WEEK' | 'MONTH'> = {
  night: 'NIGHT',
  day: 'NIGHT',
  week: 'WEEK',
  weekly: 'WEEK',
  month: 'MONTH',
  monthly: 'MONTH',
};
const CEE = new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'EXEMPT', 'PENDING']);

export interface ListingRun {
  agencyId: string;
  fallbackOwnerUserId: string;
  commission: properties.LegacyListingRun['commission'];
  splitBp: number;
}

async function loadListings(tx: Tx, run: ListingRun, rows: readonly unknown[], report: LegacyLoadReport) {
  const own = await agencyTargets(tx, 'listing', idsOf(rows, 'id'), run.agencyId);
  const valid = dropCollisions(report, 'listing', validateRows(report, 'listing', LegacyListingRow, rows), own.foreign);
  const locations = await targetsOf(tx, 'location', idsOf(valid, 'location_id'));
  const types = await targetsOf(tx, 'propertyType', idsOf(valid, 'property_type_id'));
  const features = await targetsOf(
    tx,
    'feature',
    valid.flatMap((l) => l.feature_ids ?? []),
  );
  const agents = (await agencyTargets(tx, 'user', idsOf(valid, 'agent_id'), run.agencyId)).own;
  const inputs: properties.LegacyListingInput[] = [];
  for (const l of valid) {
    const status = l.status === undefined ? 'ACTIVE' : LISTING_STATUS[enumKey(l.status)];
    const transactionType = l.listing_type === undefined ? 'SALE' : TRANSACTION[enumKey(l.listing_type)];
    if (!status || !transactionType) {
      const what = !status
        ? `status: unknown value ${JSON.stringify(l.status)}`
        : `listing_type: unknown value ${JSON.stringify(l.listing_type)}`;
      addIssue(report, 'listing', l.id, 'invalid', what);
      continue;
    }
    const locationId = l.location_id === undefined ? undefined : locations.get(l.location_id);
    if (!locationId) {
      addIssue(report, 'listing', l.id, 'unmapped_location', l.location_id ?? null);
      continue;
    }
    const propertyTypeId = l.property_type_id === undefined ? undefined : types.get(l.property_type_id);
    if (!propertyTypeId) {
      addIssue(report, 'listing', l.id, 'unmapped_property_type', l.property_type_id ?? null);
      continue;
    }
    if ((l.lat === undefined) !== (l.lng === undefined)) {
      addIssue(report, 'listing', l.id, 'invalid', 'coordinates: lat and lng go together');
      continue;
    }
    const featureIds: string[] = [];
    for (const f of l.feature_ids ?? []) {
      const id = features.get(f);
      if (id) featureIds.push(id);
      else addWarning(report, 'listing', l.id, 'unmapped_feature', f);
    }
    const rating = l.energy_rating?.toUpperCase();
    if (rating !== undefined && !CEE.has(rating)) {
      addWarning(report, 'listing', l.id, 'invalid', `energy_rating: ${JSON.stringify(l.energy_rating)} left out`);
    }
    const ref = l.ref ?? l.id;
    const texts: properties.LegacyListingInput['translations'][number][] = [];
    const locales = new Set<string>();
    for (const t of l.translations ?? []) {
      const locale = contentLocale(t.locale);
      if (!locale || locales.has(locale)) continue;
      if (!t.title && !t.description) continue;
      locales.add(locale);
      texts.push({ locale, title: t.title || ref, description: t.description ?? null });
    }
    const rent = transactionType !== 'SALE';
    inputs.push({
      legacyId: l.id,
      ref: l.ref ?? null,
      ownerUserId: (l.agent_id && agents.get(l.agent_id)) || null,
      // DRAFT and WITHDRAWN are statuses of the listing table the feed type leaves out (a feed never sends them).
      status: status as properties.LegacyListingInput['status'],
      transactionType,
      priceCents: l.price === undefined ? null : cents(l.price),
      currency: (l.currency ?? 'EUR').toUpperCase(),
      pricePeriod: rent
        ? ((l.price_period ? PERIOD[enumKey(l.price_period)] : undefined) ??
          (transactionType === 'RENT_SHORT_TERM' ? 'WEEK' : 'MONTH'))
        : null,
      priceOnRequest: truthy(l.price_on_request),
      builtM2: l.built_m2 ?? null,
      plotM2: l.plot_m2 ?? null,
      terraceM2: l.terrace_m2 ?? null,
      bedrooms: l.bedrooms ?? null,
      bathrooms: l.bathrooms ?? null,
      yearBuilt: l.year_built ?? null,
      energyRating: rating && CEE.has(rating) ? rating : null,
      energyEmissionsRating: null,
      coordinates: l.lat !== undefined && l.lng !== undefined ? { lat: l.lat, lng: l.lng } : null,
      // The legacy pin's precision is unknown: shown as an area, never as the address (privacy by default).
      locationPrecision: 'APPROX',
      propertyTypeId,
      locationId,
      featureIds,
      translations: texts,
      imageUrls: l.images ?? [],
    });
  }
  const result = await properties.importLegacyListingBatch(tx, run, inputs);
  for (const r of result.rejected) {
    addIssue(
      report,
      'listing',
      r.legacyId,
      r.code === 'PROPERTY_TYPE_UNMATCHED' ? 'unmapped_property_type' : 'unmapped_location',
    );
  }
  for (const [legacyId, ref] of result.renamed) {
    addWarning(report, 'listing', legacyId, 'ref_taken', `the legacy reference is taken: listed as ${ref}`);
  }
  for (const { outcome } of result.listings.values()) countOutcome(report, 'listing', outcome);
  await recordAgencyMaps(
    tx,
    'listing',
    run.agencyId,
    [...result.listings].map(([legacyId, l]) => [legacyId, l.id]),
  );
  // Images: queued here (one statement), downloaded by the media workers (safeFetch, dedup by content hash).
  await media.queueFeedImages(tx, run.agencyId, result.imagesChanged);
}

// ── Contacts and leads ─────────────────────────────────────────────────────────────────────────────────────────────

const CONTACT_TYPES: Record<string, ContactType> = {
  buyer: 'BUYER',
  comprador: 'BUYER',
  seller: 'SELLER',
  vendor: 'SELLER',
  vendedor: 'SELLER',
  owner: 'SELLER',
  propietario: 'SELLER',
  tenant: 'TENANT',
  inquilino: 'TENANT',
  landlord: 'LANDLORD',
  arrendador: 'LANDLORD',
};

async function loadContacts(tx: Tx, agencyId: string, rows: readonly unknown[], report: LegacyLoadReport) {
  const mapped = await agencyTargets(tx, 'contact', idsOf(rows, 'id'), agencyId);
  const valid = dropCollisions(
    report,
    'contact',
    validateRows(report, 'contact', LegacyContactRow, rows),
    mapped.foreign,
  );
  const agents = (await agencyTargets(tx, 'user', idsOf(valid, 'agent_id'), agencyId)).own;
  const known = mapped.own;
  const inputs: crm.LegacyContactInput[] = [];
  for (const c of valid) {
    const emails = listOf(c.email);
    const phones = listOf(c.phone);
    if (!c.first_name && !c.last_name && emails.length === 0 && phones.length === 0) {
      addIssue(report, 'contact', c.id, 'invalid', 'no name, e-mail or phone');
      continue;
    }
    const language = c.language ? contentLocale(c.language) : null;
    inputs.push({
      legacyId: c.id,
      knownId: known.get(c.id) ?? null,
      firstName: c.first_name || null,
      lastName: c.last_name || null,
      emails,
      phones,
      language,
      types: [...new Set(listOf(c.type).flatMap((t) => CONTACT_TYPES[enumKey(t)] ?? []))],
      ownerUserId: (c.agent_id && agents.get(c.agent_id)) || null,
      consentMarketing: truthy(c.consent_marketing),
      note: c.notes || null,
      createdAt: c.created_at ?? null,
    });
  }
  const result = await crm.importLegacyContacts(tx, agencyId, inputs);
  for (const w of result.invalidIdentifiers) {
    addWarning(report, 'contact', w.legacyId, 'invalid', 'an e-mail or phone that is not valid was left out');
  }
  for (const { outcome } of result.contacts.values()) countOutcome(report, 'contact', outcome);
  await recordAgencyMaps(
    tx,
    'contact',
    agencyId,
    [...result.contacts].map(([legacyId, c]) => [legacyId, c.id]),
  );
}

export const LEAD_STATUS: Record<string, LeadStatus> = {
  new: 'NEW',
  open: 'IN_PROGRESS',
  pending: 'IN_PROGRESS',
  contacted: 'IN_PROGRESS',
  in_progress: 'IN_PROGRESS',
  won: 'WON',
  closed_won: 'WON',
  lost: 'LOST',
  closed: 'LOST',
  closed_lost: 'LOST',
  spam: 'SPAM',
};
export const LEAD_SOURCE: Record<string, LeadSource> = {
  web: 'WEBSITE',
  website: 'WEBSITE',
  form: 'WEBSITE',
  portal: 'PORTAL',
  idealista: 'PORTAL',
  fotocasa: 'PORTAL',
  kyero: 'PORTAL',
  whatsapp: 'WHATSAPP',
};

async function loadLeads(tx: Tx, agencyId: string, rows: readonly unknown[], report: LegacyLoadReport) {
  const mapped = await agencyTargets(tx, 'lead', idsOf(rows, 'id'), agencyId);
  const valid = dropCollisions(report, 'lead', validateRows(report, 'lead', LegacyLeadRow, rows), mapped.foreign);
  // References resolve to this agency's rows only: another agency's contact or listing is never linked.
  const contacts = (await agencyTargets(tx, 'contact', idsOf(valid, 'contact_id'), agencyId)).own;
  const listings = (await agencyTargets(tx, 'listing', idsOf(valid, 'property_id'), agencyId)).own;
  const units = (await agencyTargets(tx, 'unit', idsOf(valid, 'property_id'), agencyId)).own;
  const agents = (await agencyTargets(tx, 'user', idsOf(valid, 'agent_id'), agencyId)).own;
  const known = mapped.own;
  const inputs: crm.LegacyLeadInput[] = [];
  for (const l of valid) {
    const contactId = contacts.get(l.contact_id);
    if (!contactId) {
      addIssue(report, 'lead', l.id, 'orphan', `contact ${l.contact_id}`);
      continue;
    }
    const status = l.status === undefined ? 'NEW' : LEAD_STATUS[enumKey(l.status)];
    if (!status) {
      addIssue(report, 'lead', l.id, 'invalid', `status: unknown value ${JSON.stringify(l.status)}`);
      continue;
    }
    const listing = l.property_id ? listings.get(l.property_id) : undefined;
    const unit = l.property_id && !listing ? units.get(l.property_id) : undefined;
    if (l.property_id && !listing && !unit) {
      addWarning(report, 'lead', l.id, 'orphan', `property ${l.property_id} not migrated: kept without it`);
    }
    inputs.push({
      legacyId: l.id,
      knownId: known.get(l.id) ?? null,
      contactId,
      source: (l.source && LEAD_SOURCE[enumKey(l.source)]) || 'MANUAL',
      status,
      message: l.message?.trim() || null,
      locale: l.locale ? contentLocale(l.locale) : null,
      assignedUserId: (l.agent_id && agents.get(l.agent_id)) || null,
      target: listing
        ? { kind: 'LISTING', id: listing, shownRef: null }
        : unit
          ? { kind: 'UNIT', id: unit, shownRef: null }
          : null,
      createdAt: l.created_at ?? null,
    });
  }
  const result = await crm.importLegacyLeads(tx, agencyId, inputs);
  for (const { outcome } of result.leads.values()) countOutcome(report, 'lead', outcome);
  await recordAgencyMaps(
    tx,
    'lead',
    agencyId,
    [...result.leads].map(([legacyId, l]) => [legacyId, l.id]),
  );
}

// ── The agency ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type LegacyStagingEntity = keyof typeof LEGACY_STAGING;

/**
 * One staged entity file: its rows as batches of at most `size`, in staging order on every call. The script streams
 * the NDJSON file line by line (one batch in memory at a time); `fromRows` serves rows already in memory (tests).
 */
export interface StagedSource {
  batches(size: number): AsyncIterable<readonly unknown[]>;
}

/** A source over rows already in memory (tests, small files). */
export function fromRows(rows: readonly unknown[]): StagedSource {
  return {
    async *batches(size: number) {
      const n = Math.max(1, size);
      for (let i = 0; i < rows.length; i += n) yield rows.slice(i, i + n);
    },
  };
}

/**
 * Developments and units are loaded as one batch (units must meet their development): at most this many rows of each
 * are read. A larger file stops the step with `code=TOO_MANY_ROWS` (documented in the script's header).
 */
export const LEGACY_DEVELOPMENT_MAX_ROWS = 50_000;

export interface MigrateLegacyAgencyInput {
  legacyAgencyId: string;
  /** The v2 agency (`resolveLegacyAgency`). */
  agencyId: string;
  /** Staged files per entity (missing: nothing staged). */
  staged: Partial<Record<LegacyStagingEntity, StagedSource>>;
  /** The inventory's legacy row counts per report entity (`user`, `listing`, …). */
  legacyRows?: Partial<Record<string, number>>;
  dryRun?: boolean;
  /** Ignore checkpoints: every batch runs again (idempotent). */
  restart?: boolean;
  /**
   * S14 review: the agency's e-mail domains (the operator's `--email-domain`), besides those of its members the load
   * did not create; a migrated user outside them is a report warning (`email_domain`).
   */
  emailDomains?: readonly string[];
  /** Rows per batch, per entity (defaults: `LEGACY_BATCH_ROWS`). */
  batchRows?: Partial<Record<'users' | 'listings' | 'contacts' | 'leads', number>>;
  /** Starts the agency's image downloads after the listings committed (default: the media queue). */
  requestMedia?: (agencyId: string) => Promise<void>;
  /**
   * S14-04: prefix of the checkpoint keys (`delta:` for the hourly delta), so a delta run never replaces the full
   * load's checkpoints. Default: none.
   */
  checkpointPrefix?: string;
}

export interface MigrateLegacyAgencyResult {
  report: LegacyLoadReport;
  steps: Partial<Record<string, StepOutcome>>;
  /** The entity whose batch failed (the run stopped there); null when every step ran. */
  stoppedAt: { entity: string; seq: number; error: string } | null;
}

/** Report entity → its staging file. */
export const STAGED_OF: Record<string, LegacyStagingEntity> = {
  user: 'users',
  listing: 'listings',
  development: 'developments',
  unit: 'units',
  contact: 'contacts',
  lead: 'leads',
};

class TooManyRows extends Error {}

async function collect(source: StagedSource | undefined, max: number): Promise<unknown[]> {
  const out: unknown[] = [];
  if (!source) return out;
  for await (const batch of source.batches(1_000)) {
    out.push(...batch);
    if (out.length > max) throw new TooManyRows();
  }
  return out;
}

/** Memoizes an async value: computed on first use. */
function lazy<T>(make: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | undefined;
  return () => {
    value ??= make();
    return value;
  };
}

/**
 * Loads one legacy agency, entity after entity, in checkpointed batches (each its own `withSystem()` transaction).
 * After the leads: the CRM report rollups are rebuilt and the onboarding checklist back-filled.
 */
export async function migrateLegacyAgency(input: MigrateLegacyAgencyInput): Promise<MigrateLegacyAgencyResult> {
  const dryRun = input.dryRun ?? false;
  const opts = {
    legacyAgencyId: input.legacyAgencyId,
    agencyId: input.agencyId,
    dryRun,
    restart: input.restart ?? false,
  };
  const report = newLoadReport(input.legacyAgencyId, input.agencyId, dryRun);
  const result: MigrateLegacyAgencyResult = { report, steps: {}, stoppedAt: null };
  const size = { ...LEGACY_BATCH_ROWS, ...input.batchRows };
  const source = (e: LegacyStagingEntity) => input.staged[e];
  const reason = `legacy-migration.load${dryRun ? '.dry-run' : ''}`;
  // Every entity is in the report; one with a staged file the run never reached (it stopped before) does not match.
  for (const e of Object.keys(STAGED_OF)) countsOf(report, e);
  const reached = new Set<string>();

  const run = async (step: BatchStep): Promise<StepOutcome> => {
    for (const e of step.reportEntities) reached.add(e);
    const outcome = await runBatches(
      opts,
      { ...step, entity: `${input.checkpointPrefix ?? ''}${step.entity}` },
      report,
    );
    result.steps[step.entity] = outcome;
    if (outcome.failed) result.stoppedAt = { entity: step.entity, ...outcome.failed };
    return outcome;
  };
  const fail = (entity: string, error: string) => {
    result.stoppedAt = { entity, seq: 0, error };
    return false;
  };

  const steps = async (): Promise<boolean> => {
    // Users first: listings, contacts and leads name their agents.
    const users = source('users');
    if (users) {
      const passwordHash = lazy(() => identity.legacyPasswordPlaceholder());
      const domains = await withSystem(reason, (tx) => agencyEmailDomains(tx, input.agencyId, input.emailDomains));
      const outcome = await run({
        entity: LEGACY_STAGING.users,
        reportEntities: ['user'],
        batches: users.batches(size.users),
        load: async (tx, rows, r) => loadUsers(tx, input.agencyId, await passwordHash(), domains, rows, r),
      });
      if (outcome.failed) return false;
      // More members than the plan's seats: a warning for staff to settle before cutover (the load adds them all).
      const seats = await withSystem(reason, async (tx) => ({
        used: await identity.activeMemberCount(tx, input.agencyId),
        limit: await billing.seatLimit(tx, input.agencyId),
      }));
      if (seats.limit.seats !== null && seats.used > seats.limit.seats) {
        addWarning(
          report,
          'user',
          input.legacyAgencyId,
          'over_seat',
          `${seats.used} members, plan ${seats.limit.plan} has ${seats.limit.seats} seats`,
        );
      }
    }

    const listings = source('listings');
    if (listings) {
      // New listings of an unmapped agent belong to the agency's first admin; they get the agency's default commission.
      // Read before the batch transactions (a member transaction of its own, never nested in a batch's).
      const admin = (await withSystem(reason, (tx) => identity.agencyAdminsOf(tx, [input.agencyId]))).get(
        input.agencyId,
      )?.[0];
      if (!admin) {
        reached.add('listing');
        return fail(LEGACY_STAGING.listings, 'code=NO_AGENCY_ADMIN');
      }
      const defaults = await withMemberCtx({ userId: admin, agencyId: input.agencyId, requestId: newId() }, (ctx) =>
        agencies.getAgencyDefaultCommission(ctx),
      );
      const listingRun: ListingRun = { agencyId: input.agencyId, fallbackOwnerUserId: admin, ...defaults };
      const outcome = await run({
        entity: LEGACY_STAGING.listings,
        reportEntities: ['listing'],
        batches: listings.batches(size.listings),
        load: (tx, rows, r) => loadListings(tx, listingRun, rows, r),
      });
      if (!dryRun && outcome.batches > outcome.resumed) {
        await (input.requestMedia ?? media.requestFeedImages)(input.agencyId);
      }
      if (outcome.failed) return false;
    }

    // Developments with their units: one batch (a few hundred rows per agency; capped).
    if (source('developments') || source('units')) {
      let staged: { developments: unknown[]; units: unknown[] };
      try {
        staged = {
          developments: await collect(source('developments'), LEGACY_DEVELOPMENT_MAX_ROWS),
          units: await collect(source('units'), LEGACY_DEVELOPMENT_MAX_ROWS),
        };
      } catch (err) {
        if (!(err instanceof TooManyRows)) throw err;
        reached.add('development');
        reached.add('unit');
        return fail(LEGACY_STAGING.developments, `code=TOO_MANY_ROWS max=${LEGACY_DEVELOPMENT_MAX_ROWS}`);
      }
      const outcome = await run({
        entity: LEGACY_STAGING.developments,
        reportEntities: ['development', 'unit'],
        batches: fromRows([staged]).batches(1),
        load: (tx, rows, r) =>
          loadDevelopmentsInto(
            tx,
            input.agencyId,
            rows[0] as { developments: readonly unknown[]; units: readonly unknown[] },
            r,
          ),
      });
      if (outcome.failed) return false;
    }

    const contacts = source('contacts');
    if (contacts) {
      const outcome = await run({
        entity: LEGACY_STAGING.contacts,
        reportEntities: ['contact'],
        batches: contacts.batches(size.contacts),
        load: (tx, rows, r) => loadContacts(tx, input.agencyId, rows, r),
      });
      if (outcome.failed) return false;
    }
    const leads = source('leads');
    if (leads) {
      const outcome = await run({
        entity: LEGACY_STAGING.leads,
        reportEntities: ['lead'],
        batches: leads.batches(size.leads),
        load: (tx, rows, r) => loadLeads(tx, input.agencyId, rows, r),
      });
      // Migrated leads emitted no event: the reports are rebuilt from the tables.
      if (!dryRun && outcome.batches > outcome.resumed) await crm.rebuildReportRollups({ agencyId: input.agencyId });
      if (outcome.failed) return false;
    }
    return true;
  };

  await steps();
  if (!dryRun) await onboarding.backfillAgency(input.agencyId, 'legacy-migration.onboarding');
  // No password-reset e-mail here (S14 review): the cutover's ENABLE_ACCESS step mails the members the load created,
  // once, with its progress recorded — a re-run of the load never mails anyone.
  for (const [entity, n] of Object.entries(input.legacyRows ?? {})) {
    if (n !== undefined) countsOf(report, entity).legacyRows = n;
  }
  finishReport(report);
  for (const [e, key] of Object.entries(STAGED_OF)) {
    if (reached.has(e) || !source(key)) continue;
    countsOf(report, e).matches = false;
    report.matches = false;
  }
  return result;
}
