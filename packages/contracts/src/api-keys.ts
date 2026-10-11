import { z } from 'zod';
import { pageOf } from './common';

/**
 * Website API keys (S1-05, PLAN §3 #30 §9.1). A **secret** key is for servers (WordPress plugin,
 * integrations); a **publishable** key is for browsers (JS widget) and works only from its allowed
 * origins. Key format `inl_<env>_<prefix>_<secret>`; the whole key is shown once, at creation or rotation.
 */
export const ApiKeyKind = z.enum(['SECRET', 'PUBLISHABLE']);
export type ApiKeyKind = z.infer<typeof ApiKeyKind>;

/** What a key may call on the website API (PLAN §9.1). `listings:read` covers changes and sitemap. */
export const API_KEY_SCOPES = [
  'listings:read',
  'developments:read',
  'taxonomy:read',
  'leads:write',
  'viewing-requests:write',
  'search:ai',
] as const;
export const ApiKeyScope = z.enum(API_KEY_SCOPES);
export type ApiKeyScope = z.infer<typeof ApiKeyScope>;

/**
 * Publishable keys sit in web pages, so they only read (S1-05 review). Website forms that write
 * (leads, viewing requests) through a publishable key would need Turnstile first (S7).
 */
export const PUBLISHABLE_KEY_SCOPES: readonly ApiKeyScope[] = [
  'listings:read',
  'developments:read',
  'taxonomy:read',
  'search:ai',
];

/** Request rate per key (limits per tier in identity `API_KEYS.RATE_TIERS`). */
export const ApiKeyRateTier = z.enum(['STANDARD', 'HIGH']);
export type ApiKeyRateTier = z.infer<typeof ApiKeyRateTier>;

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
/**
 * A browser origin, as the `Origin` header sends it: `https://host[:port]` (lower case, no path), or
 * `http://localhost[:port]` for local development. Compared exactly — `https://example.com` and
 * `https://www.example.com` are two entries.
 */
const ORIGIN_RE = new RegExp(`^(?:https://${LABEL}(?:\\.${LABEL})+|http://localhost)(?::\\d{1,5})?$`);
export const ApiOrigin = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(ORIGIN_RE)
  // Browsers never send a default port, so `https://x:443` could never match: refuse it.
  .refine((o) => !/^https:\/\/.*:443$/.test(o) && !/^http:\/\/.*:80$/.test(o), { message: 'default port' });
export type ApiOrigin = z.infer<typeof ApiOrigin>;

export const MAX_API_KEY_ORIGINS = 20;

/**
 * `POST /v1/api-keys` (agency admins of a verified agency). A publishable key needs at least one
 * allowed origin and only read scopes; a secret key has no origins (servers send no `Origin`). The rate
 * tier is not chosen here: agency keys are `STANDARD`; `HIGH` is set by staff (plans may sell it, S13).
 */
export const CreateApiKeyBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    kind: ApiKeyKind,
    scopes: z
      .array(ApiKeyScope)
      .min(1)
      .max(API_KEY_SCOPES.length)
      .refine((s) => new Set(s).size === s.length, { message: 'duplicate scope' }),
    allowedOrigins: z
      .array(ApiOrigin)
      .max(MAX_API_KEY_ORIGINS)
      .refine((o) => new Set(o).size === o.length, { message: 'duplicate origin' })
      .default([]),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.kind === 'PUBLISHABLE' && v.allowedOrigins.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['allowedOrigins'], message: 'a publishable key needs an allowed origin' });
    }
    if (v.kind === 'PUBLISHABLE' && v.scopes.some((s) => !PUBLISHABLE_KEY_SCOPES.includes(s))) {
      ctx.addIssue({ code: 'custom', path: ['scopes'], message: 'publishable keys only read' });
    }
    if (v.kind === 'SECRET' && v.allowedOrigins.length > 0) {
      ctx.addIssue({ code: 'custom', path: ['allowedOrigins'], message: 'secret keys are not used from browsers' });
    }
  });
export type CreateApiKeyInput = z.infer<typeof CreateApiKeyBody>;

/** A key as the dashboard lists it: never the secret or its hash. */
export const ApiKeyDto = z.object({
  id: z.uuid(),
  name: z.string(),
  kind: ApiKeyKind,
  /** Identifies the key (`pk…`/`sk…`); not secret. */
  prefix: z.string(),
  scopes: z.array(ApiKeyScope),
  allowedOrigins: z.array(z.string()),
  rateTier: ApiKeyRateTier,
  status: z.enum(['ACTIVE', 'REVOKED']),
  /** Updated in batches: up to about two minutes behind. */
  lastUsedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  rotatedAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
});
export type ApiKeyDto = z.infer<typeof ApiKeyDto>;
export const ApiKeyPage = pageOf(ApiKeyDto);
export type ApiKeyPage = z.infer<typeof ApiKeyPage>;

/** Create and rotate: the key, plus the whole secret key string — shown this once, never stored. */
export const IssuedApiKeyDto = z.object({ key: ApiKeyDto, secret: z.string() });
export type IssuedApiKeyDto = z.infer<typeof IssuedApiKeyDto>;

export const ApiKeyParams = z.object({ keyId: z.uuid() });
export type ApiKeyParams = z.infer<typeof ApiKeyParams>;
