---
paths:
  - "apps/api/**"
  - "apps/feed-api/**"
  - "apps/realtime/**"
  - "packages/contracts/**"
---

# API rules (Fastify)

## Shape of a route
- One folder per module: `apps/<app>/src/routes/<module>/<resource>.ts`. Register via the module's `routes.ts` plugin.
- Use the Zod type provider. Request schemas (`params`, `querystring`, `body`, `headers`) **and** `response` schemas come from `packages/contracts`.
- Handler body = build `ctx` → call one service function → return the DTO. No SQL, no business rules, no external calls in handlers.
- Every route has an OpenAPI `tags`, `summary` and `operationId` (`<module>.<verb><Resource>`).

## Auth & limits
- Dashboard API: `requireSession` plugin (JWT from Auth.js session); `requireRole`/`requirePlan`/`requireVerified` decorators where the task says so. Authorization itself is in the service policy.
- feed-api: `requireApiKey` (secret or publishable + origin allowlist). Never accept session cookies on feed-api.
- Rate limits on every route group (per IP, per user, per API key, per tenant) via `platform/rate-limit`. Public write endpoints (leads, viewing requests) also require Turnstile.

## Conventions
- JSON only, camelCase fields, ISO-8601 UTC timestamps, money as `{ amountCents, currency }`.
- Lists: `?cursor=&limit=` (default 25, max 100) → `{ items, nextCursor }`. Never return totals on large lists unless the task requires it (use estimated counts).
- Errors: throw `AppError(code)` from services; the error plugin maps codes to HTTP status and `{ error: { code, message, details? } }`. Codes live in `packages/contracts/src/errors.ts`.
- POST that creates resources accepts `Idempotency-Key`; store and replay the response for 24 h.
- Optimistic concurrency on editable aggregates: client sends `version`; mismatch → `409 VERSION_CONFLICT`.
- Webhooks in (Stripe, Meta): verify signature first, store event ID for idempotency, enqueue a job, return 200 fast.

## feed-api specifics (public website traffic)
- Read only from `listing_read_models`, `site_listing_contents` and the search adapter. ≤ 3 queries per request.
- Always set `Cache-Control: public, s-maxage=<ttl>, stale-while-revalidate=<ttl>, stale-if-error=86400` and a strong `ETag`; honour `If-None-Match` with 304.
- Cache keys must include site scope and locale; never cache responses containing per-visitor data.
- Apply white-label serialization (presenting agency, reference prefix, overrides) in the website serializer only.
- `/v1/*` legacy routes are frozen: they must match golden files byte-for-byte (after normalization). Change them only with a golden-file update approved in STATUS.

## Realtime
- Socket.io namespaces per feature (`/chat`, `/notifications`); auth via the same short-lived JWT; rooms per thread/user; Redis adapter. Never send PII to rooms the user is not a member of.
