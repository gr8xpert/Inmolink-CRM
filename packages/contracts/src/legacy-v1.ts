/**
 * Legacy website API shim `/v1` (S8-02, PLAN §9.3, §3 #43): what legacy client websites send and get back.
 *
 * **ASSUMED CONTRACT.** No real legacy traffic or golden file exists yet (S8-01 is BLOCKED-HUMAN H2), so these shapes
 * are the endpoints the S8-01 tooling was tested on (`GET /api/properties`, `/api/properties/{id}`, `/api/types`;
 * auth parameter `api_key`; `lang`, `page`) and a plausible response body for each. When the recorded golden files
 * (`tests/golden/<endpoint>/<case>.json`) arrive, they are the contract: change these schemas and the reshaping in
 * core (`website-api` `legacy-v1.ts`) until `legacy-v1.golden.int.test.ts` passes with 100% parity. `/v1` is frozen
 * once it does (api rules: changed only with a golden update approved in STATUS).
 *
 * Query schemas are not strict: a legacy site may send parameters the shim does not know (cache busters, tracking),
 * and refusing them would break the site. Unknown parameters are dropped.
 */
import { z } from 'zod';

/** The query parameter legacy sites send their key in (S8-01 synthetic logs). Header keys work too. */
export const LEGACY_KEY_PARAM = 'api_key';
/** Legacy API paths start with this; the legacy hostname's requests are rewritten to `/v1` at the edge (cutover). */
export const LEGACY_PATH_PREFIX = '/api';
/** The shim's own path prefix. */
export const LEGACY_SHIM_PREFIX = '/v1';

/** A legacy path (`/api/properties/12`) as the shim serves it (`/v1/properties/12`); other paths unchanged. */
export function legacyShimPath(path: string): string {
  if (path === LEGACY_PATH_PREFIX || path.startsWith(`${LEGACY_PATH_PREFIX}/`)) {
    return LEGACY_SHIM_PREFIX + path.slice(LEGACY_PATH_PREFIX.length);
  }
  return path;
}

/** The deepest result a legacy page may reach (the search engine's cap, `SEARCH_RESULT_CAP`). */
export const LEGACY_MAX_RESULTS = 10_000;

const LegacyLang = z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/);
const keyParam = { [LEGACY_KEY_PARAM]: z.string().max(200).optional() };
/** A comma-separated list of legacy ids (`?type=3,7`). */
const LegacyIdList = z.preprocess(
  (v) =>
    typeof v === 'string'
      ? v
          .split(',')
          .map((x) => x.trim())
          .filter((x) => x !== '')
      : v,
  z
    .array(
      z
        .string()
        .max(64)
        .regex(/^[\w-]+$/),
    )
    .min(1)
    .max(20),
);
const Euros = z.coerce.number().int().min(0).max(1_000_000_000_000);
const Count = z.coerce.number().int().min(0).max(50);

export const LegacyLangQuery = z.object({ ...keyParam, lang: LegacyLang.optional() });
export type LegacyLangQuery = z.infer<typeof LegacyLangQuery>;

/** `GET /v1/properties` (legacy `GET /api/properties`): the site's listings, one page per `page`. */
export const LegacyPropertiesQuery = z.object({
  ...keyParam,
  lang: LegacyLang.optional(),
  page: z.coerce.number().int().min(1).max(LEGACY_MAX_RESULTS).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  /** Legacy property type ids (any of). */
  type: LegacyIdList.optional(),
  /** Legacy location ids (anywhere under any of them). */
  location: LegacyIdList.optional(),
  /** Legacy feature ids (every one of them). */
  feature: LegacyIdList.optional(),
  /** `rent`: long-term rentals; `holiday`: short-term (S8-02 Decision — the same names the answers show). */
  transaction: z.enum(['sale', 'rent', 'holiday']).optional(),
  min_price: Euros.optional(),
  max_price: Euros.optional(),
  beds: Count.optional(),
  baths: Count.optional(),
  /** A reference or free text. */
  q: z.string().trim().min(1).max(100).optional(),
  sort: z.enum(['newest', 'price_asc', 'price_desc']).default('newest'),
});
export type LegacyPropertiesQuery = z.infer<typeof LegacyPropertiesQuery>;

/** `GET /v1/properties/{id}`: a legacy property id, or a reference as the site shows it. */
export const LegacyPropertyParams = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[\w.-]+$/),
});
export type LegacyPropertyParams = z.infer<typeof LegacyPropertyParams>;

export const LegacyPropertySummary = z.strictObject({
  /** The legacy id when the listing came from legacy Inmolink, else the reference the site shows. */
  id: z.string(),
  ref: z.string(),
  kind: z.enum(['property', 'unit']),
  title: z.string(),
  status: z.enum(['available', 'under_offer', 'reserved', 'sold']),
  transaction: z.enum(['sale', 'rent', 'holiday']),
  /** Whole euros (legacy shows no cents); null on request or unknown. */
  price: z.number().int().nullable(),
  currency: z.string().length(3),
  price_on_request: z.boolean(),
  type: z.string(),
  /** The type's legacy id (its v2 id when it has none). */
  type_id: z.string(),
  location: z.string().nullable(),
  city: z.string().nullable(),
  province: z.string().nullable(),
  beds: z.number().int().nullable(),
  baths: z.number().int().nullable(),
  built: z.number().nullable(),
  plot: z.number().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  image: z.string().nullable(),
});
export type LegacyPropertySummary = z.infer<typeof LegacyPropertySummary>;

export const LegacyPropertyList = z.strictObject({
  status: z.literal('ok'),
  page: z.number().int(),
  per_page: z.number().int(),
  total: z.number().int(),
  total_pages: z.number().int(),
  properties: z.array(LegacyPropertySummary),
});
export type LegacyPropertyList = z.infer<typeof LegacyPropertyList>;

export const LegacyPropertyDetail = LegacyPropertySummary.extend({
  description: z.string().nullable(),
  terrace: z.number().nullable(),
  year_built: z.number().int().nullable(),
  energy_rating: z.string().nullable(),
  features: z.array(z.string()),
  images: z.array(z.string()),
  agency: z.strictObject({
    name: z.string(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    website: z.string().nullable(),
  }),
});
export type LegacyPropertyDetail = z.infer<typeof LegacyPropertyDetail>;

export const LegacyPropertyResponse = z.strictObject({ status: z.literal('ok'), property: LegacyPropertyDetail });
export type LegacyPropertyResponse = z.infer<typeof LegacyPropertyResponse>;

export const LegacyType = z.strictObject({ id: z.string(), name: z.string(), slug: z.string() });
export const LegacyTypesResponse = z.strictObject({ status: z.literal('ok'), types: z.array(LegacyType) });
export type LegacyTypesResponse = z.infer<typeof LegacyTypesResponse>;

/** Every `/v1` error (legacy sites test `status`): never the v2 `{ error: { code } }` envelope. */
export const LegacyError = z.strictObject({ status: z.literal('error'), message: z.string() });
export type LegacyError = z.infer<typeof LegacyError>;
