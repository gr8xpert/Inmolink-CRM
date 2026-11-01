# Security hardening R1 (S16-03, PLAN §12)

Status: **internal pass done — no Critical or High finding open**; Medium M-3 is fixed (S16-F8), M-4 (S16-F9) is open
with a follow-up. The external penetration test (**H8**) is a human action: §7 is the testers' scope and checklist; its
findings come back into §6 and are fixed before R1 go-live.

Date: 2026-11-01. Covered: every app (`api`, `feed-api`, `realtime`, `worker` health, `web`, `public`), `packages/*`,
the lockfile and the whole git history. Method: the scans below, plus a static review by area (three parallel
`security-auditor` passes: identity/RLS/API keys/realtime; imports/XML/uploads/SSRF/webhooks/injection; Client Mode
and white-label leaks/logs/crypto/authorization).

## 1. Dependency audit (`pnpm audit`, lockfile)

Before: 1 High, 10 Moderate, 5 Low, 0 Critical. After: **0 High / 0 Critical**, 7 Moderate, 4 Low.

| Advisory | Package (path) | Severity | Decision |
|---|---|---|---|
| GHSA-mrhx-c7xc-m3w5 — memory exhaustion on oversized constrained collections | zod 4.6.5 (every app, contracts) | **High** | **Fixed**: override `"zod@<4.6.7": 4.6.7` (2026-10-12) in `pnpm-workspace.yaml`. Request bodies were also capped at 1 MiB, but the parse runs on every route. |
| GHSA-8c8m-p3m8-cjg8, GHSA-m943-m63m-w62w, GHSA-85x2-q946-cp5h — addressparser recipient confusion | nodemailer 10.1.0 (platform email) | Moderate | **Fixed**: override `"nodemailer@>=3.0.0 <10.1.7": 10.1.7` (2026-10-18). Recipients are Zod-validated emails, so not reachable today. |
| GHSA-389g-gv7q-r4x8 — header validation bypass (case-sensitive `propertyNames`) | fastify 5.12.5 | Low | **Fixed**: override `"fastify@>=5.12.2 <5.12.7": 5.12.7` (2026-10-13). |
| GHSA-w74x-v6f9-j3xg, GHSA-wjr9-j795-jxcr (Moderate); GHSA-xhq7-xmqj-769h, GHSA-333x-w4r6-6crp (Low) | fast-uri 4.2.1 / 3.1.8 (fastify → ajv-compiler, ajv) | Moderate / Low | **Follow-up S16-F7**: the patched 4.2.3 / 3.1.9 (2026-10-19) are 13 days old (the repo pins releases ≥ 14 days old); pin them on or after 2026-11-02. Only `format: uri` checks in Fastify's own schemas use it; our routes validate with Zod. |
| GHSA-67mh-4wv8-2f99 — dev server answers any website | esbuild 0.18.20 (db → drizzle-kit → @esbuild-kit) | Moderate | **Accepted**: dev-only CLI dependency; drizzle-kit never starts esbuild's dev server. Goes with the next drizzle-kit major. |
| GHSA-g3hv-75wg-m249 (minimatch), GHSA-3g3m-2fjr-6pw4 (glob) | @fastify/swagger-ui → @fastify/static | Moderate | **Accepted**: Swagger UI is registered only with `docsUi` (development); production processes never load it. |

The overrides are scoped to the vulnerable ranges (peers such as next-auth / @auth/core keep resolving their own
range; they get the patched nodemailer too) and lift the `package.json` pins (4.6.5 / 10.1.0 / 5.12.5) without editing
them: bumping the pins is part of S16-F7. **CI** now fails on any High or Critical advisory (`security` job, `pnpm audit --audit-level=high`).

## 2. Secrets scan (gitleaks 8.28.0, `zricethezav/gitleaks@sha256:cdbb7c95…`)

- **Whole history** (453 commits, all branches reachable from `main`): 55 raw hits in 47 file/rule groups, all
  triaged without printing values (`--redact`): test fixtures (throwaway HMAC / cursor / tag keys, fake Stripe ids,
  invite tokens in `*.test.ts`, `__tests__/`, `tests/`) and the committed **example** Ed25519 keys in
  `.env.example` / `.env.test.example`. The example keys are public by design: production config refuses every
  committed example value whatever key id it is filed under (`EXAMPLE_JWT_PUBLIC_KEYS`, `HMAC_KEY`, `ENCRYPTION_KEYS`,
  `MEDIA_URL_KEY`, `AUTH_SECRET` checks in `platform/config`). **No real secret was ever committed; nothing to rotate.**
- **Working tree**: only gitignored local files — `.env` (the dev example key) and `tests/load/.data/` (load-test keys and tokens of the local test stack); never committed. The config skips `tests/load/.data/`.
- With `.gitleaks.toml` (default rules + an allowlist of the **known fixture values and example keys** — by value or
  by the fixture's own line, never by path, so a real secret in a test file is still found): history and tree
  **clean**.
- **CI**: the `security` job scans the commits each push or pull request adds (`--log-opts=<before>..<sha>`), as the
  runner user so git trusts the checkout.

## 3. Response headers (CSP, framing, sniffing, transport)

| App / response type | Headers now | Test |
|---|---|---|
| api, feed-api, realtime, worker health (Fastify, every answer: routes, 4xx/5xx errors, 404, 429, 503 while closing, health, XML / iCal / zip, redirects) | `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Strict-Transport-Security: max-age=63072000; includeSubDomains`, `Cross-Origin-Opener-Policy: same-origin` (set first in `onRequest`, `platform/server/security-headers.ts`). Dev-only `/docs` keeps its scripts (no CSP). | `packages/platform/src/server/server.test.ts`, `apps/api/src/rate-limit-coverage.test.ts`, `apps/feed-api/src/rate-limit-coverage.test.ts` |
| web pages (dashboard) | **Nonce CSP per request** from the proxy: `script-src 'self' 'nonce-…' 'strict-dynamic'` (no inline, no eval outside dev), `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`, `upgrade-insecure-requests`; the request carries it so Next nonces its own scripts; the root layout awaits `connection()` so no page is statically cached with a stale nonce. `img-src` / `media-src` (+ `blob:` / `data:` previews) / `connect-src` list only the configured hosts (`apps/web/src/server/csp.ts`): media CDN (`MEDIA_CDN_URL`), object storage (`S3_ENDPOINT`: signed GETs, presigned PUTs), realtime (`REALTIME_PUBLIC_URL` + its ws/wss form), the map style host (`MAP_STYLE_URL`) and `MAP_TILE_ORIGINS`, Turnstile — no `https:` / `wss:` wildcards; the dashboard API is server-side only, so not listed. Dev adds `'unsafe-eval'` and the HMR socket. **Accepted:** `style-src 'self' 'unsafe-inline'` (React `style` props, MapLibre's runtime styles; a style injection cannot run script under this policy). Every dotted path but static asset extensions runs the proxy, so a `/x.php`-style 404 gets the page CSP too. | `apps/web/src/proxy.test.ts` |
| web everything (pages, route handlers, `_next` assets, errors) | `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` (email-link pages keep `no-referrer`), HSTS, COOP, `Permissions-Policy` (camera, microphone, geolocation, payment, usb off). Route handlers (`/api`, `/session`, `/healthz`): CSP allowing nothing. | `apps/web/src/proxy.test.ts` |
| public portal pages, route handlers, assets, sitemaps (ISR / CDN-cached) | `X-Frame-Options: DENY` + `frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'` (all but embeds); `nosniff` + HSTS on every path. | `apps/public/src/embed/csp.test.ts`, `apps/public/src/proxy.test.ts` |
| public embeds | unchanged static CSP (S7-F8: `script-src 'self'` + Turnstile, `frame-ancestors` = the site's domains) + `nosniff` + HSTS. | existing S7-F8 tests |
| public selection pages `/s/<token>` | unchanged (`no-referrer`, `frame-ancestors 'none'`) + `nosniff` + HSTS. | existing S12-04 tests |

Public portal pages enforce a `script-src` without `'unsafe-inline'` since S16-F8 (M-3): a per-request nonce on pages
rendered per request, the SHA-256 of their own inline scripts on stored ISR copies (ADR 0019), a no-inline-script
fallback on any other HTML answer; violations go to `/api/csp-report`.

**Deploy note (S16-F6 / Kamal):** the dashboard CSP reads `MEDIA_CDN_URL`, `S3_ENDPOINT`, `REALTIME_PUBLIC_URL`,
`MAP_STYLE_URL` (and `MAP_TILE_ORIGINS` when the style's tiles live elsewhere) on **web**; `infra/kamal/web*.yml` must
set them (today only `WEB_URL` / `API_URL` are set — `REALTIME_PUBLIC_URL` was already missing there), or images,
uploads and sockets are refused by the browser.

## 4. CORS

| App | Policy | Test |
|---|---|---|
| api | **No CORS at all**: no preflight answer, no `Access-Control-Allow-*`, any origin. Browsers never call it cross-origin (web calls it server-side with a Bearer token; no cookies). | `apps/api/src/rate-limit-coverage.test.ts` |
| feed-api | `OPTIONS /v2/*` preflights for any origin (no key yet), no credentials, allowed headers without `Authorization` / cookies; the request itself is refused unless the publishable key's origin allowlist has the exact origin (`requireApiKey`); keyless or refused answers carry no `Allow-Origin`; public taxonomy is `*` (platform reference data). Nothing outside `/v2` is preflighted. | `apps/feed-api/src/rate-limit-coverage.test.ts`, existing `website-api.int.test.ts` |
| realtime | Engine.io `allowRequest`: exact `WEB_URL` origins only, Origin required; `credentials: false`; token in the handshake payload, never a cookie. | existing `[S0-09]` realtime tests |
| web, public | Same-origin only: no handler, proxy or config sets `Access-Control-Allow-*`. | `tests/workspace/security-coverage.test.ts` |

## 5. Rate-limit coverage

Every route of every app is mapped to its limiter; a new route without one fails a test unless it is listed as exempt
with its reason.

| App | Routes | Limited by | Exempt (reason) | Test |
|---|---|---|---|---|
| api | 326 (+ HEAD) | own `config.rateLimit` rules (per user / tenant / IP, upload slots) or the default `api.ip` 600 / min | `/healthz`, `/readyz` (GET, HEAD): probes, no work / flood-safe | `apps/api/src/rate-limit-coverage.test.ts` |
| feed-api | 26 (+ HEAD) | own rules, the default `feed.ip` 1,200 / min, or — keyed website, v1, taxonomy reads, tagged `apiKeyLimited` by the api-key plugin when `requireApiKey` runs in their `onRequest` and they opt out (`KEYED_ROUTE_LIMITS`) — `requireApiKey`: the key's rate tier, the agency ceiling, the daily quota, failed key checks per IP (each refuses a keyless call with 401) | health probes | `apps/feed-api/src/rate-limit-coverage.test.ts` |
| realtime | 4 (health) + Socket.io | per-user connects across nodes and per-node socket caps (S12-F4 / F11), join / typing limits | health probes | existing realtime tests; handshake per-IP: L-4 |
| worker | 4 (health, private network) | — | health probes | — |
| web route handlers | 11 | login limits (per IP / email / IP+email, Turnstile ceiling), token mint, per-user upload slots and import rules, else the api's rules they relay to | `/healthz`, `/session/expired`, `/session/impersonation-ended` (redirects, no lookup) | `tests/workspace/security-coverage.test.ts` |
| public route handlers | 10 | enquiry (Turnstile + per-IP), embed gate + lead limits, selection limits, CSP reports (per-IP, 8 KB cap; S16-F8) | `/healthz`, `robots.txt`, `sitemap.xml`, `/sitemaps/*`, `/embed-assets/*` (static / stored files, CDN-cached) | `tests/workspace/security-coverage.test.ts` |

Pages: the public proxy's portal page gate, code gate and embed gate (S15-01 / S7-F8); dashboard pages and server
actions are behind the session and the api's own limits.

Per-route list: [`security-R1-routes.md`](security-R1-routes.md).

## 6. Findings

No Critical. No High.

| ID | Severity | Area | Finding | Decision |
|---|---|---|---|---|
| H-1 | High | dependencies | zod GHSA-mrhx-c7xc-m3w5 | **Fixed** (§1); CI gate added. |
| M-1 | Medium | auth abuse | The per-email **daily** login cap (`auth.login.email-day`, 1,000) counted every attempt, even unsolved ones past the Turnstile ceiling: ~1,000 junk logins from two IPs locked any account (an agency admin, staff) out for 24 h. | **Fixed**: it counts every attempt that reaches the password check (below the ceiling, or past a solved challenge) and none refused at the challenge (`apps/web/src/server/login.ts`) — junk logins without a password check cannot use it up, while distributed guessing stays capped at 1,000 password checks per email per day; test `[S16-03] the daily per-email cap counts every password check, never an attempt refused at the challenge` (`login.int.test.ts`). Residual: 1,000 real password checks a day (under the hourly ceiling) still lock the owner out until the window ends — the cap's intended trade-off. |
| M-2 | Medium | headers | The dashboard sent no CSP and no `X-Frame-Options` (clickjacking of a logged-in CRM; no script policy); Fastify answers had no `nosniff` / CSP / HSTS. | **Fixed** (§3). |
| M-3 | Medium | headers | Public portal pages (ISR + CDN, ADR 0019) had no `script-src` policy — nonces need per-request rendering. Listing text is converted to plain text and JSON-LD escaped, so there is no known injection. | **Fixed (S16-F8)**: an enforced `script-src` without `'unsafe-inline'`, `'strict-dynamic'` or `eval` on every portal page (`script-policy.mjs`). Per-request pages (home, search, location, zone, agency, 404): a fresh nonce from the proxy; a CDN copy reuses its nonce (accepted: without `'strict-dynamic'` that nonce vouches only for the copy's own inline scripts). ISR listing / development pages (Next renders them without the nonce): the page cache (`cache-handler.mjs` → `stored-page-policy.mjs`) stores the SHA-256 of the copy's own Next inline scripts (flight bootstrap / data pushes, Turbopack `_R_` bootstrap — nothing else) as a second CSP header in the entry, so every answer from it, the first render included, matches; at most 64 hashes (~3.4 KB of header; e2e pages have 3–7), past that the rest are refused and logged (`script hash cap reached`) — CDN / reverse proxy response-header buffers (nginx `proxy_buffer_size`, default 4–8 KB for all headers) must allow ≥ 8 KB. Any HTML answer still without a `script-src` (error page, unstored render, a Next change) gets the no-inline fallback just before its headers go out (`src/server/script-fallback.ts`, installed in `instrumentation.ts`) — never next to a stored policy (two policies intersect). Script files: this origin and the Turnstile host (Cloudflare's documented CSP: `api.js` loads further resources from that host, so it is not narrowed to the one URL). Reports: `report-uri /api/csp-report` (per-IP limit, 8 KB cap, logs directive / blocked origin / page path only). Selection pages: their own `script-src 'self'` + Turnstile on every answer (refusals and failures included), no longer replaced by the next.config frame-deny CSP. Accepted residual: an HTML injection shaped exactly like a flight push (`self.__next_f.push([1,"…"])`) would be hashed on an ISR copy; it can feed RSC rows but cannot load script from another origin. E2E fails on any `securitypolicyviolation`. |
| M-4 | Medium | white-label | `/v1` (frozen legacy shim): a network listing's `id` is the **owner's** legacy id (`legacy-v1.ts:83`), and `GET /v1/properties/{owner legacy id}` resolves on another agency's site (`:202`): someone holding A's legacy ids can tell that B shows A's listing. v2 hides this. | **Follow-up S16-F9 (needs a STATUS decision)**: legacy-site parity vs white-label. The fix (legacy ids only for the site's own listings) changes golden output and the `v1DetailNetwork` perf case — golden updates need approval (`.claude/rules/api.md`). |
| L-1 | Low | 2FA | The 2-minute 2FA proof is bound to user + session version, not to the browser session id, and is reusable within its life. | **Fixed (S16-F10)**: the proof signs the web session id and a nonce (`identity/two-factor.ts` `consumeMfaProof`); the nonce is taken once on the limits Redis (`inl:rl:mfa-proof:*`), fail closed. Asserted in `two-factor.int.test.ts` (core, web). |
| L-2 | Low | uploads | Support attachment and verification document links did not force the response type (served whatever the object metadata says; today always the sniffed type). | **Fixed**: `responseContentType` set (`support/service.ts`, `agencies/verification.ts`); asserted in their int tests. |
| L-3 | Low | SSRF | safeFetch follows an `https → http` redirect on reads (credentials are already dropped across origins). | **Accepted**: legacy feeds do this in the wild; content is parsed as untrusted anyway. Revisit with an opt-in flag if a portal needs it (S16-F10 note). |
| L-4 | Low | realtime | Engine.io handshakes have no per-IP limit before the token check (Ed25519 verify, cheap). | **Accepted** for R1: edge WAF rate rule on `/socket.io` (H8 checklist item); per-user limits apply after auth. |
| L-5 | Low | API keys | A revoked key keeps working up to 15 s per feed-api process (local cache) — revoke publishes the invalidation (`identity/subscriptions.ts`). | **Accepted** (documented TTL). |

Checked OK (no finding): session cookies (HttpOnly, SameSite=Strict, `__Secure-`), Ed25519 access tokens (alg / iss / aud
pinned, 15 min), 2FA enforcement at token mint for staff and admins, reset / verify / invite tokens (32 bytes, HMAC'd,
atomic single use), impersonation (reason, audited, no realtime / Client Mode), `withSystem` refused under
`APP_ROLE=http` in every request app, API keys (HMAC, constant time, scopes, origin allowlist, quotas), realtime room
authorization under RLS, XML (saxes only, DOCTYPE refused), zip / xlsx bombs, uploads (magic bytes, no SVG / HTML,
sharp re-encode, signed PUTs with type + length + sha256), SSRF (safeFetch everywhere user URLs go; DNS pinning,
redirect re-checks), Stripe webhook (raw body, constant-time signature, replay window), SQL (`sql.raw` only on
constants / allowlists), HTML (`dangerouslySetInnerHTML` only for constant CSS and escaped JSON-LD), open redirects,
crypto (AES-256-GCM, random IV, key ids, AAD binding), logs (pino redaction, no query strings / token segments),
Client Mode allowlists and read models without commission / owner fields.

## 7. External penetration test — scope and checklist (H8, BLOCKED-HUMAN)

**Booking (human):** a CREST / OSCP-qualified vendor, 2–4 weeks lead time, grey-box, on **staging** with the scale
seed (H4), before R1 go-live and yearly after (PLAN §12). Findings are filed against this document (§6 table) and
re-tested.

### Scope

| Target | Host (staging) | Notes for the testers |
|---|---|---|
| Dashboard (web) | `app.<staging>` | Accounts: agency admin, agent, Client Mode user, developer admin, staff (support, ops) — all with 2FA where required. |
| Dashboard API | `api.<staging>` | Bearer tokens from the web session (`/session/token`); OpenAPI from `pnpm sdk:generate`. |
| Website API + feeds | `feed.<staging>` | Secret and publishable keys for two agencies (A owns listings shown on B's site through the network); feed / calendar tokens. `/v1` legacy shim included. |
| Public portal, embeds, selections | `www.<staging>`, `/embed/<site>/…`, `/s/<token>` | Two embed sites with different `frame-ancestors`; one selection link per agency. |
| Realtime | `rt.<staging>` | `/notifications`, `/chat` namespaces. |
| WordPress plugin | a staging WP site | Plugin from `ops:wp-plugin-release`. |
| Edge | Cloudflare in front of all of the above | WAF / bot rules as deployed. |

Out of scope: production; volumetric DoS; Stripe, Meta, portal and AI providers' own systems (their sandboxes are
in); physical / social engineering.

### Checklist

- [ ] **Tenant isolation**: agency B reading / changing A's listings, contacts, leads, documents, media, chat threads,
  API keys, exports, by id (IDOR) in the api, website API, realtime joins and signed media / document URLs.
- [ ] **White-label**: from B's website API, embeds, selections, PDFs, emails and AI answers, learn that A owns a listing
  (owner agency, contacts, commission, internal notes, owner references — incl. `/v1` ids, M-4).
- [ ] **Client Mode**: a Client Mode session reaching commission, owner contacts or internal notes; leaving Client Mode
  without the PIN.
- [ ] **Authentication**: credential stuffing vs the per-IP / per-email limits and the Turnstile step; account lockout
  of a victim (M-1 regression); password reset / invite / email verification token reuse, expiry, enumeration;
  2FA bypass and proof replay (L-1); session fixation; logout and revocation reaching api and realtime.
- [ ] **Staff**: impersonation without a reason or 2FA; staff routes from agency accounts; audit trail completeness.
- [ ] **API keys**: scope escalation; publishable key from a non-allowlisted origin; key in the query string beyond
  legacy keys; quota / tier bypass (IP rotation, IPv6 /64).
- [ ] **Injection**: SQL, NoSQL (search filters / facets), header injection, CSV / XLSX formula injection in exports,
  template injection in emails and PDFs, stored XSS in listing text, agency profile, page content, chat.
- [ ] **CSP / framing**: script execution on dashboard pages despite the nonce CSP; clickjacking of dashboard, portal and
  selections; embeds framed by a non-listed domain.
- [ ] **Uploads**: polyglots, SVG / HTML disguised as images or PDFs, oversized / decompression bombs (HEIC, xlsx, zip),
  path traversal in file names, content type of signed downloads (L-2).
- [ ] **SSRF**: feed URLs, image URLs, portal push and Meta / social URLs to internal ranges, metadata, DNS rebinding,
  redirects (incl. https → http, L-3).
- [ ] **XML**: XXE, billion laughs, oversized feeds.
- [ ] **Webhooks**: Stripe signature bypass, replay, out-of-order events.
- [ ] **Rate limits / scraping**: per-route limits (`security-R1-routes.md`), pagination anomaly detection, honeytoken
  listings, Socket.io handshake flood (L-4) — low volume only.
- [ ] **Transport / headers**: TLS config at the edge, HSTS, cookie flags, CORS on every host (§4).
- [ ] **WordPress plugin**: settings page CSRF / capability checks, stored key handling, update channel integrity.

### What comes back

A report with each finding's severity (CVSS 3.1), reproduction steps and affected host; a re-test after fixes. Critical
and High block R1 go-live.
