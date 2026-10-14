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
export const LegacyTaxonomyExtract = z.object({
  locations: z
    .array(z.object({ ...LegacyItem, parentId: LegacyId.nullable().default(null) }))
    .max(100_000)
    .default([]),
  propertyTypes: z.array(z.object(LegacyItem)).max(10_000).default([]),
  features: z.array(z.object(LegacyItem)).max(10_000).default([]),
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
