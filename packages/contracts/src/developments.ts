/** developments DTOs (PATTERNS §9): Zod schemas and inferred types for params, bodies and responses. */
import { z } from 'zod';
import { Commission } from './agency-profile';
import { CurrencyCode, Money, PageQuery, pageOf } from './common';
import {
  DEVELOPMENT_DOCUMENT_KINDS,
  MAX_DEVELOPMENT_NAME,
  MAX_UNITS_PER_BULK,
  MAX_UNITS_PER_DEVELOPMENT,
} from './values';

export const DevelopmentStatus = z.enum(['OFF_PLAN', 'UNDER_CONSTRUCTION', 'KEY_READY', 'SOLD_OUT']);
export type DevelopmentStatus = z.infer<typeof DevelopmentStatus>;
/** OPEN: every verified agency · PRIVATE_NETWORK: only the agencies the owner names (PLAN §6). */
export const DevelopmentAccess = z.enum(['OPEN', 'PRIVATE_NETWORK']);
export type DevelopmentAccess = z.infer<typeof DevelopmentAccess>;
export const DevelopmentManager = z.enum(['DEVELOPER', 'DATA_OPS']);
export const UnitStatus = z.enum(['AVAILABLE', 'RESERVED', 'SOLD']);
export type UnitStatus = z.infer<typeof UnitStatus>;
export const Orientation = z.enum(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']);
export const PriceListExtractor = z.enum(['AI', 'HUMAN']);

/** Agencies a PRIVATE_NETWORK development may name. */
export const MAX_DEVELOPMENT_ACCESS = 200;

const Coordinates = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).strict();
const Ref = z.string().trim().min(1).max(40);
const Area = z.number().min(0).max(1_000_000);
const PriceCents = z.number().int().min(0).max(100_000_000_000);

export const DevelopmentParams = z.object({ id: z.uuid() }).strict();
export type DevelopmentParams = z.infer<typeof DevelopmentParams>;

export const DevelopmentDto = z.object({
  id: z.uuid(),
  /** Null in Client Mode on another agency's development (white label). */
  agencyId: z.uuid().nullable(),
  ref: z.string(),
  name: z.string(),
  status: DevelopmentStatus,
  completionDate: z.iso.date().nullable(),
  locationId: z.uuid(),
  coordinates: Coordinates.nullable(),
  /** Offered to collaborating agencies; null when none is set, and always in Client Mode. */
  commission: Commission.nullable(),
  currency: CurrencyCode,
  managedBy: DevelopmentManager,
  lastVerifiedAt: z.iso.datetime().nullable(),
  /** The owner's sharing settings; null for other agencies. */
  access: z.object({ kind: DevelopmentAccess, allowedAgencyIds: z.array(z.uuid()) }).nullable(),
  version: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type DevelopmentDto = z.infer<typeof DevelopmentDto>;
export const DevelopmentPage = pageOf(DevelopmentDto);
export type DevelopmentPage = z.infer<typeof DevelopmentPage>;

export const ListDevelopmentsQuery = PageQuery.extend({}).strict();
export type ListDevelopmentsQuery = z.infer<typeof ListDevelopmentsQuery>;

export const CreateDevelopmentBody = z
  .object({
    ref: Ref,
    name: z.string().trim().min(1).max(MAX_DEVELOPMENT_NAME),
    status: DevelopmentStatus.optional(),
    completionDate: z.iso.date().nullable().optional(),
    locationId: z.uuid(),
    coordinates: Coordinates.nullable().optional(),
    commission: Commission.nullable().optional(),
    currency: CurrencyCode.optional(),
    managedBy: DevelopmentManager.optional(),
  })
  .strict();
export type CreateDevelopmentBody = z.infer<typeof CreateDevelopmentBody>;

export const UpdateDevelopmentBody = CreateDevelopmentBody.omit({ currency: true })
  .partial()
  .extend({
    version: z.number().int().min(1),
    /** The maintainer confirms units and prices are current (freshness SLA 24 h): sets `lastVerifiedAt`. */
    verified: z.literal(true).optional(),
  })
  .strict();
export type UpdateDevelopmentBody = z.infer<typeof UpdateDevelopmentBody>;

/** Who sees the development: OPEN, or PRIVATE_NETWORK with the agencies named (replaces the list). */
export const SetDevelopmentAccessBody = z
  .object({
    version: z.number().int().min(1),
    kind: DevelopmentAccess,
    allowedAgencyIds: z
      .array(z.uuid())
      .max(MAX_DEVELOPMENT_ACCESS)
      .refine((ids) => new Set(ids).size === ids.length, 'duplicate agency'),
  })
  .strict();
export type SetDevelopmentAccessBody = z.infer<typeof SetDevelopmentAccessBody>;

export const DevelopmentVersionQuery = z.object({ version: z.coerce.number().int().min(1) }).strict();

// ── Units ────────────────────────────────────────────────────────────────────────────────────────────────────

export const UnitParams = z.object({ id: z.uuid(), unitId: z.uuid() }).strict();
export type UnitParams = z.infer<typeof UnitParams>;

export const UnitDto = z.object({
  id: z.uuid(),
  developmentId: z.uuid(),
  phaseId: z.uuid().nullable(),
  ref: z.string(),
  propertyTypeId: z.uuid(),
  bedrooms: z.number().int().nullable(),
  bathrooms: z.number().int().nullable(),
  internalM2: z.number().nullable(),
  terraceM2: z.number().nullable(),
  plotM2: z.number().nullable(),
  floor: z.number().int().nullable(),
  orientation: Orientation.nullable(),
  price: Money.nullable(),
  status: UnitStatus,
  /** The unit's own commission (the development's applies when null); always null in Client Mode. */
  commission: Commission.nullable(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type UnitDto = z.infer<typeof UnitDto>;
export const UnitPage = pageOf(UnitDto);
export type UnitPage = z.infer<typeof UnitPage>;
export const UnitList = z.object({ items: z.array(UnitDto) });
export type UnitList = z.infer<typeof UnitList>;

export const ListUnitsQuery = PageQuery.extend({ status: UnitStatus.optional() }).strict();
export type ListUnitsQuery = z.infer<typeof ListUnitsQuery>;

const UnitFields = z
  .object({
    ref: Ref,
    phaseId: z.uuid().nullable().optional(),
    propertyTypeId: z.uuid(),
    bedrooms: z.number().int().min(0).max(1000).nullable().optional(),
    bathrooms: z.number().int().min(0).max(1000).nullable().optional(),
    internalM2: Area.nullable().optional(),
    terraceM2: Area.nullable().optional(),
    plotM2: Area.nullable().optional(),
    floor: z.number().int().min(-10).max(300).nullable().optional(),
    orientation: Orientation.nullable().optional(),
    priceCents: PriceCents.nullable().optional(),
    status: UnitStatus.optional(),
    commission: Commission.nullable().optional(),
  })
  .strict();
export type UnitFields = z.infer<typeof UnitFields>;

/** One or many units (a CSV upload); references are unique within the development. */
export const CreateUnitsBody = z
  .object({
    units: z
      .array(UnitFields)
      .min(1)
      .max(MAX_UNITS_PER_BULK)
      .refine((us) => new Set(us.map((u) => u.ref)).size === us.length, 'duplicate unit ref'),
  })
  .strict();
export type CreateUnitsBody = z.infer<typeof CreateUnitsBody>;

export const UpdateUnitBody = UnitFields.partial()
  .extend({ version: z.number().int().min(1) })
  .strict();
export type UpdateUnitBody = z.infer<typeof UpdateUnitBody>;

/** The same change on many units (availability toggles, a price, a phase); at least one field. */
export const BulkUpdateUnitsBody = z
  .object({
    unitIds: z
      .array(z.uuid())
      .min(1)
      .max(MAX_UNITS_PER_BULK)
      .refine((ids) => new Set(ids).size === ids.length, 'duplicate unit'),
    patch: z
      .object({
        status: UnitStatus.optional(),
        priceCents: PriceCents.nullable().optional(),
        phaseId: z.uuid().nullable().optional(),
        commission: Commission.nullable().optional(),
      })
      .strict()
      .refine((p) => Object.keys(p).length > 0, 'empty patch'),
  })
  .strict();
export type BulkUpdateUnitsBody = z.infer<typeof BulkUpdateUnitsBody>;

// ── Price lists ──────────────────────────────────────────────────────────────────────────────────────────────

export const PriceListParams = z.object({ id: z.uuid(), version: z.coerce.number().int().min(1) }).strict();
export type PriceListParams = z.infer<typeof PriceListParams>;

/** One line of a price list: a unit by reference, its price (null: on request) and, optionally, its status. */
export const PriceListEntry = z
  .object({ ref: Ref, priceCents: PriceCents.nullable(), status: UnitStatus.optional() })
  .strict();
export type PriceListEntry = z.infer<typeof PriceListEntry>;

export const CreatePriceListBody = z
  .object({
    effectiveFrom: z.iso.date(),
    sourceDocumentId: z.uuid().nullable().optional(),
    extractedBy: PriceListExtractor.optional(),
    entries: z
      .array(PriceListEntry)
      .min(1)
      .max(MAX_UNITS_PER_DEVELOPMENT)
      .refine((es) => new Set(es.map((e) => e.ref)).size === es.length, 'duplicate unit ref'),
  })
  .strict();
export type CreatePriceListBody = z.infer<typeof CreatePriceListBody>;

/** A price list against the units as they are: new references, missing ones, and changed prices or statuses. */
export const PriceListDiff = z.object({
  added: z.array(z.object({ ref: z.string(), priceCents: z.number().int().nullable() })),
  removed: z.array(z.object({ unitId: z.uuid(), ref: z.string(), priceCents: z.number().int().nullable() })),
  changed: z.array(
    z.object({
      unitId: z.uuid(),
      ref: z.string(),
      priceCents: z.object({ from: z.number().int().nullable(), to: z.number().int().nullable() }).nullable(),
      status: z.object({ from: UnitStatus, to: UnitStatus }).nullable(),
    }),
  ),
  unchanged: z.number().int(),
});
export type PriceListDiff = z.infer<typeof PriceListDiff>;

export const PriceListDto = z.object({
  id: z.uuid(),
  developmentId: z.uuid(),
  version: z.number().int(),
  effectiveFrom: z.iso.date(),
  sourceDocumentId: z.uuid().nullable(),
  extractedBy: PriceListExtractor,
  /** Set when a person approved it and its prices were applied to the units. */
  reviewedAt: z.iso.datetime().nullable(),
  reviewedByUserId: z.uuid().nullable(),
  /** Against the units when uploaded; once approved, what was applied. */
  diff: PriceListDiff,
  createdAt: z.iso.datetime(),
});
export type PriceListDto = z.infer<typeof PriceListDto>;
/** The diff's size: a list of versions carries these, the full diff comes from `GET …/price-lists/:version` (S4-F5). */
export const PriceListCounts = z.object({
  added: z.number().int(),
  removed: z.number().int(),
  changed: z.number().int(),
  unchanged: z.number().int(),
});
export type PriceListCounts = z.infer<typeof PriceListCounts>;
export const PriceListSummaryDto = PriceListDto.omit({ diff: true }).extend({ counts: PriceListCounts });
export type PriceListSummaryDto = z.infer<typeof PriceListSummaryDto>;
export const PriceListPage = pageOf(PriceListSummaryDto);
export type PriceListPage = z.infer<typeof PriceListPage>;

// ── Development documents (S4-F4) ────────────────────────────────────────────────────────────────────────────

export const DevelopmentDocumentKind = z.enum(DEVELOPMENT_DOCUMENT_KINDS);
export type DevelopmentDocumentKind = z.infer<typeof DevelopmentDocumentKind>;
/** Documents per development. */
export const DEVELOPMENT_DOCUMENTS_MAX = 100;
/** How long an opened document's signed URL works. */
export const DEVELOPMENT_DOCUMENT_URL_TTL_SECONDS = 300;

export const UploadDevelopmentDocumentQuery = z
  .object({
    fileName: z.string().trim().min(1).max(200),
    kind: DevelopmentDocumentKind.optional(),
    /** Readable by the agencies the development is shared with; owner-only when false (the default). */
    shared: z.enum(['true', 'false']).optional(),
  })
  .strict();
export type UploadDevelopmentDocumentQuery = z.infer<typeof UploadDevelopmentDocumentQuery>;

export const UpdateDevelopmentDocumentBody = z
  .object({ kind: DevelopmentDocumentKind.optional(), shared: z.boolean().optional() })
  .strict()
  .refine((b) => b.kind !== undefined || b.shared !== undefined, 'nothing to change');
export type UpdateDevelopmentDocumentBody = z.infer<typeof UpdateDevelopmentDocumentBody>;

export const DevelopmentDocumentDto = z.object({
  id: z.uuid(),
  developmentId: z.uuid(),
  kind: DevelopmentDocumentKind,
  fileName: z.string(),
  sizeBytes: z.number().int(),
  shared: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type DevelopmentDocumentDto = z.infer<typeof DevelopmentDocumentDto>;

export const DevelopmentDocumentList = z.object({ items: z.array(DevelopmentDocumentDto) });
export type DevelopmentDocumentList = z.infer<typeof DevelopmentDocumentList>;

export const DevelopmentDocumentParams = z.object({ id: z.uuid(), documentId: z.uuid() }).strict();
export type DevelopmentDocumentParams = z.infer<typeof DevelopmentDocumentParams>;

/** A short signed GET; the file downloads under its name. */
export const DevelopmentDocumentUrlDto = z.object({ url: z.string(), expiresAt: z.iso.datetime() });
export type DevelopmentDocumentUrlDto = z.infer<typeof DevelopmentDocumentUrlDto>;
