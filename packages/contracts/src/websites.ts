/**
 * Website sites (S7-01, PLAN §6 Website delivery, §9.1): an agency's websites, the listings each one shows
 * (inventory policy) and how it presents them (reference prefix, locales, contact overrides).
 */
import { z } from 'zod';
import { pageOf } from './common';

export const WebsiteMode = z.enum(['WP_PLUGIN', 'WIDGET', 'HOSTED']);
export type WebsiteMode = z.infer<typeof WebsiteMode>;

/**
 * Which listings a site shows. OWN_ONLY: the agency's own PUBLIC listings and units. OWN_PLUS_NETWORK: also other
 * agencies' PUBLIC listings shared with it (shared with everyone, or by an owner that prefers it). CUSTOM: either
 * or both, narrowed by `SiteInventoryFilters`.
 */
export const InventoryPolicy = z.enum(['OWN_ONLY', 'OWN_PLUS_NETWORK', 'CUSTOM']);
export type InventoryPolicy = z.infer<typeof InventoryPolicy>;

const uuidSet = (max: number) =>
  z
    .array(z.uuid())
    .max(max)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'duplicate id' })
    .default([]);

export const MAX_SITE_FILTER_IDS = 50;
const MAX_PRICE_CENTS = 100_000_000_000;

/**
 * A CUSTOM policy's filters: whose listings (own, network or both), anywhere under any of `locationIds` (empty:
 * anywhere), any of `propertyTypeIds` (empty: any), an inclusive price band, and new-build units on or off.
 */
export const SiteInventoryFilters = z
  .object({
    includeOwn: z.boolean().default(true),
    includeNetwork: z.boolean().default(false),
    locationIds: uuidSet(MAX_SITE_FILTER_IDS),
    propertyTypeIds: uuidSet(MAX_SITE_FILTER_IDS),
    priceMinCents: z.number().int().min(0).max(MAX_PRICE_CENTS).optional(),
    priceMaxCents: z.number().int().min(0).max(MAX_PRICE_CENTS).optional(),
    newBuilds: z.boolean().default(true),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.includeOwn && !v.includeNetwork) {
      ctx.addIssue({ code: 'custom', path: ['includeOwn'], message: 'a site shows own or network listings' });
    }
    if (v.priceMinCents !== undefined && v.priceMaxCents !== undefined && v.priceMinCents > v.priceMaxCents) {
      ctx.addIssue({ code: 'custom', path: ['priceMaxCents'], message: 'price band is empty' });
    }
  });
export type SiteInventoryFilters = z.infer<typeof SiteInventoryFilters>;

/** Contact details a site shows instead of the agency's (each one optional; at least one). */
export const SiteContact = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    email: z.email().max(254).optional(),
    phone: z
      .string()
      .trim()
      .regex(/^\+?[0-9 ()-]{6,24}$/)
      .optional(),
    whatsapp: z
      .string()
      .trim()
      .regex(/^\+?[0-9 ()-]{6,24}$/)
      .optional(),
  })
  .strict()
  .refine((c) => Object.values(c).some((v) => v !== undefined), { message: 'empty contact' });
export type SiteContact = z.infer<typeof SiteContact>;

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
/** A host name the site runs on: lower case, no scheme, port or path (`www.example.com`). */
export const SiteDomain = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(new RegExp(`^${LABEL}(?:\\.${LABEL})+$`));

export const MAX_SITE_DOMAINS = 10;
export const MAX_SITE_LOCALES = 20;

/** A content locale code (`en`, `es`, …); the service checks it against `CONTENT_LOCALES`. */
const SiteLocale = z.string().regex(/^[a-z]{2}$/);

const siteFields = {
  name: z.string().trim().min(1).max(80),
  domains: z
    .array(SiteDomain)
    .max(MAX_SITE_DOMAINS)
    .refine((d) => new Set(d).size === d.length, { message: 'duplicate domain' })
    .default([]),
  mode: WebsiteMode,
  inventoryPolicy: InventoryPolicy.default('OWN_ONLY'),
  /** Required with CUSTOM, refused otherwise. */
  inventoryFilters: SiteInventoryFilters.nullable().default(null),
  /** Upper-case letters and digits, 1–6 (`ABC` → `ABC-1234`); null: network references as they are. */
  referencePrefix: z
    .string()
    .trim()
    .regex(/^[A-Z0-9]{1,6}$/)
    .nullable()
    .default(null),
  /** The default locale first. */
  locales: z
    .array(SiteLocale)
    .min(1)
    .max(MAX_SITE_LOCALES)
    .refine((l) => new Set(l).size === l.length, { message: 'duplicate locale' }),
  contact: SiteContact.nullable().default(null),
};

function policyFilters(
  v: { inventoryPolicy?: InventoryPolicy; inventoryFilters?: SiteInventoryFilters | null },
  ctx: z.RefinementCtx,
) {
  if (v.inventoryPolicy === undefined) return;
  if (v.inventoryPolicy === 'CUSTOM' && !v.inventoryFilters) {
    ctx.addIssue({ code: 'custom', path: ['inventoryFilters'], message: 'a CUSTOM policy needs filters' });
  }
  if (v.inventoryPolicy !== 'CUSTOM' && v.inventoryFilters) {
    ctx.addIssue({ code: 'custom', path: ['inventoryFilters'], message: 'filters are for a CUSTOM policy' });
  }
}

/** `POST /v1/sites` (agency admins). */
export const CreateSiteBody = z.object(siteFields).strict().superRefine(policyFilters);
export type CreateSiteInput = z.infer<typeof CreateSiteBody>;

/**
 * `PATCH /v1/sites/:siteId` (agency admins): the fields sent replace the stored ones. The policy and its filters
 * change together (both or neither).
 */
export const UpdateSiteBody = z
  .object({
    /** The version the edit was made on (`SiteDto.version`): a newer stored one → 409 VERSION_CONFLICT. */
    version: z.number().int().min(1),
    name: siteFields.name.optional(),
    domains: siteFields.domains.optional(),
    mode: WebsiteMode.optional(),
    inventoryPolicy: InventoryPolicy.optional(),
    inventoryFilters: SiteInventoryFilters.nullable().optional(),
    referencePrefix: z
      .string()
      .trim()
      .regex(/^[A-Z0-9]{1,6}$/)
      .nullable()
      .optional(),
    locales: siteFields.locales.optional(),
    contact: SiteContact.nullable().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if ((v.inventoryPolicy === undefined) !== (v.inventoryFilters === undefined)) {
      ctx.addIssue({ code: 'custom', path: ['inventoryFilters'], message: 'send the policy and its filters together' });
    }
    policyFilters(v, ctx);
  });
export type UpdateSiteInput = z.infer<typeof UpdateSiteBody>;

export const SiteDto = z.object({
  id: z.uuid(),
  name: z.string(),
  domains: z.array(z.string()),
  mode: WebsiteMode,
  inventoryPolicy: InventoryPolicy,
  inventoryFilters: SiteInventoryFilters.nullable(),
  referencePrefix: z.string().nullable(),
  locales: z.array(z.string()),
  defaultLocale: z.string(),
  contact: SiteContact.nullable(),
  version: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type SiteDto = z.infer<typeof SiteDto>;
export const SitePage = pageOf(SiteDto);
export type SitePage = z.infer<typeof SitePage>;

export const SiteParams = z.object({ siteId: z.uuid() });
export type SiteParams = z.infer<typeof SiteParams>;
