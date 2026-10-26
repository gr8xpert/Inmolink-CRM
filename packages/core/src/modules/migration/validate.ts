/**
 * Validation report of one legacy agency (S14-03, PLAN §14 Path A step 6): run after the load (S14-02) against the
 * same staging files, it answers whether the agency's data arrived — target < 0.5 % unexplained differences:
 *
 * - **Counts** per entity: the inventory's legacy rows, the staged rows, the staged rows mapped to this agency
 *   (`legacy_id_maps`) and the rows the load listed with a reason (checkpoints: explained). The rest is unexplained.
 * - **Images**: the inventory's legacy images, the staged image URLs, the URLs the load queued (distinct, capped per
 *   listing) and, of those, the ones on their listing or still queued — a URL neither is a failed download.
 * - **Sampled field diffs**: a deterministic sample per entity (listings, contacts, leads; the same rows on every run)
 *   compared field by field with the v2 row. Field NAMES only reach the report, never values (no personal data).
 * - **URL checks** of the sampled listings: the legacy id resolves through the public legacy lookup (the v1 shim and
 *   the legacy redirects use it) to the listing it became; its legacy image URLs are on it or queued.
 *
 * Everything runs in short `withSystem()` transactions of the operator's script, one staged batch at a time (a fixed
 * handful of statements per 1,000 rows); `withPublicRead()` for the lookup, as the shim does. Nothing is written but
 * the report itself (`recordValidationReport`).
 */
import { createHash } from 'node:crypto';
import {
  LegacyContactRow,
  LegacyLeadRow,
  LegacyListingRow,
  MIGRATION_VALIDATION_MAX_UNEXPLAINED_RATE,
  MIGRATION_VALIDATION_SAMPLE_DEFAULT,
  MIGRATION_VALIDATION_SAMPLE_MAX,
  type MigrationValidationCounts,
  type MigrationValidationReport,
  type MigrationValidationSample,
  type MigrationValidationUrlCheck,
} from '@inmolink/contracts';
import { type Tx, withPublicRead, withSystem } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
import { newId } from '@inmolink/platform/ids';
import * as crm from '../crm';
import * as media from '../media';
import * as properties from '../properties';
import {
  LEAD_SOURCE,
  LEAD_STATUS,
  type LegacyStagingEntity,
  LISTING_STATUS,
  listOf,
  STAGED_OF,
  type StagedSource,
  TRANSACTION,
} from './legacy-agency';
import { agencyTargets, contentLocale, enumKey, type TenantEntity, targetsOf } from './load';
import * as repo from './repo';
import * as vrepo from './validation-repo';

/** Staged rows read per transaction. */
export const VALIDATION_BATCH_ROWS = 1_000;

/** Report entities in load order (the staging file of each: `STAGED_OF`). */
const ENTITIES = ['user', 'listing', 'development', 'unit', 'contact', 'lead'] as const;
type Entity = (typeof ENTITIES)[number];
const SAMPLED: ReadonlySet<Entity> = new Set(['listing', 'contact', 'lead']);

export interface ValidateLegacyAgencyInput {
  legacyAgencyId: string;
  /** The v2 agency (its `legacy_id_maps` agency map). */
  agencyId: string;
  staged: Partial<Record<LegacyStagingEntity, StagedSource>>;
  /** The inventory's counts per report entity (`user`, `listing`, …) and `image` (`property_images`). */
  legacyRows?: Partial<Record<string, number>>;
  /** Rows sampled per entity (default `MIGRATION_VALIDATION_SAMPLE_DEFAULT`, at most `…_SAMPLE_MAX`). */
  sampleSize?: number;
}

type ImageState = { expected: number; attached: number; pending: number };
interface Candidate {
  key: string;
  legacyId: string;
  newId: string;
  row: unknown;
  images?: ImageState;
}

const reason = 'legacy-migration.validate';
const idOf = (row: unknown): string | null => {
  const v = (row as Record<string, unknown> | null)?.id;
  return typeof v === 'string' || typeof v === 'number' ? String(v).trim() || null : null;
};
const imagesOf = (row: unknown): string[] => {
  const v = (row as Record<string, unknown> | null)?.images;
  return Array.isArray(v) ? v.filter((u): u is string => typeof u === 'string').map((u) => u.trim()) : [];
};
const sampleKey = (legacyAgencyId: string, legacyId: string) =>
  createHash('sha256').update(`${legacyAgencyId}\u0000${legacyId}`).digest('hex');

/** Keeps the `size` candidates with the smallest keys (a deterministic sample of a stream). */
function keepSmallest(into: Candidate[], more: Candidate[], size: number): Candidate[] {
  if (more.length === 0) return into;
  return [...into, ...more].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).slice(0, size);
}

// ── Field comparisons (pure: unit-tested) ──────────────────────────────────────────────────────────────────────────

export interface FieldDiff {
  fields: string[];
  explainedFields: string[];
}

const sameNumber = (a: number | null, b: number | string | null) =>
  a === null || b === null ? a === b : Math.abs(a - Number(b)) < 0.005;
const sameSet = (a: readonly string[], b: readonly string[]) => {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((v) => y.has(v));
};

function diff(checks: [field: string, equal: boolean, explained?: boolean][]): FieldDiff {
  const out: FieldDiff = { fields: [], explainedFields: [] };
  for (const [field, equal, explained] of checks) {
    if (equal) continue;
    (explained ? out.explainedFields : out.fields).push(field);
  }
  return out;
}

export interface ListingExpectations {
  locations: ReadonlyMap<string, string>;
  types: ReadonlyMap<string, string>;
  features: ReadonlyMap<string, string>;
  /** The load's issue reasons for this legacy id (`ref_taken`, `unmapped_feature`, …). */
  reasons: ReadonlySet<string>;
  images?: ImageState;
}

/** A staged legacy listing against the listing it became. */
export function compareListing(raw: unknown, v2: properties.LegacyListingSnapshot, x: ListingExpectations): FieldDiff {
  const parsed = LegacyListingRow.safeParse(raw);
  if (!parsed.success) return { fields: ['row'], explainedFields: [] };
  const l = parsed.data;
  const status = l.status === undefined ? 'ACTIVE' : LISTING_STATUS[enumKey(l.status)];
  const transaction = l.listing_type === undefined ? 'SALE' : TRANSACTION[enumKey(l.listing_type)];
  const features = (l.feature_ids ?? []).flatMap((f) => x.features.get(f) ?? []);
  const img = x.images;
  return diff([
    ['ref', l.ref === undefined || v2.ref === l.ref, x.reasons.has('ref_taken')],
    ['status', v2.status === status],
    ['transactionType', v2.transactionType === transaction],
    ['price', sameNumber(l.price === undefined ? null : Math.round(l.price * 100), v2.priceCents)],
    ['currency', v2.currency === (l.currency ?? 'EUR').toUpperCase()],
    ['bedrooms', sameNumber(l.bedrooms ?? null, v2.bedrooms)],
    ['bathrooms', sameNumber(l.bathrooms ?? null, v2.bathrooms)],
    ['builtM2', sameNumber(l.built_m2 ?? null, v2.builtM2)],
    ['plotM2', sameNumber(l.plot_m2 ?? null, v2.plotM2)],
    ['location', (l.location_id ? x.locations.get(l.location_id) : undefined) === (v2.locationId ?? undefined)],
    [
      'propertyType',
      (l.property_type_id ? x.types.get(l.property_type_id) : undefined) === (v2.propertyTypeId ?? undefined),
    ],
    ['features', sameSet(features, v2.featureIds)],
    ['images', !img || img.attached + img.pending >= img.expected],
  ]);
}

/**
 * A staged legacy contact against the contact it became. A contact that took in another legacy contact or one the
 * agency already had (same e-mail or phone: `shared`) keeps its own values — its differences are explained; so are
 * left-out identifiers the load reported (`invalid`).
 */
export function compareContact(
  raw: unknown,
  v2: crm.LegacyContactSnapshot,
  x: { shared: boolean; reasons: ReadonlySet<string> },
): FieldDiff {
  const parsed = LegacyContactRow.safeParse(raw);
  if (!parsed.success) return { fields: ['row'], explainedFields: [] };
  const c = parsed.data;
  const ids = crm.legacyIdentifiers(listOf(c.email), listOf(c.phone));
  const shared = x.shared || v2.source !== 'IMPORT';
  const stored = { emails: new Set(v2.emails), phones: new Set(v2.phones) };
  return diff([
    ['firstName', (c.first_name || null) === v2.firstName, shared],
    ['lastName', (c.last_name || null) === v2.lastName, shared],
    ['language', (c.language ? contentLocale(c.language) : null) === v2.language, shared],
    ['emails', ids.emails.every((e) => stored.emails.has(e)), shared || x.reasons.has('invalid')],
    ['phones', ids.phones.every((p) => stored.phones.has(p)), shared || x.reasons.has('invalid')],
  ]);
}

/** A staged legacy lead against the lead it became (its contact and listing through this agency's maps). */
export function compareLead(
  raw: unknown,
  v2: crm.LegacyLeadSnapshot,
  x: {
    contacts: ReadonlyMap<string, string>;
    targets: ReadonlyMap<string, string>;
    reasons: ReadonlySet<string>;
  },
): FieldDiff {
  const parsed = LegacyLeadRow.safeParse(raw);
  if (!parsed.success) return { fields: ['row'], explainedFields: [] };
  const l = parsed.data;
  const status = l.status === undefined ? 'NEW' : LEAD_STATUS[enumKey(l.status)];
  const source = (l.source && LEAD_SOURCE[enumKey(l.source)]) || 'MANUAL';
  const target = (l.property_id && x.targets.get(l.property_id)) || null;
  return diff([
    ['status', v2.status === status],
    ['source', v2.source === source],
    ['contact', x.contacts.get(l.contact_id) === v2.contactId],
    ['target', target === v2.targetId, x.reasons.has('orphan')],
  ]);
}

// ── The report ─────────────────────────────────────────────────────────────────────────────────────────────────────

const rate = (n: number, of: number) => (of === 0 ? 0 : n / of);

/**
 * Settles totals, rates and PASS / FAIL: every rate (unexplained rows and images, differing samples, failed URL
 * checks) under the target and no failed load batch.
 */
export function settleReport(
  r: Omit<MigrationValidationReport, 'status' | 'totals'> & { totals?: unknown },
): MigrationValidationReport {
  const legacy = r.counts.reduce((s, c) => s + (c.legacyRows ?? c.staged), 0) + (r.images.legacy ?? r.images.staged);
  const unexplained = r.counts.reduce((s, c) => s + c.unexplained, 0) + r.images.unexplained;
  const totals = { legacy, unexplained, rate: rate(unexplained, legacy) };
  const sample = { ...r.sample, rate: rate(r.sample.differing, r.sample.rows) };
  const urls = { ...r.urls, rate: rate(r.urls.failed, r.urls.checked) };
  const max = MIGRATION_VALIDATION_MAX_UNEXPLAINED_RATE;
  const pass =
    r.failedBatches.length === 0 &&
    // nothing compared is not a pass: an agency with staged rows and nothing mapped has unexplained rows instead
    totals.rate < max &&
    sample.rate < max &&
    urls.rate < max;
  return { ...r, totals, sample, urls, status: pass ? 'PASS' : 'FAIL' };
}

/** Builds the validation report of one legacy agency (no write: `recordValidationReport` stores it). */
export async function validateLegacyAgency(input: ValidateLegacyAgencyInput): Promise<MigrationValidationReport> {
  const { legacyAgencyId, agencyId } = input;
  const size = Math.min(
    MIGRATION_VALIDATION_SAMPLE_MAX,
    Math.max(1, Math.trunc(input.sampleSize ?? MIGRATION_VALIDATION_SAMPLE_DEFAULT)),
  );

  // What the load explained: failed rows per entity, issues by reason and per legacy id, failed batches.
  const checkpoints = await withSystem(reason, (tx) => vrepo.agencyCheckpoints(tx, legacyAgencyId));
  const explained = new Map<string, number>();
  const byReason = new Map<string, Record<string, number>>();
  const reasonsOf = new Map<string, Set<string>>();
  const failedBatches: MigrationValidationReport['failedBatches'] = [];
  for (const c of checkpoints) {
    if (c.status === 'FAILED') {
      failedBatches.push({ entity: c.entity, seq: c.seq, error: c.error });
      continue;
    }
    for (const [entity, counts] of Object.entries(c.counts ?? {})) {
      explained.set(entity, (explained.get(entity) ?? 0) + (counts.failed ?? 0));
    }
    for (const issue of c.issues as { entity?: string; legacyId?: string; reason?: string }[]) {
      if (!issue?.entity || !issue.reason) continue;
      const per = byReason.get(issue.entity) ?? {};
      per[issue.reason] = (per[issue.reason] ?? 0) + 1;
      byReason.set(issue.entity, per);
      if (issue.legacyId) {
        const k = `${issue.entity}:${issue.legacyId}`;
        reasonsOf.set(k, (reasonsOf.get(k) ?? new Set()).add(issue.reason));
      }
    }
  }
  const reasons = (entity: string, legacyId: string) => reasonsOf.get(`${entity}:${legacyId}`) ?? new Set<string>();

  const counts: MigrationValidationCounts[] = [];
  const images = { staged: 0, expected: 0, attached: 0, pending: 0 };
  const candidates = new Map<Entity, Candidate[]>();
  /** Contacts several legacy contacts became (an e-mail or phone they share). */
  const sharedContacts = new Set<string>();

  for (const entity of ENTITIES) {
    const source = input.staged[STAGED_OF[entity] as LegacyStagingEntity];
    const legacyRows = input.legacyRows?.[entity] ?? null;
    let staged = 0;
    let mapped = 0;
    const seen = new Set<string>();
    const contactTargets = new Set<string>();
    let sample: Candidate[] = [];
    if (source) {
      for await (const batch of source.batches(VALIDATION_BATCH_ROWS)) {
        staged += batch.length;
        const rows = batch.flatMap((row) => {
          const id = idOf(row);
          if (!id || seen.has(id)) return [];
          seen.add(id);
          return [{ id, row }];
        });
        const more: Candidate[] = await withSystem(reason, async (tx) => {
          const { own } = await agencyTargets(
            tx,
            entity as TenantEntity,
            rows.map((r) => r.id),
            agencyId,
          );
          const loaded = rows.filter((r) => own.has(r.id));
          mapped += loaded.length;
          if (entity === 'contact') {
            for (const r of loaded) {
              const target = own.get(r.id) as string;
              if (contactTargets.has(target)) sharedContacts.add(target);
              contactTargets.add(target);
            }
          }
          let states = new Map<string, ImageState>();
          if (entity === 'listing') {
            for (const r of rows) images.staged += imagesOf(r.row).length;
            states = await media.feedImageStates(
              tx,
              agencyId,
              loaded.map((r) => ({ listingId: own.get(r.id) as string, urls: imagesOf(r.row) })),
            );
            for (const s of states.values()) {
              images.expected += s.expected;
              images.attached += s.attached;
              images.pending += s.pending;
            }
          }
          if (!SAMPLED.has(entity)) return [];
          return loaded.map((r) => {
            const target = own.get(r.id) as string;
            return {
              key: sampleKey(legacyAgencyId, r.id),
              legacyId: r.id,
              newId: target,
              row: r.row,
              ...(entity === 'listing' ? { images: states.get(target) } : {}),
            };
          });
        });
        sample = keepSmallest(sample, more, size);
      }
    }
    const ex = explained.get(entity) ?? 0;
    counts.push({
      entity,
      legacyRows,
      staged,
      mapped,
      explained: ex,
      unexplained: Math.abs((legacyRows ?? staged) - staged) + Math.abs(staged - mapped - ex),
      issuesByReason: byReason.get(entity) ?? {},
    });
    if (SAMPLED.has(entity)) candidates.set(entity, sample);
  }

  // Sampled rows against v2: one transaction, a statement per entity and lookup.
  const listingSample = candidates.get('listing') ?? [];
  const contactSample = candidates.get('contact') ?? [];
  const leadSample = candidates.get('lead') ?? [];
  const samples: MigrationValidationSample[] = await withSystem(reason, async (tx) => {
    const out: MigrationValidationSample[] = [];
    out.push(...(await listingSamples(tx, agencyId, listingSample, reasons)));
    const contacts = new Map(
      (
        await crm.legacyContactSnapshots(
          tx,
          agencyId,
          contactSample.map((c) => c.newId),
        )
      ).map((s) => [s.id, s]),
    );
    for (const c of contactSample) {
      const v2 = contacts.get(c.newId);
      out.push(
        sampleOf(
          'contact',
          c,
          !v2
            ? null
            : v2.mergedIntoId
              ? { fields: [], explainedFields: ['merged'] }
              : v2.deleted
                ? null
                : compareContact(c.row, v2, {
                    shared: sharedContacts.has(c.newId),
                    reasons: reasons('contact', c.legacyId),
                  }),
        ),
      );
    }
    out.push(...(await leadSamples(tx, agencyId, leadSample, reasons)));
    return out;
  });

  // URL checks of the sampled listings: the public legacy lookup, then their images.
  const lookups = await withPublicRead((tx) =>
    repo.listingTargetsOf(
      tx,
      listingSample.map((c) => c.legacyId),
    ),
  );
  const resolved = new Map<string, string>();
  for (const l of lookups) if (l.entity === 'listing') resolved.set(l.legacyId, l.newId);
  const checks: MigrationValidationUrlCheck[] = listingSample.map((c) => {
    const found = resolved.get(c.legacyId);
    const lookup = found === undefined ? 'MISSING' : found === c.newId ? 'OK' : 'MISMATCH';
    const img = c.images ?? { expected: 0, attached: 0, pending: 0 };
    return {
      legacyId: c.legacyId,
      newId: c.newId,
      lookup,
      images: { checked: img.expected, attached: img.attached, pending: img.pending },
      pass: lookup === 'OK' && img.attached + img.pending >= img.expected,
    };
  });

  const fieldStats = new Map<string, { entity: string; field: string; compared: number; differing: number }>();
  for (const s of samples) {
    for (const f of s.fields) {
      const k = `${s.entity}:${f}`;
      const stat = fieldStats.get(k) ?? { entity: s.entity, field: f, compared: 0, differing: 0 };
      stat.differing += 1;
      fieldStats.set(k, stat);
    }
  }
  for (const stat of fieldStats.values()) stat.compared = samples.filter((s) => s.entity === stat.entity).length;

  const legacyImages = input.legacyRows?.image ?? null;
  return settleReport({
    legacyAgencyId,
    agencyId,
    counts,
    images: {
      legacy: legacyImages,
      ...images,
      unexplained:
        Math.abs((legacyImages ?? images.staged) - images.staged) +
        Math.max(0, images.expected - images.attached - images.pending),
    },
    sample: {
      size,
      rows: samples.length,
      differing: samples.filter((s) => s.outcome !== 'MATCH').length,
      rate: 0,
      fields: [...fieldStats.values()],
      samples,
    },
    urls: { checked: checks.length, failed: checks.filter((c) => !c.pass).length, rate: 0, checks },
    failedBatches,
  });
}

function sampleOf(entity: string, c: Candidate, d: FieldDiff | null): MigrationValidationSample {
  if (!d) return { entity, legacyId: c.legacyId, newId: c.newId, outcome: 'MISSING', fields: [], explainedFields: [] };
  return {
    entity,
    legacyId: c.legacyId,
    newId: c.newId,
    outcome: d.fields.length > 0 ? 'DIFF' : 'MATCH',
    fields: d.fields,
    explainedFields: d.explainedFields,
  };
}

const field = (row: unknown, key: string): string[] => {
  const v = (row as Record<string, unknown> | null)?.[key];
  return typeof v === 'string' || typeof v === 'number' ? [String(v).trim()] : [];
};

async function listingSamples(
  tx: Tx,
  agencyId: string,
  sample: readonly Candidate[],
  reasons: (entity: string, legacyId: string) => ReadonlySet<string>,
): Promise<MigrationValidationSample[]> {
  if (sample.length === 0) return [];
  const rows = sample.map((c) => c.row);
  const featureIds = rows.flatMap((r) => {
    const v = (r as Record<string, unknown> | null)?.feature_ids;
    return Array.isArray(v) ? v.map(String) : [];
  });
  const locations = await targetsOf(
    tx,
    'location',
    rows.flatMap((r) => field(r, 'location_id')),
  );
  const types = await targetsOf(
    tx,
    'propertyType',
    rows.flatMap((r) => field(r, 'property_type_id')),
  );
  const features = await targetsOf(tx, 'feature', featureIds);
  const v2 = new Map(
    (
      await properties.legacyListingSnapshots(
        tx,
        agencyId,
        sample.map((c) => c.newId),
      )
    ).map((s) => [s.id, s]),
  );
  return sample.map((c) => {
    const s = v2.get(c.newId);
    return sampleOf(
      'listing',
      c,
      s
        ? compareListing(c.row, s, {
            locations,
            types,
            features,
            reasons: reasons('listing', c.legacyId),
            images: c.images,
          })
        : null,
    );
  });
}

async function leadSamples(
  tx: Tx,
  agencyId: string,
  sample: readonly Candidate[],
  reasons: (entity: string, legacyId: string) => ReadonlySet<string>,
): Promise<MigrationValidationSample[]> {
  if (sample.length === 0) return [];
  const rows = sample.map((c) => c.row);
  const contacts = (
    await agencyTargets(
      tx,
      'contact',
      rows.flatMap((r) => field(r, 'contact_id')),
      agencyId,
    )
  ).own;
  const propertyIds = rows.flatMap((r) => field(r, 'property_id'));
  const listings = (await agencyTargets(tx, 'listing', propertyIds, agencyId)).own;
  const units = (await agencyTargets(tx, 'unit', propertyIds, agencyId)).own;
  // as the load: a legacy property id names a listing first, else a unit
  const targets = new Map([...units, ...listings]);
  const v2 = new Map(
    (
      await crm.legacyLeadSnapshots(
        tx,
        agencyId,
        sample.map((c) => c.newId),
      )
    ).map((s) => [s.id, s]),
  );
  return sample.map((c) => {
    const s = v2.get(c.newId);
    return sampleOf(
      'lead',
      c,
      s ? compareLead(c.row, s, { contacts, targets, reasons: reasons('lead', c.legacyId) }) : null,
    );
  });
}

/** Stores a report as the legacy agency's latest (`withSystem()`, the validation script). Answers its id. */
export async function recordValidationReport(tx: Tx, report: MigrationValidationReport): Promise<string> {
  const id = newId();
  await vrepo.insertReport(tx, {
    id,
    legacyAgencyId: report.legacyAgencyId,
    targetAgencyId: report.agencyId,
    status: report.status,
    legacyRows: report.totals.legacy,
    unexplained: report.totals.unexplained,
    sampleDiffs: report.sample.differing,
    urlFailures: report.urls.failed,
    report,
    createdAt: clock.now(),
  });
  return id;
}

/** The v2 agency a legacy agency became (its recorded map), or null when it was never loaded. One statement. */
export async function agencyOfLegacy(tx: Tx, legacyAgencyId: string): Promise<string | null> {
  return (await repo.getMaps(tx, 'agency', [legacyAgencyId])).get(legacyAgencyId)?.newId ?? null;
}
