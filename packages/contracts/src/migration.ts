/** migration DTOs (PATTERNS §9): Zod schemas and inferred types for params, bodies and responses. */
import { z } from 'zod';

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
