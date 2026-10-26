/** migration DTOs (PATTERNS §9): Zod schemas and inferred types for params, bodies and responses. */
import { z } from 'zod';
import { PageQuery, pageOf } from './common';

const LegacyId = z.string().trim().min(1).max(100);
const Spelling = z.string().trim().min(1).max(200);

/** One legacy taxonomy row. `names` are its names per locale; `aliases` any other spellings it was written as. */
const LegacyItem = {
  id: LegacyId,
  name: Spelling,
  names: z.record(z.string().min(2).max(10), Spelling).default({}),
  aliases: z.array(Spelling).max(200).default([]),
};

/**
 * What the legacy dump is reduced to before import (ADR 0006: extract from a dump, never the live database).
 * The extractor for the real dump (H1) writes this shape; the importer needs nothing else from the dump.
 */
export const LegacyTaxonomyExtract = z
  .object({
    locations: z
      .array(z.object({ ...LegacyItem, parentId: LegacyId.nullable().default(null) }))
      .max(100_000)
      .default([]),
    propertyTypes: z.array(z.object(LegacyItem)).max(10_000).default([]),
    features: z.array(z.object(LegacyItem)).max(10_000).default([]),
  })
  .superRefine((x, ctx) => {
    // A legacy ID appears once per kind: two rows with one ID cannot both be mapped.
    for (const kind of ['locations', 'propertyTypes', 'features'] as const) {
      const seen = new Set<string>();
      x[kind].forEach((item, i) => {
        if (seen.has(item.id)) ctx.addIssue({ code: 'custom', path: [kind, i, 'id'], message: 'duplicate legacy id' });
        seen.add(item.id);
      });
    }
  });
export type LegacyTaxonomyExtract = z.infer<typeof LegacyTaxonomyExtract>;

export const LEGACY_UNMAPPED_REASONS = [
  /** The name is blank or the parent chain is broken (missing parent, cycle). */
  'invalid',
  /** No location / type / feature with that spelling or anything close. */
  'no_match',
  /** Two canonical entries share the spelling; only staff can tell which one the legacy row meant. */
  'ambiguous',
  /** A close candidate exists but below the accept threshold; staff decide. */
  'low_confidence',
  /** The match does not sit under the location the legacy parent maps to; the candidate is that match. */
  'parent_mismatch',
] as const;
export type LegacyUnmappedReason = (typeof LEGACY_UNMAPPED_REASONS)[number];

export const LegacyTaxonomyReport = z.object({
  counts: z.record(
    z.enum(['location', 'propertyType', 'feature']),
    z.object({
      total: z.number().int(),
      mapped: z.number().int(),
      exact: z.number().int(),
      fuzzy: z.number().int(),
      /** Kept on a staff-set map (`method = 'manual'`): its target is used as is, no alias is written. */
      manual: z.number().int(),
      unmapped: z.number().int(),
    }),
  ),
  /** Aliases written (one per legacy spelling that did not already resolve to its target). */
  aliasesAdded: z.number().int(),
  /** Legacy IDs whose existing map pointed somewhere else and was replaced. */
  remapped: z.number().int(),
  unmapped: z.array(
    z.object({
      entity: z.enum(['location', 'propertyType', 'feature']),
      legacyId: z.string(),
      name: z.string(),
      reason: z.enum(LEGACY_UNMAPPED_REASONS),
      /** Closest canonical entry and its similarity, as a hint for staff. */
      candidateId: z.string().nullable(),
      candidateScore: z.number().nullable(),
      /** Set when the parent of an unmapped location is unmapped too. */
      parentUnmapped: z.boolean(),
    }),
  ),
  /** Spellings not written as aliases because another entry owns them. */
  aliasConflicts: z.array(
    z.object({
      entity: z.enum(['location', 'propertyType', 'feature']),
      legacyId: z.string(),
      spelling: z.string(),
      ownerId: z.string(),
    }),
  ),
});
export type LegacyTaxonomyReport = z.infer<typeof LegacyTaxonomyReport>;

// ── Legacy entity loads (S4-04; reused by S14-02) ───────────────────────────────────────────────────────────────

/**
 * A legacy key as staged (S14-01 writes the legacy column as is: number or text). Trimmed text, never empty: the key
 * `legacy_id_maps` keeps for good.
 */
export const LegacyKey = z.union([z.string(), z.number().int()]).transform(String).pipe(LegacyId);

/** Optional staged value: legacy NULLs and empty strings both mean "not set". */
const opt = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === null || v === '' ? undefined : v), schema.optional());
const num = z.coerce.number().finite();

/**
 * A legacy new-build project as staged (`developments.ndjson`). The column names are the best-known legacy shape
 * (PLAN §14) and are replaced once H1 delivers the schema; unknown columns are ignored. Prices are whole euros.
 */
export const LegacyDevelopmentRow = z.object({
  id: LegacyKey,
  ref: opt(z.coerce.string().trim().min(1).max(40)),
  name: z.coerce.string().trim().min(1).max(160),
  status: opt(z.string().trim().max(40)),
  completion_date: opt(z.coerce.date()),
  location_id: opt(LegacyKey),
  lat: opt(num.min(-90).max(90)),
  lng: opt(num.min(-180).max(180)),
  /** Commission offered to collaborating agencies, in percent (data, never invented). */
  commission_percent: opt(num.gt(0).max(100)),
  currency: opt(
    z
      .string()
      .trim()
      .regex(/^[A-Za-z]{3}$/),
  ),
  /** Texts per locale: `[{ locale, title, description }]`. */
  translations: opt(
    z
      .array(
        z.object({
          locale: z.string().trim().min(2).max(10),
          title: opt(z.coerce.string().trim().max(300)),
          description: opt(z.coerce.string().max(50_000)),
        }),
      )
      .max(20),
  ),
});
export type LegacyDevelopmentRow = z.infer<typeof LegacyDevelopmentRow>;

/** A unit (plot, flat) of a legacy new-build project as staged (`development_units.ndjson`). */
export const LegacyUnitRow = z.object({
  id: LegacyKey,
  development_id: LegacyKey,
  ref: opt(z.coerce.string().trim().min(1).max(40)),
  property_type_id: opt(LegacyKey),
  bedrooms: opt(z.coerce.number().int().min(0).max(1000)),
  bathrooms: opt(z.coerce.number().int().min(0).max(1000)),
  built_m2: opt(num.min(0).max(1_000_000)),
  terrace_m2: opt(num.min(0).max(1_000_000)),
  plot_m2: opt(num.min(0).max(1_000_000)),
  floor: opt(z.coerce.number().int().min(-10).max(300)),
  orientation: opt(z.string().trim().max(10)),
  /** Whole euros. */
  price: opt(num.min(0).max(1_000_000_000)),
  status: opt(z.string().trim().max(40)),
});
export type LegacyUnitRow = z.infer<typeof LegacyUnitRow>;

export const LEGACY_LOAD_ISSUES = [
  /** The staged row fails its schema (missing name, malformed number, unknown status). */
  'invalid',
  /** The same legacy id is staged twice: the first row is loaded. */
  'duplicate',
  /** Its legacy location / property type has no map yet (run `legacy:taxonomy`, map what it reports). */
  'unmapped_location',
  'unmapped_property_type',
  /** A child whose parent was not loaded (missing from the staging, invalid or skipped). */
  'orphan',
  /** The v2 reference is taken by a record that is not this legacy row (made by hand). */
  'ref_taken',
  /** The database or a limit refused the row (`detail` holds the code). */
  'refused',
  /** Its legacy feature has no map yet: the row is loaded without it (`detail` names the legacy feature). */
  'unmapped_feature',
  /** The e-mail belongs to a member of another agency (a user is a member of one agency): handle before cutover. */
  'email_taken',
  /** The legacy id is mapped already, to another agency's row: never re-pointed (legacy ids are unique per table). */
  'legacy_id_collision',
  /** The agency has more members than its plan's seats (a warning for staff before cutover; `legacyId` = agency). */
  'over_seat',
] as const;
export type LegacyLoadIssueReason = (typeof LEGACY_LOAD_ISSUES)[number];

const LoadCounts = z.object({
  /** Rows the legacy database held for the agency (the extract's inventory); null when no inventory was given. */
  legacyRows: z.number().int().nullable(),
  /** Rows read from the staging file. */
  staged: z.number().int(),
  created: z.number().int(),
  updated: z.number().int(),
  unchanged: z.number().int(),
  /** Rows not loaded (each listed in `issues`). */
  failed: z.number().int(),
  /** Loaded rows with a `legacy_id_maps` row: created + updated + unchanged. */
  mapped: z.number().int(),
  /** `mapped` equals `legacyRows` (or `staged` without an inventory). */
  matches: z.boolean(),
});

/** The report of one agency's load of some legacy entities (the artifact of the run, PLAN §14 step 6). */
export const LegacyLoadReport = z.object({
  legacyAgencyId: z.string(),
  agencyId: z.string(),
  dryRun: z.boolean(),
  counts: z.record(z.string(), LoadCounts),
  issues: z.array(
    z.object({
      entity: z.string(),
      legacyId: z.string(),
      reason: z.enum(LEGACY_LOAD_ISSUES),
      detail: z.string().nullable(),
    }),
  ),
  /** Every entity's `matches`. */
  matches: z.boolean(),
});
export type LegacyLoadReport = z.infer<typeof LegacyLoadReport>;
export type LegacyLoadCounts = z.infer<typeof LoadCounts>;

// ── S14-02: the other legacy entities (staged column names are the best-known legacy shape until H1) ───────────────

const Email = z.string().trim().toLowerCase().pipe(z.email().max(254));
const When = opt(z.coerce.date());
const Text = (max: number) => opt(z.coerce.string().trim().max(max));
const Texts = opt(
  z
    .array(
      z.object({
        locale: z.string().trim().min(2).max(10),
        title: Text(300),
        description: opt(z.coerce.string().max(50_000)),
      }),
    )
    .max(20),
);

/** A legacy user (`users.ndjson`): becomes a member of the agency, signing in through a password reset (ADR 0006). */
export const LegacyUserRow = z.object({
  id: LegacyKey,
  email: Email,
  name: Text(120),
  /** Legacy role (`admin`, `agent`, …); unknown → `AGENT`. */
  role: Text(40),
  locale: Text(10),
  /** A disabled legacy user is not migrated (listed as `invalid`). */
  active: opt(z.union([z.boolean(), z.number(), z.string()])),
});
export type LegacyUserRow = z.infer<typeof LegacyUserRow>;

/** A legacy listing (`properties.ndjson`) with its texts, features and image URLs. Prices are whole euros. */
export const LegacyListingRow = z.object({
  id: LegacyKey,
  ref: opt(z.coerce.string().trim().min(1).max(40)),
  /** The legacy agent (`users.id`); unmapped → the agency's first admin. */
  agent_id: opt(LegacyKey),
  status: Text(40),
  /** `sale`, `rent`, `holiday` … */
  listing_type: Text(40),
  price: opt(num.min(0).max(10_000_000_000)),
  currency: opt(
    z
      .string()
      .trim()
      .regex(/^[A-Za-z]{3}$/),
  ),
  price_period: Text(20),
  price_on_request: opt(z.union([z.boolean(), z.number(), z.string()])),
  built_m2: opt(num.min(0).max(1_000_000)),
  plot_m2: opt(num.min(0).max(100_000_000)),
  terrace_m2: opt(num.min(0).max(1_000_000)),
  bedrooms: opt(z.coerce.number().int().min(0).max(1000)),
  bathrooms: opt(z.coerce.number().int().min(0).max(1000)),
  year_built: opt(z.coerce.number().int().min(1000).max(2200)),
  energy_rating: Text(20),
  lat: opt(num.min(-90).max(90)),
  lng: opt(num.min(-180).max(180)),
  location_id: opt(LegacyKey),
  property_type_id: opt(LegacyKey),
  feature_ids: opt(z.array(LegacyKey).max(500)),
  translations: Texts,
  /** Image URLs in order (re-ingested through the media pipeline). */
  images: opt(
    z
      .array(
        z
          .string()
          .trim()
          .pipe(z.url({ protocol: /^https?$/ }).max(2000)),
      )
      .max(200),
  ),
});
export type LegacyListingRow = z.infer<typeof LegacyListingRow>;

/** A legacy contact (`contacts.ndjson`). */
export const LegacyContactRow = z.object({
  id: LegacyKey,
  first_name: Text(100),
  last_name: Text(100),
  /** One or more, `;`/`,` separated, or an array. */
  email: opt(z.union([z.string(), z.array(z.string())])),
  phone: opt(z.union([z.string(), z.array(z.string())])),
  language: Text(10),
  /** `buyer`, `seller`, … (one or a list). */
  type: opt(z.union([z.string(), z.array(z.string())])),
  agent_id: opt(LegacyKey),
  consent_marketing: opt(z.union([z.boolean(), z.number(), z.string()])),
  notes: Text(10_000),
  created_at: When,
});
export type LegacyContactRow = z.infer<typeof LegacyContactRow>;

/** A legacy lead (`leads.ndjson`): an enquiry of a contact, maybe about a listing. */
export const LegacyLeadRow = z.object({
  id: LegacyKey,
  contact_id: LegacyKey,
  property_id: opt(LegacyKey),
  agent_id: opt(LegacyKey),
  /** `new`, `contacted`, `won`, `lost`, `spam` … */
  status: Text(40),
  source: Text(40),
  message: opt(z.coerce.string().max(4000)),
  locale: Text(10),
  created_at: When,
});
export type LegacyLeadRow = z.infer<typeof LegacyLeadRow>;

// ── S14-03: validation reports (PLAN §14 Path A step 6) ──────────────────────────────────────────────────────────────

/**
 * The target (PLAN §14 step 6): an agency passes when less than 0.5 % of its legacy rows and images differ without a
 * reason, and as little of its field sample and URL checks.
 */
export const MIGRATION_VALIDATION_MAX_UNEXPLAINED_RATE = 0.005;
/** Rows sampled per entity for field diffs (listings, contacts, leads); the script's `--sample` may change it. */
export const MIGRATION_VALIDATION_SAMPLE_DEFAULT = 50;
export const MIGRATION_VALIDATION_SAMPLE_MAX = 500;

export const MigrationValidationStatus = z.enum(['PASS', 'FAIL']);
export type MigrationValidationStatus = z.infer<typeof MigrationValidationStatus>;

/** One entity's counts: what the legacy database held, what was staged, what v2 has (mapped) and what is explained. */
export const MigrationValidationCounts = z.object({
  entity: z.string(),
  /** The extract's inventory count; null when none was given (the staging is then the reference). */
  legacyRows: z.number().int().nullable(),
  staged: z.number().int(),
  /** Staged rows with a `legacy_id_maps` row of this agency. */
  mapped: z.number().int(),
  /** Rows the load listed with a reason (`migration_batches` checkpoints): explained differences. */
  explained: z.number().int(),
  /** |legacy − staged| + |staged − mapped − explained|. */
  unexplained: z.number().int(),
  /** The load's issues by reason (failures and warnings; checkpoints keep at most 500 per batch). */
  issuesByReason: z.record(z.string(), z.number().int()),
});
export type MigrationValidationCounts = z.infer<typeof MigrationValidationCounts>;

/** Image counts: legacy, staged, expected after the load (per-listing cap, duplicates) and found in v2. */
export const MigrationValidationImages = z.object({
  /** The inventory's `property_images` count; null when not inventoried. */
  legacy: z.number().int().nullable(),
  /** Image URLs of the staged listings. */
  staged: z.number().int(),
  /** Image URLs of the loaded listings, distinct and capped per listing (what the media pipeline was asked for). */
  expected: z.number().int(),
  /** Expected URLs whose image is on the listing. */
  attached: z.number().int(),
  /** Expected URLs still queued for download. */
  pending: z.number().int(),
  /** Expected URLs neither attached nor queued (download failed), plus |legacy − staged|. */
  unexplained: z.number().int(),
});
export type MigrationValidationImages = z.infer<typeof MigrationValidationImages>;

/** A sampled row: field NAMES that differ between the staged legacy row and v2 (never the values: no personal data). */
export const MigrationValidationSample = z.object({
  entity: z.string(),
  legacyId: z.string(),
  newId: z.uuid().nullable(),
  /** `MISSING`: the mapped v2 row is gone (deleted). */
  outcome: z.enum(['MATCH', 'DIFF', 'MISSING']),
  /** Differences without a reason. */
  fields: z.array(z.string()),
  /** Differences the load reported (a reference taken, an invalid e-mail left out, a merged contact). */
  explainedFields: z.array(z.string()),
});
export type MigrationValidationSample = z.infer<typeof MigrationValidationSample>;

/** Per entity and field: how many sampled rows compared it and how many differ without a reason. */
export const MigrationValidationFieldStat = z.object({
  entity: z.string(),
  field: z.string(),
  compared: z.number().int(),
  differing: z.number().int(),
});

/**
 * URL checks of a sampled listing: its legacy id resolves through the public legacy lookup (what the v1 shim and the
 * legacy redirects use) to the listing it became, and its legacy image URLs are on the listing or queued.
 */
export const MigrationValidationUrlCheck = z.object({
  legacyId: z.string(),
  newId: z.uuid(),
  lookup: z.enum(['OK', 'MISMATCH', 'MISSING']),
  images: z.object({ checked: z.number().int(), attached: z.number().int(), pending: z.number().int() }),
  pass: z.boolean(),
});
export type MigrationValidationUrlCheck = z.infer<typeof MigrationValidationUrlCheck>;

/** The whole report of one legacy agency (stored as its snapshot). Ids, counts and field names only. */
export const MigrationValidationReport = z.object({
  legacyAgencyId: z.string(),
  agencyId: z.uuid(),
  status: MigrationValidationStatus,
  counts: z.array(MigrationValidationCounts),
  images: MigrationValidationImages,
  /** Unexplained differences over legacy rows and images (the < 0.5 % target). */
  totals: z.object({ legacy: z.number().int(), unexplained: z.number().int(), rate: z.number() }),
  sample: z.object({
    size: z.number().int(),
    rows: z.number().int(),
    differing: z.number().int(),
    rate: z.number(),
    fields: z.array(MigrationValidationFieldStat),
    samples: z.array(MigrationValidationSample),
  }),
  urls: z.object({
    checked: z.number().int(),
    failed: z.number().int(),
    rate: z.number(),
    checks: z.array(MigrationValidationUrlCheck),
  }),
  /** Load batches recorded FAILED (code, constraint, first legacy id): the load did not finish. */
  failedBatches: z.array(z.object({ entity: z.string(), seq: z.number().int(), error: z.string().nullable() })),
});
export type MigrationValidationReport = z.infer<typeof MigrationValidationReport>;

/** `GET /v1/staff/migration/validations`: each legacy agency's latest report, newest first. */
export const MigrationValidationListQuery = PageQuery.extend({ status: MigrationValidationStatus.optional() });
export type MigrationValidationListQuery = z.infer<typeof MigrationValidationListQuery>;

export const MigrationValidationParams = z.object({ id: z.uuid() }).strict();
export type MigrationValidationParams = z.infer<typeof MigrationValidationParams>;

export const MigrationValidationSummaryDto = z.object({
  id: z.uuid(),
  legacyAgencyId: z.string(),
  agencyId: z.uuid(),
  status: MigrationValidationStatus,
  legacyRows: z.number().int(),
  unexplained: z.number().int(),
  rate: z.number(),
  sampleDiffs: z.number().int(),
  urlFailures: z.number().int(),
  createdAt: z.iso.datetime(),
});
export type MigrationValidationSummaryDto = z.infer<typeof MigrationValidationSummaryDto>;

export const MigrationValidationPage = pageOf(MigrationValidationSummaryDto);
export type MigrationValidationPage = z.infer<typeof MigrationValidationPage>;

/** `GET /v1/staff/migration/validations/:id`: the drill-down. */
export const MigrationValidationDto = MigrationValidationSummaryDto.extend({ report: MigrationValidationReport });
export type MigrationValidationDto = z.infer<typeof MigrationValidationDto>;
