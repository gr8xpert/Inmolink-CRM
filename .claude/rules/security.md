---
paths:
  - "packages/core/src/modules/identity/**"
  - "packages/core/src/modules/agencies/**"
  - "packages/core/src/modules/billing/**"
  - "packages/core/src/modules/imports/**"
  - "packages/core/src/modules/media/**"
  - "packages/platform/src/crypto/**"
  - "packages/platform/src/safe-fetch/**"
  - "packages/db/src/tenancy/**"
  - "apps/api/src/plugins/**"
  - "apps/feed-api/src/plugins/**"
---

# Security rules (sensitive areas)

## Identity
- Passwords: Argon2id via `platform/crypto/password.ts` (params in ADR 0003). Never log or return hashes.
- Sessions: Auth.js in web; API uses 15-minute JWTs (`aud` per app). Refresh through the web session only.
- 2FA (TOTP) required for staff and agency admins; recovery codes hashed; rate-limit verification attempts.
- Impersonation: staff only, mandatory reason, visible banner, every action audited with both actor and impersonated user; no access to billing secrets or 2FA settings while impersonating.
- API keys: format `inl_<env>_<prefix>_<secret>`; store prefix + Argon2id/HMAC hash; show the secret once; scopes and origin allowlist enforced on every request.

## Tenancy
- RLS policies are generated from `packages/db/src/tenancy/registry.ts`. Policy kinds: `STRICT` (own rows only), `NETWORK_READ` (own rows + rows other verified tenants may see, read-only), `PUBLIC_READ` (read model / public data).
- Runtime role `app_user` has no BYPASSRLS. `app_system` (BYPASSRLS) is used only by `withSystem(reason)` in workers and scripts.
- Every new query path in a sensitive module needs an isolation test.

## Untrusted input
- Outbound HTTP to user-supplied URLs (feeds, images, social media, webhooks) only via `safeFetch`: resolves DNS and blocks private, loopback, link-local and metadata ranges (also after redirects), max 5 redirects, timeouts, size caps, content-type checks.
- XML: streaming parser with DTD/entity expansion disabled (no XXE, no billion laughs).
- Uploads: allowlist by magic bytes, size caps per kind, images re-encoded by sharp (strips payloads and EXIF), documents virus-scanned if a scanner is configured.
- CSV/Excel exports: escape cells starting with `= + - @` (formula injection).

## Secrets & crypto
- AES-256-GCM with key IDs (`platform/crypto`) for stored credentials (feeds, portals, Meta tokens, SMTP, TOTP) and client PII in registrations. Rotation supported by key ID.
- HMAC-SHA256 with a dedicated key for client fingerprints and idempotency keys.
- Secrets only from env/secret store; never in code, fixtures or logs.

## Payments & webhooks
- Stripe and Meta webhooks: verify signatures with the raw body before parsing; idempotent by event ID; handle out-of-order events by re-fetching current state.
