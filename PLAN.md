# Inmolink v2 — Master Plan

> **Version** 2.1 · 2026-10-10 · supersedes v2.0 and Plan v1 · **Status:** locked for build
>
> AI-native **MLS + CRM + website engine** for estate agencies and developers in Spain.
> Built to replace Resales Online at one-third of the price, beat Inmoconnect on collaboration,
> and scale to **5,000 agencies without a redesign**.
>
> **Built by Claude (Opus 5.5) in Claude Code.** This file is the *what and why*. The *how* lives in
> `CLAUDE.md` (operating rules), `docs/build/BACKLOG-R1.md` + `BACKLOG-R2-R4.md` (every task with
> acceptance checks), `docs/build/PATTERNS.md` (reference code) and `docs/build/STATUS.md` (progress).
> See §23. v2.1 changes: Appendix A2.

---

## 0. EXECUTIVE SUMMARY

**What we are building.** One platform where Spanish estate agencies manage their listings and clients, share inventory with each other under clear commission terms, access a managed new-build database, power their own websites and portal feeds — with AI doing the heavy lifting throughout.

**Starting position — not greenfield.**
- Legacy Inmolink: 150+ agents, 20k+ properties, REST API + WordPress plugins (9 languages) powering client websites, XML portal exports, Agent Messaging System (AMS), new-developments module, inmolink.es portal.
- 200 existing clients to migrate (legacy Inmolink users and agencies currently paying Resales Online ~€2,400/yr).
- Proven building blocks: SPW-AI (AI property search), multi-tenant chatbot, programmatic SEO content.
- **Odoo is retired.** Legacy data is extracted once (read-only scripts), then the legacy stack is switched off after cutover. Nothing in v2 depends on Odoo.

**Targets**

| Horizon | Agencies | ARR at €800 (core plan only; illustrative — prices are configurable, §11) |
|---|---|---|
| R1 launch | 200 migrated | €160k |
| Year 5 | 1,000 | €800k |
| Design ceiling | 5,000 (load-tested at 2× expected traffic) | €4.0M |

**Why we win — ten moats**
1. **Network inventory on every agency website**, white-labelled — the thing agencies pay Resales Online €2,400/yr for — at €800.
2. **Zero-pain migration** — the legacy API shim keeps every existing client website running on day one; we move agencies, they don't move themselves.
3. **Managed new-build data, AI-extracted** from developer price lists — fresher than Resales Online's manual team, at a fraction of the cost.
4. **Collaboration with terms agreed before the viewing** — client registration, commission snapshot, deal room. Beats Inmoconnect at its own game.
5. **AI throughout** — listing studio, buyer matching, 24/7 chat/WhatsApp agent, CRM copilot, duplicate detection, market insights. Neither competitor has shipped AI.
6. **Every agency website ranks** — unique AI-written content per site for shared listings, so 200 sites showing the same villa are not duplicate content. Nobody else solves this.
7. **Speed-to-lead** — every enquiry acknowledged in the buyer's language within 60 seconds, response time tracked per agency.
8. **Buyers get a client portal, not PDFs** — one private, branded page with selections, likes, viewings and documents.
9. **Data quality as a product** — dedupe, freshness checks, quality score: "the MLS you can trust".
10. **Built not to fall over** — HA database, CDN-cached feeds, graceful degradation: agency websites never go dark.

**Releases:** R0 Foundation → **R1 Switch-ready** (pilot + migrate the 200) → **R2 Network** → **R3 Outclass** → **R4 Ecosystem**. See §16.

---

## 1. COMPETITIVE MATRIX — PARITY + OUTCLASS

| Capability | Resales Online | Inmoconnect | Legacy Inmolink | **Inmolink v2** |
|---|---|---|---|---|
| Resale MLS sharing | ✅ | ✅ | ✅ | **R1** |
| Commission terms visible per listing | ✅ | ✅ | — | **R1** |
| Client registration / terms before viewing | — | ✅ signed split + lock | — | **R1** registration · **R2** e-signed agreement |
| Deal room (offer → reservation → arras → completion) | — | ✅ | — | **R2** |
| Network message board | ✅ AMS | — | ✅ AMS | **R1** |
| Managed new-build database | ✅ manual team | developer self-upload | ✅ | **R2** AI-assisted data ops |
| Developer self-serve portal | ✅ free module | ✅ | — | **R2** |
| CRM (contacts, leads, pipeline, tasks, calendar) | ✅ | ✅ | partial | **R1** |
| Client profiles + auto-matching | ✅ | — | — | **R2** AI hybrid matching |
| Website feed (API / XML / iFrame) | ✅ | Kyero/CSV + WP | ✅ REST + WP | **R1** API v2 + legacy shim + WP v2 + XML + iFrame |
| Agency edits descriptions of network / new-build listings | ✅ | — | — | **R1** listing overrides |
| Unique per-site content (SEO) | — | — | — | **R2** AI, lazy + capped |
| Hosted website templates | ✅ | portfolio page only | — | **R3** |
| Portal syndication | ✅ ~7 portals | own portal only | ✅ XML | **R1** · rental portals **R2** |
| Own public portal | PropExtra | Realinmo | inmolink.es | **R1** MVP · **R2** full SEO relaunch |
| Branded WhatsApp/PDF lists with live prices | ✅ | partial | — | **R1** |
| Client Mode (hide commission/owner on screen) | ✅ | — | — | **R1** |
| Preferred agents list | ✅ | private network (developers) | — | **R1** |
| Bookmarked properties | — | ✅ | — | **R1** |
| Social media posting | — | — | ✅ | **R1** FB/IG · **R3** AI video reels |
| CSV/Excel export (contacts, listings, leads) | — | ✅ | — | **R1** |
| Client portal for buyers | — | — | — | **R2** |
| Speed-to-lead auto-response | — | — | — | **R1** baseline · **R3** AI agent |
| Agency referral programme | — | ✅ (affiliates) | — | **R2** |
| Guided onboarding / training | ✅ | — | — | **R1** |
| Window cards | ✅ 30+ | — | — | **R2** |
| Forms library | ✅ | — | — | **R2** |
| Reports | ✅ | basic | — | **R2** |
| Languages | multi | ES / EN | 9 | **R1** 9 (AI-assisted) |
| AI property search | — | — | — | **R1** (SPW-AI) · **R3** everywhere |
| AI listing studio (write + translate) | — | — | — | **R1** |
| AI buyer matching | — | coming soon | — | **R2** |
| AI new-build extraction | — | — | — | **R2** |
| Duplicate detection | — | — | — | **R2** |
| AI chat / WhatsApp agent | — | — | — | **R3** |
| CRM copilot | — | coming soon | — | **R3** |
| Mobile | — | coming soon | — | **R2** PWA · **R4** native |
| Email campaigns | — | coming soon | — | **R3** |
| Affiliate program | — | ✅ | — | **R4** |
| Price (agency, per year) | ~€2,300–2,400 | €0–€1,428 | — | **€800** |

---

## 2. PRODUCT PRINCIPLES (NON-NEGOTIABLE)

1. **Agency websites never go dark.** Edge cache + stale-if-error + plugin-side cache. An outage on our side must be invisible to buyers.
2. **White-label to clients, transparent between agents.** Agents see who owns a listing; buyers only ever see the presenting agency.
3. **Terms before work.** Commission and split are visible before contact and accepted before the viewing.
4. **Give to get.** Network access is earned by sharing.
5. **One property, one truth.** Duplicates are clustered; clients see one listing.
6. **AI assists, humans approve.** AI never publishes prices, legal text or commission terms on its own.
7. **Tenant isolation is absolute.** No agency can read another's private data, and no agency's load can hurt another's service.
8. **Migration is a product feature.** Moving in must be a one-day, done-for-you job.

---

## 3. DECISIONS MATRIX (v2.1)

Δ = changed or new versus Plan v1. **2.1** = added or changed in v2.1.

| # | Topic | Decision | |
|---|---|---|---|
| 1 | Tenant | Agency is the tenant (`Agency.kind`: AGENCY / DEVELOPER / PARTNER). Every user belongs to one tenant; agency-of-one auto-created on signup | |
| 2 | Roles | SUPER_ADMIN, STAFF_SUPPORT, STAFF_DATA_OPS, AGENCY_ADMIN, AGENT, DEVELOPER_ADMIN, DEVELOPER_AGENT, PARTNER (R4). API keys are machine principals | Δ |
| 3 | Verification | Tenants start PENDING. Staff verify CIF/NIF + business proof (+ regional register number where required) before SHARED, PUBLIC or website API go live | Δ |
| 4 | Visibility | PRIVATE (owner) / SHARED (verified agents) / PUBLIC (marketplace + websites + portals) | |
| 5 | Give-to-get | Network search requires ≥ N active SHARED listings (default 5, 30-day grace for new agencies); staff can flag buyer-only agencies as exempt | Δ |
| 6 | Branding | Agent-to-agent surfaces show the listing owner. **Every client-facing output** (websites, selections, PDFs, window cards, client emails, chatbot) is white-labelled to the presenting agency | Δ replaces v1 #5 |
| 7 | Commission | Per listing: shareable commission set by the owner (PCT or FIXED, IVA flag), default from agency settings. New-builds: set by developer per development or unit | Δ |
| 8 | Client registration | Introducer registers a client to a property/development. Unique by (target, client fingerprint); first valid registration wins; validity configurable (default 6 months) | Δ |
| 9 | Terms acceptance | Commission + split snapshot accepted by both sides when a viewing request is accepted. Immutable, PDF + audit trail. E-signature in R2 | Δ |
| 10 | Deal stages | OFFER → RESERVATION → ARRAS → COMPLETION (+ FELL_THROUGH). Handshake at completion; disputes → staff mediation | Δ |
| 11 | Settlement | Commission tracked only, settled outside the platform. No Stripe Connect, no escrow | |
| 12 | Lead routing | By source: marketplace → listing owner; agency website / selection / portfolio → **presenting agency**; developer portal → developer + presenting agency. Owner sees introducer, not client PII, until registration | Δ |
| 13 | Duplicates | Cross-agency duplicate clusters with a canonical listing; client-facing outputs show one listing per cluster | Δ |
| 14 | Locales | Config-driven. Launch with legacy's 9 languages (minimum EN, ES, NL, DE, FR, SV). Per-locale slugs, hreflang, sitemaps | Δ (v1: 4) |
| 15 | Translation | AI draft for every enabled locale on create/update (`AI_DRAFT` → `REVIEWED`); agent can lock a locale | Δ |
| 16 | Search index | **Single** listings index with localized searchable fields chosen at query time; results hydrated from read models. Adapter-isolated; Postgres fallback for basic filters | Δ (v1: index per locale) |
| 17 | Imports | Kyero, generic XML (mapping UI), CSV, Resales Online (**own listings only**), Milenio+, Infocasa, Inmoba, thinkSPAIN. Later: Inmovilla, Witei | Δ |
| 18 | Field locks | Agent-locked fields survive feed updates | |
| 19 | Exports | Per-agency portal feeds: Kyero, thinkSPAIN, A Place in the Sun, generic XML. idealista and Fotocasa after partner approval | Δ |
| 20 | Website delivery | Website API v2 + legacy API shim + WordPress plugin v2 + JS widget (SPW-AI) + per-site XML feed + iFrame embed. Hosted Next.js sites in R3 | Δ **2.1** |
| 21 | New builds | Development → Phase → Unit; versioned price lists; maintained by developer or Inmolink data ops; freshness SLA 24 h | Δ |
| 22 | CRM | Contacts, leads, pipeline, tasks, calendar, activity timeline, seller acquisition | Δ |
| 23 | Matching | Client profiles matched on listing events + nightly; modes OFF / REVIEW / AUTO_SEND | Δ |
| 24 | Network board | AMS: buyer requests, property offers, developer announcements; subscription filters | Δ |
| 25 | Chat | Agent-to-agent 1:1 + deal threads; WhatsApp / email deep-link handoff | |
| 26 | WhatsApp automation | Official WhatsApp Business Platform (Cloud API) only. No unofficial libraries in production (ban risk at scale) | Δ |
| 27 | Email | Transactional: Resend. Bulk campaigns: Amazon SES (or equivalent) with per-agency verified domains. Per-agency SMTP optional | Δ |
| 28 | Billing | Stripe subscriptions; card + **SEPA Direct Debit**; annual default; EUR/GBP; Stripe Tax; staff manual grants; legacy price-lock coupons | Δ |
| 29 | Plans | FREE / PRO / BUSINESS / ENTERPRISE + add-ons. Gate on value (website API, exports, new-builds, AI), never on sharing (§11) | Δ |
| 30 | Auth | Auth.js v5 sessions (dashboard) → short-lived JWT verified by Fastify; hashed, scoped API keys for websites; TOTP 2FA (required for staff and agency admins) | Δ |
| 31 | Passwords | Argon2id | Δ fixes v1 conflict |
| 32 | Tenant isolation | Postgres RLS on every tenant table + app-level scope helper + automated cross-tenant tests in CI | Δ |
| 33 | Media | Content-addressed (SHA-256) normalized master ≤ 2560 px; **deterministic variant keys, no variant rows**; pHash for duplicate detection; EXIF stripped; HEIC converted | Δ |
| 34 | Soft delete | 30 days → hard delete; deleted public URLs 301 to nearest relevant page | |
| 35 | Database HA | Primary + **hot standby on a separate server in another datacenter** from R1. Patroni automated failover at Stage C | Δ (v1: same-box replica) |
| 36 | Backups | WAL-G continuous archiving → R2 (point-in-time recovery, RPO ≤ 5 min) + nightly base backup + automated weekly restore test | Δ (v1: nightly dump) |
| 37 | Redis | Two instances: `redis-queue` (noeviction, AOF — required by BullMQ) and `redis-cache` (allkeys-lru) | Δ |
| 38 | Workload isolation | Separate deployables: web, public, api, feed-api, realtime, worker pools. Website traffic cannot starve the dashboard, and vice versa | Δ |
| 39 | Fair scheduling | Per-tenant fair-share for imports, AI, exports — one 100 MB feed cannot block 4,999 others | Δ |
| 40 | Deploy | Docker images, Kamal multi-host deploys on EU dedicated servers, Ansible for host config. No Plesk | Δ |
| 41 | Schema changes | Expand → migrate → contract. Never a breaking schema change in a single deploy | Δ |
| 42 | Feature flags | Per-agency flags; every risky feature ships dark → pilot agencies → everyone | Δ |
| 43 | API versioning | `/v1` (legacy shim, frozen) and `/v2`; 12-month deprecation notice | Δ |
| 44 | Observability | OpenTelemetry → Grafana stack (or Better Stack), Sentry, public status page | Δ |
| 45 | Webhooks out | Deferred to R4 (partner API) | Δ |
| 46 | AI icon suggester | Dropped (taxonomy is ~100 items, curated by hand) | Δ |
| 47 | AI platform | `packages/platform/src/ai` gateway: Claude models set by env (`AI_MODEL_FAST` for bulk, `AI_MODEL_SMART` for complex; never hard-coded), multilingual embeddings via provider abstraction, per-tenant budgets, discounted batch API for bulk jobs | Δ **2.1** |
| 48 | Mobile | Installable PWA + web push (R2); native app (Expo) in R4 | Δ |
| 49 | Hygiene | Biome, Vitest, Playwright, MSW, husky + lint-staged, OpenAPI → typed SDK, ADRs, CHANGELOG, CLAUDE.md | |
| 50 | ORM | **Drizzle ORM** + drizzle-kit migrations on node-postgres (`pg`). Bulk loads via `pg-copy-streams` → staging → `MERGE`. Replaces Prisma + Kysely (one SQL-first tool; clean RLS and bulk paths) | **2.1** |
| 51 | Code structure | Modular monolith: business logic in `packages/core/src/modules/<module>`; apps are thin transports (HTTP, jobs, sockets). Modules talk through each other's `index.ts` or outbox events — never another module's tables. Enforced by dependency-cruiser in CI | **2.1** |
| 52 | IDs & money | UUIDv7 primary keys (time-ordered). Money as integer cents + currency; percentages as basis points; timestamps `timestamptz` UTC | **2.1** |
| 53 | RLS policies | Generated from a tenant-table registry in `packages/db` (policy kinds STRICT / NETWORK_READ / PUBLIC_READ). The same registry drives the cross-tenant test suite | **2.1** |
| 54 | Listing overrides | An agency can override title/description per locale for any listing it may present (network, new-build); overrides apply only to that agency's channels | **2.1** |
| 55 | Unique site content | Per-site AI rewrites of shared listings: lazy (on first detail-page or sitemap inclusion), capped per plan, batch API, regenerated on material change; fallback = owner text | **2.1** |
| 56 | Client Mode | Session flag; server-side serializers drop commission, owner agency, internal notes and private fields; exit requires PIN | **2.1** |
| 57 | Preferred agencies | Each agency keeps a preferred list; listings can be shared to ALL verified agencies or PREFERRED only; network search can filter by it | **2.1** |
| 58 | Social posting | Facebook Pages + Instagram Business via Meta Graph API; AI captions per language; scheduling; video reels R3 | **2.1** |
| 59 | Data portability | CSV/Excel export of contacts, leads, listings on every plan; full account ZIP export. "You can always leave" is a sales point | **2.1** |
| 60 | Speed-to-lead | Every website/portal enquiry gets an auto-acknowledgement in the buyer's language within 60 s (R1, templated + similar listings); AI agent reply in R3; response time is a tracked KPI | **2.1** |
| 61 | Client portal | Buyers get magic-link access to a white-labelled portal (selections, likes, notes, viewings, documents). No passwords for buyers | **2.1** |
| 62 | Referrals | Agency-refers-agency codes; rewards as Stripe customer-balance credit; tracked in billing | **2.1** |
| 63 | Portal timing | inmolink.es MVP rebuilt in R1 (search, detail, location pages, leads, 301s) so the legacy stack can be switched off; full SEO relaunch in R2 | **2.1** |
| 64 | Outbound fetch safety | All server-side fetching of user-supplied URLs (feeds, images, webhooks) goes through an SSRF-safe fetcher (blocks private IP ranges, size/time limits). XML parsing is XXE-safe with entity expansion disabled | **2.1** |
| 65 | Build method | Built by Claude (Opus 5.5) in Claude Code from `docs/build/BACKLOG-*.md`, one task at a time, with gates in `CLAUDE.md` (§23) | **2.1** |

---

## 4. SCALE MODEL & SLOs

### 4.1 Load assumptions

Legacy data point: 150 agents → 20k properties (~133 listings per agent). Assumptions per agency: 5 users, 150 own listings, 30 photos per listing, 2,000 contacts, 200 active client profiles, 1 website doing ~3,000 property-API requests/day.

| Metric | 200 agencies | 1,000 | **5,000 (ceiling)** | Design / test target |
|---|---|---|---|---|
| Users | 1k | 5k | 25k | 50k |
| Own listings | 30k | 150k | 750k | — |
| New-build units | 20k | 60k | 150k | — |
| **Total listings** | ~50k | ~210k | ~900k | **2M** |
| Media objects (pre-dedup) | 1.5M | 6.3M | 27M | 60M |
| Media storage after ~35% dedup (~0.75 MB/image incl. variants) | ~0.7 TB | ~3 TB | ~13 TB | 30 TB |
| Contacts | 400k | 2M | 10M | 20M |
| Client profiles | 40k | 200k | 1M | 2M |
| Website API requests/day | 0.6M | 3M | 15M | 30M |
| Website API peak (5× avg) | 35 rps | 175 rps | ~870 rps | **2,000 rps edge / 1,000 rps origin** |
| Dashboard concurrent users (peak) | 100 | 500 | 2,500 | 5,000 |
| Feed import runs/day | 800 | 4,000 | 20,000 | 40,000 |

**Takeaway:** at 5,000 agencies the *property* tables are small for Postgres (~1–2M rows). The real pressure points are (1) website API read traffic, (2) media volume, (3) append-only tables — activity, audit, stats, notifications — which are **partitioned by month from day 1**. Plan v1's 150M-property ceiling is dropped; designing for it added cost and complexity with no benefit.

### 4.2 Service-level objectives

| Surface | Availability | Latency |
|---|---|---|
| Website API (v1 shim + v2) | **99.95%** | p95 < 150 ms edge-cached · < 400 ms origin |
| Agent dashboard | 99.9% | API p95 < 300 ms |
| Public portal | 99.9% | TTFB p95 < 200 ms (edge) |
| Freshness | — | agent edit → websites ≤ 5 min · feed change → ≤ 60 min after run · new-build price lists ≤ 24 h |
| Durability | RPO ≤ 5 min | RTO ≤ 30 min (R1) → ≤ 10 min (R3) |

---

## 5. ARCHITECTURE & INFRASTRUCTURE

### 5.1 Logical architecture

```
 CLIENTS   Agent PWA · Agency websites (WP plugin / JS widget / hosted) · inmolink.es
           Developer portal · Portals pulling XML · Staff console
                                   │
 EDGE      Cloudflare: DNS · WAF · DDoS · CDN cache · Turnstile · R2 media
                                   │
                         Load balancer (Stage B+)
       ┌──────────┬──────────┬─────┴──────┬────────────┬────────────┐
     web        public      api        feed-api     realtime      (stateless,
   Next.js     Next.js    Fastify      Fastify     Socket.io      horizontally
  dashboard    portal +   dashboard   website API  chat + notif.  scalable)
               hosted     API         v1/v2 + XML
               sites (R3)             portal feeds
       └──────────┴──────────┴─────┬──────┴────────────┴────────────┘
                                   │
 DATA      PgBouncer → Postgres 17+ primary ──WAL──► hot standby (other DC)
           (PostGIS · pg_trgm · pgvector · pg_partman)      │
           redis-queue (BullMQ) · redis-cache (LRU)        WAL-G → R2 (PITR)
           Search (Meilisearch → cluster) · R2 (media, exports, backups)
                                   │
 WORKERS   imports · media · indexing · matching · exports · email · ai · migration · maintenance
```

### 5.2 Deployables

| App | Purpose | Scales by |
|---|---|---|
| `apps/web` | Agent/agency/developer dashboard (Next.js latest stable, server components) | app nodes |
| `apps/public` | inmolink.es portal; hosted agency sites (R3) | app nodes + CDN |
| `apps/api` | Dashboard API, Stripe/portal webhooks in, auth | app nodes |
| `apps/feed-api` | Website API v1 shim + v2, XML portal feeds — **read-only, isolated** | dedicated feed nodes + CDN |
| `apps/realtime` | Socket.io (Redis adapter, sticky sessions) | realtime nodes |
| `apps/worker` | BullMQ pools, each pool deployable on its own node | worker nodes per pool |
| `apps/wp-plugin` | WordPress plugin v2 (PHP), own update server | — |

### 5.3 Crash-proofing — why it holds at 5,000 agencies

1. **Stateless app tier** — any node can die; scaling is adding nodes.
2. **Bulkheads** — website API, dashboard, realtime and workers are separate deployables with their own DB pool budgets. A website traffic spike cannot take down the agent dashboard.
3. **Read models on the hot path** — feed-api and portal read precomputed per-locale listing documents by primary key. No heavy joins where traffic is highest.
4. **Edge cache everything public** — CDN with `stale-while-revalidate` and `stale-if-error` (24 h). If the origin dies, websites keep serving.
5. **Async by default** — imports, media, indexing, matching, email and AI never run inside a user request.
6. **Transactional outbox** — every change emits an event in the same DB transaction; consumers are idempotent and replayable. Search, matching, portal feeds and cache refresh can never silently drift.
7. **Backpressure + fair share** — per-tenant concurrency caps; import anomaly guard (> 5× normal volume pauses the run and alerts).
8. **Timeouts + circuit breakers** on every dependency (search, AI, SMTP, portals, Stripe, feed sources).
9. **Degrade, don't fail** — see matrix below.
10. **Connection discipline** — PgBouncer transaction pooling; per-service pool budgets; `statement_timeout` 2 s (feed-api), 5 s (dashboard), longer only in workers.
11. **Quotas everywhere** — per IP, per user, per API key, per tenant; anti-scraping detection on the website API.
12. **Data protection** — HA standby, PITR, automated restore tests.
13. **Safe change** — feature flags, expand/contract migrations, canary to pilot agencies, one-command rollback.
14. **Alert on symptoms** — latency, error rate, queue age, freshness lag — not just CPU.

### 5.4 Degradation matrix

| Failure | What users see | Behaviour |
|---|---|---|
| Search engine down | Slightly simpler website search | Postgres fallback for basic filters; cached pages keep serving |
| feed-api origin down | Nothing (mostly) | CDN serves stale up to 24 h; WP plugin serves its local cache |
| Postgres primary down | Dashboard read-only for minutes | Promote standby (runbook in R1, automatic with Patroni at Stage C); websites unaffected via cache |
| redis-queue down | Background work delayed | AOF persistence; outbox in Postgres replays missed events |
| redis-cache down | Slightly slower | Fall through to Postgres read models |
| AI provider down / slow | AI buttons show "try later" | Jobs queue and retry; core flows never wait on AI |
| Feed source down | Listings slightly stale | Keep last good data; alert agency after 24 h |
| Portal rejects feed | — | Per-property error report; other portals unaffected |
| Email provider issue | Delayed emails | Queue + retry; failover to secondary provider for transactional |
| Stripe outage | — | Billing jobs retry; access never revoked during provider outages |

### 5.5 Physical topology by stage

Costs are approximate for Hetzner-class EU dedicated servers (verify at purchase). Infrastructure stays under 5% of revenue at every stage.

**Stage A — Launch (≤ 300 agencies) · ~€300–500/mo**

| Server | Runs |
|---|---|
| app-1 (16–24 cores, 64–128 GB) | Caddy/Nginx, web, public, api, feed-api, realtime, workers, redis-cache, search |
| db-1 (8–16 cores, 64–128 GB, NVMe RAID1) | Postgres primary, PgBouncer, redis-queue |
| db-2 (different datacenter) | Postgres hot standby, search spare (rebuildable), WAL-G verification |

Plus Cloudflare (CDN, WAF, R2), Sentry, uptime monitoring, status page.

**Stage B — Growth (300–1,500) · ~€800–1,500/mo**
- app-1 + app-2 behind a load balancer (web, public, api, realtime)
- feed-1 dedicated to feed-api (app nodes as fallback)
- worker-1 (imports, media, AI) · worker-2 (indexing, matching, exports, email)
- search-1 dedicated + hot spare
- db-1 primary · db-2 standby · db-3 read replica for feed-api and reporting
- redis-queue and redis-cache on separate hosts
- monitoring node (Grafana, Prometheus, Loki)

**Stage C — Scale (1,500–5,000+) · ~€2,500–5,000/mo**
- app ×3–4 · feed-api ×2–3 · workers ×3–4 by pool · realtime ×2
- Postgres via Patroni: primary + 2 replicas, automatic failover, read routing
- Search: 3-node HA cluster behind the adapter (OpenSearch or Typesense if Meilisearch HA does not fit)
- Redis Sentinel for the queue
- Optional warm DR in a second region

### 5.6 Scale triggers (sustained 7 days)

| Signal | Action |
|---|---|
| App CPU > 60% at peak | Add app node |
| feed-api origin p95 > 300 ms or CDN hit rate < 60% | Tune cache keys/TTLs, then add feed node |
| DB CPU > 60% or p95 query > 50 ms | Index review (`pg_stat_statements`), then route reads to replica |
| DB disk > 60% | Larger NVMe or move to Stage C cluster |
| Queue age p95 > 5 min (imports) / > 30 s (email, notifications) | Add worker node for that pool |
| Search p95 > 100 ms or RAM > 70% | Dedicated node → cluster |
| > 5k websocket connections per node | Add realtime node |

Every triggered change gets its own ADR.

### 5.7 Repo structure

Modular monolith (§3 #51): one codebase, several deployables, business logic in one place.

```
inmolink/
├── apps/                       THIN transports only — no business logic here
│   ├── web/                    Next.js dashboard (agency, agent, developer, staff console)
│   ├── public/                 Next.js inmolink.es portal, selections, client portal, iFrame embeds (+ hosted sites R3)
│   ├── api/                    Fastify dashboard API (+ Stripe/Meta webhooks in)
│   ├── feed-api/               Fastify website API v1 shim + v2, XML feeds — read-only, isolated
│   ├── realtime/               Socket.io (chat, notifications)
│   ├── worker/                 BullMQ processors (one entry per pool)
│   └── wp-plugin/              WordPress plugin v2 (PHP)
├── packages/
│   ├── core/                   ALL business logic: src/modules/<module>/{index,service,repo,policy,events,jobs,errors}.ts
│   │   └── src/modules/        identity · agencies · taxonomy · properties · media · developments · imports ·
│   │                           exports · websites · search · crm · matching · mls · network · chat ·
│   │                           notifications · presentations · documents · client-portal · social · marketing ·
│   │                           reports · billing · referrals · onboarding · support · dedupe · quality ·
│   │                           ai-features · admin · compliance · migration
│   ├── db/                     Drizzle client, schema/<module>.ts, migrations, tenant-table registry → RLS SQL, read-model tables
│   ├── contracts/              Zod DTOs + error codes shared by apps, SDK and OpenAPI
│   ├── platform/               Infra adapters: cache, queue, outbox, search, storage (R2), email, pdf, ai gateway,
│   │                           crypto, flags, rate-limit, safe-fetch, logger, telemetry, config
│   ├── i18n/                   Locales + message catalogs
│   ├── ui/                     shadcn components + design tokens
│   ├── sdk/                    Generated typed client for website API v2 + JS widget (SPW-AI)
│   └── config/                 tsconfig / Biome / Vitest presets
├── tests/                      e2e (Playwright) · load (k6) · isolation · golden (legacy API)
├── infra/                      Kamal, Ansible, Docker, Caddy/Nginx, OTel collector, Grafana dashboards
├── scripts/                    legacy-migration/ · seed/ · ops/ (reindex, replay outbox, restore drill) · gen/ (module scaffolder)
├── docs/                       adr/ · runbooks/ · api/ · build/ (BACKLOG, PATTERNS, STATUS, BUILD-GUIDE, HUMAN-ACTIONS)
├── .claude/                    rules/ · skills/ · agents/ · hooks/ · settings.json
└── README.md · PLAN.md · CLAUDE.md · ARCHITECTURE.md · CHANGELOG.md · TROUBLESHOOTING.md
```

**Dependency direction (enforced):** `apps → core → (db, platform, contracts)`; `platform → (config, contracts)`; `ui → contracts`. A module imports another module only via its `index.ts`. A module's repo only touches `db/schema/<its-module>.ts`.

### 5.8 Stack (locked)

| Layer | Choice |
|---|---|
| Runtime | Node.js 24 LTS (production servers support 22 and 24; `engines` allows both), TypeScript strict (versions pinned at S0 to latest stable, recorded in ADR 0001) |
| Monorepo | pnpm + Turborepo |
| Frontend | Next.js latest stable (App Router, server components), next-intl, shadcn/ui, TanStack Query, MapLibre |
| API | Fastify 5+ + Zod type provider + `@fastify/swagger` (OpenAPI) |
| Database | PostgreSQL 17+ (latest stable supported by PostGIS, pgvector, pg_partman) + PostGIS, pg_trgm, pgvector (halfvec, HNSW), pg_partman |
| Data access | **Drizzle ORM** + drizzle-kit on node-postgres; raw SQL via Drizzle `sql` for reporting/matching; bulk upserts via `pg-copy-streams` → staging → `MERGE` |
| Pooling | PgBouncer (transaction mode) |
| Queue / cache | Redis 7 ×2 + BullMQ |
| Search | Meilisearch behind adapter; OpenSearch/Typesense swap path |
| Realtime | Socket.io + Redis adapter |
| Auth | Auth.js v5, JWT, Argon2id, TOTP |
| Media | Cloudflare R2 + CDN, sharp/libvips, HEIC support |
| PDF | Puppeteer + Handlebars |
| Payments | Stripe Billing + SEPA DD + Stripe Tax |
| Email | Resend (transactional), Amazon SES (bulk) |
| AI | Claude via `packages/platform/src/ai` (model IDs from env); multilingual embeddings via provider abstraction; speech-to-text for voice notes |
| WhatsApp | WhatsApp Business Platform (Cloud API) |
| Observability | OpenTelemetry, Grafana/Prometheus/Loki (or Better Stack), Sentry, status page |
| Deploy | Docker, Kamal, Ansible, GitHub Actions |
| Quality | Biome, Vitest, Playwright, MSW, k6, dependency-cruiser (module boundaries), husky + lint-staged |
| Social | Meta Graph API (Facebook Pages, Instagram Business); ffmpeg for video reels (R3) |

---

## 6. DOMAIN MODEL (≈110 models)

> Drizzle schema lives in `packages/db/src/schema/<module>.ts` (one file per owning module). Every tenant-owned table carries `agency_id` and is registered in the tenant-table registry, which generates its RLS policy and cross-tenant tests (§3 #53). Tables marked **[P]** are range-partitioned by month from day 1. Names below are logical (PascalCase); physical tables are snake_case plural.

**Identity & tenancy**
- `Agency` (kind AGENCY/DEVELOPER/PARTNER, status PENDING/VERIFIED/SUSPENDED, cif, registerNumber, region, planTier, seats) · `AgencyTranslation` · `AgencySettings` (default commission, registration validity days, viewing response days, enabled locales, white-label options, give-to-get exemption) · `AgencyVerification` (documents, reviewer, decision)
- `User` · `UserSettings` (incl. clientModePinHash) · `AgencyInvite` · `ApiKey` (prefix, hash, scopes, allowed origins, rate tier, lastUsedAt) · `FeatureFlag` (key, scope, value)
- `PreferredAgency` (agencyId, preferredAgencyId, note) **2.1** · `OnboardingProgress` (userId, checklist step states, tour states) **2.1**

**Taxonomy**
- `Location` (level COUNTRY/REGION/CITY/AREA, parentId, PostGIS centroid + polygon) · `LocationGroup` · `LocationGroupMember` · `LocationAlias` (feed spelling → canonical; critical for imports)
- `PropertyTypeGroup` · `PropertyType` · `PropertyTypeAlias` · `FeatureGroup` · `Feature` · `FeatureAlias` · uniform `*Translation` tables

**Properties & media**
- `Property` — ownerAgencyId, ownerUserId, source, externalRef, legacyId, status, visibility, transactionType, price, priceOnRequest, **shareCommissionType/Value/includesVat**, specs (built/plot/terrace m², beds, baths, year), energyRating (CEE), cadastralRef (private), lat/lng + locationPrecision (EXACT/APPROX), propertyTypeId, locationId, developmentId?, unitId?, **shareScope ALL/PREFERRED** (2.1), duplicateClusterId, isCanonical, qualityScore, lastConfirmedAt, lockedFields, version
- `PropertyTranslation` (title, description, slug, meta, origin HUMAN/AI_DRAFT/REVIEWED, locked) · `PropertyFeature`
- `MediaObject` (sha256 UNIQUE, phash, bytes, mime, width, height, duration, refCount, pipelineVersion, variantsReady bitmask, aiTags, scheduledDeleteAt). Variant keys are deterministic: `v{pipeline}/{sha}/{size}.webp` — **no variant table** (saves ~4 rows per image ≈ 240M rows at ceiling)
- `PropertyMedia` (kind IMAGE/FLOOR_PLAN/VIDEO/DOCUMENT, mediaObjectId, position, isCover, altText, roomType)
- `PropertyPriceHistory` · `PropertyStatusHistory`
- `ListingOverride` (agencyId, target property/development/unit, locale, title, description, origin HUMAN/AI) **2.1** · `BookmarkFolder` · `Bookmark` (userId, target, folderId, note) **2.1**

**New developments**
- `Development` (developerAgencyId, status OFF_PLAN/UNDER_CONSTRUCTION/KEY_READY/SOLD_OUT, completionDate, location, commission terms, payment terms, managedBy DEVELOPER/DATA_OPS, lastVerifiedAt, access OPEN/PRIVATE_NETWORK) · `DevelopmentTranslation` · `DevelopmentAccess` (allowed agencies)
- `DevelopmentPhase` · `Unit` (ref, type, beds, baths, internal/terrace/plot m², floor, orientation, price, status AVAILABLE/RESERVED/SOLD) · `UnitPriceHistory`
- `PriceList` (version, effectiveFrom, source document, extractedBy AI/HUMAN, reviewedBy, diff summary) · `DevelopmentDocument`

**Imports & exports**
- `FeedConnection` (kind, url, credentialsEnc, mappingProfileId, schedule, enabled, mutex) · `FeedRun` · `FeedItemError` · `FeedMappingProfile` · staging tables for bulk loads
- `PortalChannel` · `AgencyPortalConnection` (credentialsEnc, feed token, selection rules) · `PortalExportRun` · `PropertyPortalStatus`

**Website delivery**
- `WebsiteSite` (agencyId, domains, mode WP_PLUGIN/WIDGET/HOSTED, inventory policy OWN_ONLY/OWN_PLUS_NETWORK/CUSTOM, filters, reference prefix, locales) · `ApiUsageDaily` **[P]**
- `ListingReadModel` (listingId × locale → denormalized JSON card + detail; maintained by outbox)
- `SiteListingContent` (siteId, listingId, locale, title, description, metaTitle, metaDescription, sourceHash, status QUEUED/READY/STALE, generatedAt) **2.1** — unique per-site SEO text

**CRM**
- `Contact` (types BUYER/SELLER/TENANT/LANDLORD, names, emails[], phones[], language, source, tags, consent flags, doNotContact) · `ContactNote`
- `Lead` (contactId, target property/development/unit, sourceChannel, presentingAgencyId, listingOwnerAgencyId, status, assignedUserId, aiScore, aiSummary, **autoAckSentAt, firstHumanResponseAt, responseSeconds** 2.1) · `PipelineStage` (agency-customizable)
- `ClientProfile` (contactId, locations[], typeIds[], price range, min beds/baths, required features, free text, embedding, mode OFF/REVIEW/AUTO_SEND, frequency) · `MatchResult` (score, reasons, status SUGGESTED/SENT/DISMISSED/LIKED)
- `Task` · `CalendarEvent` (type, attendees, ICS token) · `Activity` **[P]** (polymorphic timeline) · `AcquisitionProspect` (seller lead → one-click convert to listing)

**MLS collaboration**
- `ClientRegistration` (target, introducerAgencyId, clientFingerprint = HMAC of normalized email/phone, encrypted client details, status, validUntil)
- `ViewingRequest` (target, owner/introducer, registrationId, preferred dates, scheduledAt, status, outcome, termsSnapshot, termsAcceptedAt ×2, agreementPdfMediaId, expiresAt)
- `Deal` (stage, agreed price, commission snapshot, computed amounts, handshake timestamps, dispute fields) · `DealEvent` · `DealDocument`
- `NetworkPost` (type BUYER_REQUEST/PROPERTY_OFFER/DEVELOPER_ANNOUNCEMENT/DISTRESSED, criteria, body, expiresAt) · `NetworkPostReply` · `NetworkSubscription` (filters)

**Chat & notifications**
- `ChatThread` (kind VIEWING/DEAL/DIRECT) · `ChatMessage` · `ChatThreadRead`
- `Notification` **[P]** · `NotificationPreference` · `PushSubscription`

**Presentations & documents**
- `Selection` (agencyId, contactId?, ordered items, locale, public token, expiresAt) · `SelectionEvent` (view/like/enquire)
- `WindowCardTemplate` · `DocumentTemplate` (LISTING_AGREEMENT/RESERVATION/VIEWING_SHEET/OFFER/COLLABORATION, locale) · `GeneratedDocument` (signature status, signers, audit)

**Client portal (R2) · 2.1**
- `ClientPortalAccess` (agencyId, contactId, tokenHash, locale, expiresAt, lastSeenAt, revokedAt) · `ClientPortalNote` (contact's notes/likes on items)

**Social · 2.1**
- `SocialAccount` (agencyId, provider FACEBOOK_PAGE/INSTAGRAM_BUSINESS, externalId, tokenEnc, expiresAt, status) · `SocialPost` (accountId, target listing?, kind POST/CAROUSEL/REEL, captions per locale, media, scheduledAt, publishedAt, externalPostId, status, error) · `VideoReel` (listingId, template, aspect, status, mediaObjectId, durationSec) R3

**Data quality**
- `DuplicateCluster` (canonicalPropertyId, confidence) · `DuplicateCandidate` (pair, score, signals, status AUTO/PENDING_REVIEW/REJECTED)

**Marketing (R3)**
- `AgencyEmailDomain` · `EmailTemplate` · `EmailCampaign` · `EmailCampaignRecipient` · `EmailSuppression` · `FeaturedListing`

**AI**
- `AiJob` (kind, tenant, model, tokens, cost, status) · `AiUsageMonthly` (budget caps) · `PromptVersion` (registry) · `AiFeedback` (thumbs up/down → evals)

**Billing**
- `Plan` · `AddOn` · `AgencySubscription` (tier, seats, add-ons, cycle, currency, status, manual grant, price lock, trialEndsAt) · `SubscriptionInvoice` · `ProcessedStripeEvent`
- `ReferralCode` (agencyId, code) · `Referral` (referrerAgencyId, referredAgencyId, status, rewardCents, rewardedAt) **2.1**

**Support, audit, compliance**
- `Ticket` · `TicketMessage` · `AuditLog` **[P]** · `ConsentRecord` · `ErasureRequest`
- `DataExportJob` (kind CONTACTS/LEADS/LISTINGS/FULL_ACCOUNT/GDPR_SUBJECT, format CSV/XLSX/ZIP, status, storage key, expiresAt) **2.1** (replaces DataExportRequest)

**Platform**
- `OutboxEvent` (aggregate, type, payload, processedAt) · `PropertyStatsDaily` **[P]** · `SearchQueryLog` **[P]** · `AgencyStatsDaily` **[P]**

**Legacy migration**
- `LegacyIdMap` (entity, legacyId, newId) · `LegacyUrlRedirect` (oldPath, newPath, locale, hits) · `MigrationBatch` (agency, status, counts, validation report)

**Index notes**
- Listings: (visibility, status, locationId, typeId, price) covering indexes; unique (source, externalRef, agencyId)
- Geo: GiST on location polygons and listing points
- Matching: GIN on profile arrays; B-tree on price ranges; HNSW (halfvec) on embeddings
- Lists use cursor pagination on (createdAt, id); no OFFSET on hot paths

---

## 7. MODULE SPECIFICATIONS

Each module lists scope and the specific things that put it ahead of the competition.

### M1 · Identity, agencies & verification — R1
- Signup → agency-of-one → verification queue (CIF/NIF, proof of business) → VERIFIED unlocks SHARED, PUBLIC, website API
- Invites, seats, roles, 2FA, session management, API key management (create, scope, rotate, revoke)
- Staff console: verify, suspend, impersonate (reason required, fully audited)
- Preferred agencies list (2.1): trusted partners; share listings to PREFERRED only; filter network search by it
- **Ahead:** verified-only network ("every agent you see is a checked business")

### M2 · Properties & media — R1
- Manual create/edit, bulk edit, field locks, per-listing commission, visibility, status lifecycle, price/status history
- Media: browser hashes file → asks API "have you got this?" → upload only if new → master + variants. EXIF strip, HEIC → WebP, pHash
- Quality score (photos, resolution, description length, translations, location precision, freshness) shown with fix-it hints
- Freshness: listings unconfirmed for 90 days prompt the agent; auto-hidden from the network after 120 days unless confirmed
- Listing overrides (2.1): an agency rewrites title/description of any network or new-build listing for its own channels
- Bookmarks (2.1): folders of saved properties with notes; one click to a selection
- **Ahead:** quality score + freshness = the most trustworthy inventory in Spain

### M3 · New developments & developer portal — model R1 · portal + data ops R2
- Development → Phase → Unit with live status; versioned price lists with diffs; documents; payment terms; developer commission
- Developer self-serve: bulk upload (CSV/Kyero/price-list PDF), availability toggles, access OPEN or PRIVATE_NETWORK, enquiry and reservation dashboard, announcements to all agents (via AMS)
- Data ops console (staff): developers send price lists → **AI extracts units → diff vs current → human approves → published**; freshness SLA 24 h; "last verified" badge
- **Ahead:** Resales Online's freshness with Inmoconnect's self-service, at a fraction of the manual effort

### M4 · Taxonomy & locations — R1
- 4-level locations with PostGIS polygons (draw areas on a map), location groups (e.g. Costa del Sol), aliases for feed mapping
- Types and features with groups, icons (manual), translations, aliases
- Unmatched feed values land in a staff mapping queue — never silently dropped

### M5 · Imports — R1
- Connector framework with streaming SAX parsing (feeds of 100 MB+ never load into memory)
- Connectors: Kyero, generic XML (visual field mapper), CSV, Resales Online (own listings only), Milenio+, Infocasa, Inmoba, thinkSPAIN
- Bulk path: parse → staging table via COPY → validate → MERGE; images queued with hash dedup
- Field locks, per-connection on/off, schedule, run history, per-item errors, anomaly guard, fair-share scheduler
- **Ahead:** "connect your old CRM in 5 minutes" — the main switching barrier removed

### M6 · Website delivery — R1 (unique content R2 · hosted sites R3)
See §9. Website API v2, legacy shim, WordPress plugin v2, JS widget, per-site XML feed, iFrame embed; inventory policies; white-label; listing overrides; lead intake; caching. Unique per-site AI content in R2 (§9.6).

### M7 · Portal syndication — R1
- Per-agency, per-portal selection rules (all PUBLIC / tagged / manual)
- Writers: Kyero, thinkSPAIN, A Place in the Sun, generic XML; idealista and Fotocasa once partner access is approved
- Validation before export (required fields, CEE energy rating, photo minimums) with per-property error report
- Feeds generated by workers to R2, served via CDN with per-agency tokens

### M8 · CRM — R1
- Contacts (dedupe on email/phone, consent tracking), leads with source routing (§3 #12), customizable pipeline, tasks, calendar with ICS sync, activity timeline
- Seller acquisition board (board/list/calendar) → one-click convert to listing
- Lead inbox merging website, portal, chatbot, WhatsApp and manual leads
- Speed-to-lead (2.1): auto-acknowledgement in the buyer's language within 60 s with 3 similar listings; agent alert; response time measured per lead, agent and agency
- Data export (2.1): CSV/Excel of contacts, leads, listings; full account ZIP — every plan
- **Ahead:** every lead arrives with an AI summary and a suggested next step (R3)

### M9 · Matching & alerts — R2
- Client profiles with hard criteria + free-text wishes
- Engine: SQL hard filters → semantic score (pgvector) → learned boost from likes/dismissals → explanation ("4/5 must-haves, 6% over budget")
- Runs on listing events (outbox) + nightly sweep; modes OFF / REVIEW / AUTO_SEND; sends branded selections by email or WhatsApp
- Agent-side saved searches with alerts (new listing, price drop, back on market)
- **Ahead:** across the whole network + new-builds, multilingual, explainable

### M10 · MLS collaboration — R1 core · R2 agreements + deal room
- Network search shows commission terms upfront; one-click "register client" → viewing request with terms snapshot → owner accepts → both sides bound
- Registration conflicts resolved automatically by first valid timestamp (client fingerprint HMAC — no PII exposed)
- Deal room (R2): stages OFFER → RESERVATION → ARRAS → COMPLETION, documents, tasks, chat, e-signed collaboration agreement, handshake at completion, staff mediation for disputes
- **Ahead:** Inmoconnect's protection + Resales Online's network, in one flow

### M11 · Network board (AMS) — R1
- Post buyer requests, property offers, distressed sales, developer announcements; structured criteria
- Subscriptions with filters; replies open a chat thread; posts auto-match to members' listings ("you have 3 properties matching this request")
- **Ahead:** structured + auto-matched, not just a message wall

### M12 · Chat & notifications — R1
- 1:1 and deal threads, attachments (R2), read receipts, WhatsApp/email handoff
- Notifications: in-app, email digest (5-min debounce for offline users), web push (R2)

### M13 · Presentations & documents — R1 selections + PDF · R2 window cards + forms + e-sign
- Selections: pick listings/units → branded live page (prices and status update automatically) → share by WhatsApp/email; view/like/enquire tracking feeds the CRM
- PDF brochure and portfolio; window cards (multiple templates, PDF/HTML)
- Forms library: listing agreement, reservation, viewing sheet, offer, collaboration agreement — branded, multilingual, e-signature with audit trail (simple electronic signature; advanced provider integration later)
- White-label sanitizer removes owner phone numbers, emails and agency names from shared descriptions
- Client Mode (2.1): one tap hides commission, owner agency and internal notes everywhere in the dashboard so the agent can show the screen to a buyer; PIN to exit; enforced server-side

### M14 · Public portal (inmolink.es) — R1 MVP · R2 full SEO relaunch
- R1 MVP (2.1): search, listing detail, location pages, enquiry form, 301s from legacy URLs — enough to switch the legacy stack off
- R2:
- Locale-prefixed URLs, location landing pages (4 levels + groups), ISR, JSON-LD (`RealEstateListing`, `RealEstateAgent`, breadcrumbs, FAQ), per-locale sitemaps, hreflang
- AI search box (SPW-AI) and similar-listing links
- All legacy URLs 301 to new equivalents (from `LegacyUrlRedirect`)

### M15 · Marketing — R3
- Campaigns, templates, suppressions, verified sending domains (DKIM/SPF/DMARC), open/click tracking; bulk via SES
- Auto-newsletters: "new listings this week in your areas" generated from matching data
- Featured listings on the portal

### M16 · AI layer — R1 → R3
See §8.

### M17 · Data quality & dedupe — R2
See §10.

### M18 · Reports & analytics — R2
- Agency: listings, leads by source, conversion, response times, agent performance, collaboration revenue
- Listing: views and enquiries per channel (website, portal, selections)
- Market (R3): price per m² by area, days on market, price drops — from network data
- Super-admin: tenant health, feed health, AI spend, search gaps (no-result queries)

### M19 · Billing & plans — R1
- Stripe Checkout + Customer Portal, card + SEPA DD, annual default, seats, add-ons, proration, Stripe Tax, VAT ID reverse charge
- Legacy price lock (founding members), staff manual grants with expiry, dunning with grace period (access never cut mid-deal without notice)

### M20 · Staff console — R1
- Tenants, verification, impersonation, plan grants, bulk ops (reindex, re-import, replay outbox), feed health, mapping queues, dispute mediation, data ops queue (R2)

### M21 · Support & onboarding — R1
- In-app tickets (agent → staff), knowledge base links, chat support for Pro+
- Guided onboarding (2.1): role-based checklist (import listings, connect website, invite team, share first listing), short product tours, contextual help links; progress visible to staff

### M22 · Legacy migration — R1
See §14.

### M23 · Mobile — R2 PWA · R4 native
- Installable PWA: listings, leads, chat, calendar, camera upload, push notifications

### M24 · Affiliates & partners — R4
- Referral partners with branded portfolio pages, tracked referrals, payout on completion; partner API + outbound webhooks

### M25 · Social media — R1 posting · R3 video reels (2.1)
- Connect Facebook Pages and Instagram Business accounts (Meta Graph API); post a listing as image/carousel with AI captions per language; schedule; history and errors
- R3: AI video reels from listing photos (9:16 and 1:1 templates, captions, licensed music), auto-post
- **Ahead:** restores the legacy feature agents already use, then beats both competitors with reels

### M26 · Client portal — R2 (2.1)
- Magic-link access for buyers, white-labelled to the agency, in the buyer's language
- Shows selections (live prices/status), likes and notes, viewing schedule, shared documents; enquiry and WhatsApp/email to the agent
- Every action feeds the CRM timeline and the matching engine
- **Ahead:** replaces PDFs and WhatsApp threads with one professional page

### M27 · Referrals — R2 (2.1)
- Agency-refers-agency codes and links; reward as account credit when the referred agency pays its first invoice; dashboard of referrals and credits

### M28 · Unique site content — R2 (2.1)
See §9.6.

---

## 8. AI LAYER — THE OUTCLASS ENGINE

Model tiers: **FAST** = `AI_MODEL_FAST` (bulk, cheap), **SMART** = `AI_MODEL_SMART` (complex reasoning, hard documents). Both set by env; current defaults in ADR 0008.

| # | Feature | What it does | Model tier | Release |
|---|---|---|---|---|
| 1 | Listing Studio | Facts + photos → description, SEO title/meta, all enabled languages; tone presets; marked AI_DRAFT until reviewed | FAST (vision for photos) | R1 |
| 2 | White-label sanitizer | Strips phones, emails, agency names from shared listing text; flags logos/watermarks/phone numbers in photos | FAST + vision | R1 text · R2 photos |
| 3 | AI search (SPW-AI) | Natural language → structured filters + semantic rerank, multilingual, on websites and portal | FAST + embeddings | R1 websites · R3 everywhere |
| 4 | Buyer Match Engine | Hybrid matching with explanations; learns from likes/dismissals | embeddings + rules | R2 |
| 5 | New-build extractor | Price-list PDF/Excel/image → structured units → diff → human approval | SMART (hard docs), FAST (simple) | R2 |
| 6 | Duplicate detective | Scores candidate pairs with photo hashes, geo, specs, text similarity | rules + embeddings | R2 |
| 7 | Photo intelligence | Room tagging, cover suggestion, auto-ordering, quality warnings, alt text | vision | R2 |
| 8 | Conversational agent | Website chat + WhatsApp: answers from live inventory, qualifies buyer, books viewing in calendar, creates lead + client profile | SMART | R3 |
| 9 | CRM copilot | Lead summary, next best action, draft follow-up in the client's language, voice note → notes + tasks | SMART + speech-to-text | R3 |
| 10 | Market insights | Area price stats, days on market, seller pitch and buyer reports; valuation estimate (beta, clearly labelled) | rules + FAST narrative | R3 |
| 11 | Lead scoring | Ranks leads by intent signals | rules → model | R3 |
| 12 | Unique site content (2.1) | Rewrites shared listings per agency website and locale so each site has original text (§9.6) | FAST via batch API | R2 |
| 13 | Speed-to-lead responder (2.1) | Instant acknowledgement in the buyer's language with similar listings (R1 templated); full AI reply, qualification and booking via #8 (R3) | template → SMART | R1 · R3 |
| 14 | Social captions & reels (2.1) | Captions per language and platform; reel script, captions and shot order from photo tags | FAST | R1 captions · R3 reels |
| 15 | Client portal assistant (2.1) | Answers buyer questions about their selections from listing data; hands off to the agent | FAST | R3 |

**AI platform rules**
- One gateway (`packages/platform/src/ai`): provider abstraction, retries, timeouts, circuit breaker, response caching by input hash
- Prompt registry with versions; evaluation sets per feature run in CI before a prompt change ships
- Per-tenant monthly budgets with soft/hard caps; bulk work (translations, re-tagging) via the discounted batch API
- Data minimization: no client PII sent unless the feature needs it; check provider data-retention terms; list AI providers as sub-processors
- Human-in-the-loop for prices, commission and legal text — AI never publishes these
- `AiFeedback` on every output → weekly review → prompt/eval updates
- The current n8n chatbot logic is ported into the core platform (worker + AI gateway) for multi-tenant scale; n8n stays for internal automations only

---

## 9. WEBSITE DELIVERY — DEEP DIVE (the revenue engine)

### 9.1 Website API v2

| Endpoint | Purpose |
|---|---|
| `GET /v2/listings` | Search with filters, facets, geo, sort, cursor pagination, `?lang=` |
| `GET /v2/listings/{ref}` | Detail (white-labelled to the calling site) |
| `GET /v2/developments` · `/v2/developments/{id}` · `/units` | New-build cards, detail, live unit table |
| `GET /v2/taxonomy/{locations,types,features}` | Localized filter options |
| `GET /v2/changes?since=` | Delta feed for plugin caches |
| `GET /v2/sitemap` | Listing URLs for the site's sitemap |
| `POST /v2/leads` · `POST /v2/viewing-requests` | Website forms → CRM with source = AGENCY_WEBSITE |
| `GET /v2/search/ai` | Natural-language search (SPW-AI) |

- **Auth:** secret key (server-to-server, WordPress) or publishable key + origin allowlist (browser widget)
- **Inventory policy** per site: OWN_ONLY, OWN_PLUS_NETWORK, or custom (locations, types, price band, minimum commission, new-builds on/off)
- **White-label:** network listings carry the site agency's reference prefix, contact details and branding; owner identity never leaves the API
- **Duplicates:** one canonical listing per cluster
- **Images:** CDN URLs with size presets

### 9.2 Caching & resilience
- Responses served from `ListingReadModel` (PK lookups) + search engine for filtered queries
- Cloudflare cache: key = (site scope, normalized query, locale); TTL 60–300 s; `stale-while-revalidate`; `stale-if-error` 24 h
- Purge strategy: short TTLs + per-listing tags where the Cloudflare plan supports tag purge; versioned keys as fallback
- Per-key rate limits and daily quotas; anomaly detection on bulk pagination (scraping); honeytoken listings to detect leaked inventory

### 9.3 Legacy API shim (`/v1`)
- Before writing it: capture real legacy traffic (endpoints, parameters, frequencies) and record responses for representative queries → **golden files**
- Shim maps legacy requests to v2 and reshapes responses; CI asserts 100% golden-file parity
- Cutover trick: point the legacy API hostname at feed-api → **every existing client website migrates without touching the site**. Rollback = DNS flip

### 9.4 WordPress plugin v2
- Gutenberg blocks + legacy shortcodes (backward compatible), search/results/detail/developments/map templates
- SEO: per-locale pretty URLs, JSON-LD, sitemap integration, Polylang/WPML aware
- Local cache layer (transients + optional mirror table for detail pages) with stale fallback if the API is unreachable
- Lead and viewing forms post to the API (Turnstile protected)
- Auto-updates from our own update server; health check page reporting API status and cache age

### 9.5 Other channels
- JS widget (SPW-AI) for non-WordPress sites
- **Per-site XML feed (2.1):** Kyero-format and generic XML of the site's inventory (same policy, white-label and overrides as the API) for web designers who want XML; token URL, CDN-cached
- **iFrame embed (2.1):** search + results + detail pages served by `apps/public` under the agency's branding, embeddable on any site; leads routed to the agency
- Hosted multi-tenant Next.js sites with custom domains via Cloudflare for SaaS (R3)

### 9.6 Unique per-site content (R2 · 2.1)
**Problem:** 200 agency sites showing the same network villa with the same text = duplicate content; Google ranks one and buries the rest.
**Solution:** `SiteListingContent` — an AI rewrite of title, description and meta per (site, listing, locale), written in the agency's tone, never changing facts.
- **Precedence:** agency override (§3 #54) > site content (READY) > owner text
- **Lazy:** generated when a listing first appears in a site's sitemap or detail page, not for the whole network
- **Capped:** monthly cap per plan (§11), priority by traffic and sitemap position; overflow keeps owner text
- **Cheap:** FAST model via the batch API; dedupe by `sourceHash` so unchanged listings are never regenerated
- **Fresh:** marked STALE when price, specs or owner text change materially; regenerated in the next batch
- **Safe:** facts (price, size, beds, location, commission) are injected from data, never written by the model; output passes the white-label sanitizer
- Cost is tracked per site in `AiUsageMonthly` and shown in the staff console

---

## 10. DATA QUALITY & DEDUPE

**Duplicate signals** (scored 0–1):
- Shared exact image hashes (SHA-256) — strongest signal, free from the media pipeline
- Perceptual hash distance for re-encoded or cropped photos
- Geo distance (< 50 m or same building polygon)
- Type, beds, baths, built m² within tolerance; price within ±5%
- Description embedding similarity

**Clustering:** score ≥ 0.9 → auto-cluster; 0.7–0.9 → review queue; agencies can dispute.
**Canonical choice:** exclusive mandate > earliest listing > higher quality score.
**Display:** agents see "listed by N agencies" with each agency's commission terms; client-facing outputs show the canonical listing only.

**Quality & freshness:** quality score drives ranking and nudges; 90-day confirmation prompts; 120-day auto-hide from network; feed-sourced listings refresh `lastConfirmedAt` on each successful run.

---

## 11. PLANS & PRICING (proposal — validate in the pilot)

> **Prices are not fixed.** Every figure in this plan (€800/yr Pro, €79/mo, ~€1,500/yr Business, founding lock, trial length, referral rewards, caps) is a working assumption for planning and ARR estimates. Plan prices, tiers, limits and add-ons are data (plan catalog synced to Stripe, editable by staff), never constants in code.

Unlimited own listings on every plan (supply is the network's lifeblood). Gates sit on consumption and automation. Features join a plan as their release ships (§16).

| | Free | **Pro** | Business | Enterprise |
|---|---|---|---|---|
| Price (excl. IVA) | €0 | **€800/yr** (or €79/mo) | ~€1,500/yr | Custom |
| Users included | 1 | 4 | 10 | Custom |
| Own listings + portal visibility | Unlimited | Unlimited | Unlimited | Unlimited |
| Network sharing / search (give-to-get) | ✅ | ✅ | ✅ | ✅ |
| New-build database | View | ✅ | ✅ | ✅ |
| CRM | Basic (100 contacts) | Full | Full + automations | Full |
| Client matching | — | REVIEW mode | AUTO_SEND | ✅ |
| Website API + WordPress plugin + XML/iFrame | — | 1 site | 3 sites/brands | Unlimited |
| Unique per-site AI content (R2) | — | 1,000 listing-locales/mo | 5,000/mo | Custom |
| Portal exports | — | ✅ | ✅ | ✅ |
| Selections, PDFs, window cards, forms | Selections | ✅ | ✅ | ✅ |
| Client Mode, bookmarks, preferred agencies | ✅ | ✅ | ✅ | ✅ |
| Data export (CSV/Excel, full ZIP) | ✅ | ✅ | ✅ | ✅ |
| Speed-to-lead auto-response | — | ✅ | ✅ | ✅ |
| Social posting (FB/IG) | — | 2 accounts | 6 accounts | Custom |
| AI video reels (R3) | — | Add-on | 20/mo | Custom |
| Client portal for buyers (R2) | — | ✅ | ✅ | ✅ |
| AI Listing Studio | 10 listings/mo | Fair use | Higher limit | Custom |
| AI chat / WhatsApp agent | — | Add-on | Included (fair use) | ✅ |
| CRM copilot | — | — | ✅ | ✅ |
| Email campaigns | — | Add-on | ✅ | ✅ |
| Reports | Basic | Standard | Advanced | Custom |
| Support | Help centre | Chat | Priority | SLA + account manager |

- **Add-ons:** extra user, extra website, hosted website (R3), AI chat/WhatsApp agent, AI credit packs, featured listings
- **Developers:** free forever (they are the supply)
- **Partners/affiliates:** priced in R4
- **Founding offer:** migrated and pilot agencies lock €800/yr for 3 years; free during the parallel-run period; switch on their old provider's renewal date
- **Trial (2.1):** new, non-migrated signups get 14 days of Pro, then fall back to Free with data intact
- **Referrals (2.1):** referring agency earns one free month per referred agency that pays (credited to Stripe customer balance); referred agency gets 10% off year one

---

## 12. SECURITY & MULTI-TENANCY

- **RLS:** every tenant table has a policy on `current_setting('app.agency_id')`; set with `SET LOCAL` inside each transaction (PgBouncer-safe). App-level scope helper as a second layer. CI runs cross-tenant read/write tests on every model
- **Encryption:** AES-256-GCM with key versioning for secrets (SMTP, portal credentials, feed credentials, TOTP) and client PII in registrations; encrypted backups
- **API keys:** stored as hashes, prefix shown, scoped, rotatable, per-key quotas
- **Edge:** Cloudflare WAF rules, bot management basics, Turnstile on signup, login anomalies, public forms
- **App:** Helmet/CSP nonces, strict CORS, SameSite cookies (Strict for auth), Zod validation everywhere, parameterized queries only, file checks (extension + magic bytes + size)
- **Auth abuse:** per-IP and per-email rate limits, credential-stuffing detection, 2FA required for staff and agency admins
- **Staff access:** least privilege, impersonation with mandatory reason, all staff actions audited
- **Anti-scraping:** quotas, pagination anomaly detection, honeytoken listings, ToS prohibiting bulk extraction
- **Assurance:** external penetration test before R1 go-live and yearly; dependency scanning in CI; secrets never in the repo

---

## 13. LEGAL, GDPR & SPAIN-SPECIFIC

- **Roles:** Inmolink is processor for agencies' CRM data (DPA with every agency) and controller for platform accounts; published sub-processor list (Cloudflare, Stripe, email providers, AI providers)
- **EU-only hosting** for all primary data and backups
- **Data subject rights:** export (ZIP via worker), erasure (anonymize PII, keep deal/audit records with anonymized actor), consent records, marketing opt-out
- **Retention:** inactive leads/contacts auto-anonymized after a configurable period; logs with PII redaction
- **Energy rating (CEE):** Spanish rules require the energy rating in property advertising — enforced before PUBLIC, website and portal export (confirm exact rules with counsel)
- **Agent registers:** store regional register numbers where required (e.g. Catalonia's AICAT) and show them on public profiles
- **Lawyer review before R1:** terms of service, DPA, collaboration agreement template, client-registration rules, cookie policy, AI disclosures; affiliate payouts before R4

---

## 14. LEGACY MIGRATION

Two migration paths, one toolkit.

**Path A — legacy Inmolink agencies**
1. **Inventory:** schema dump of the legacy database; catalogue of legacy API endpoints and real traffic (which sites call what); list of client websites + plugin versions; inmolink.es URL patterns; the 9 locales
2. **Contract capture:** recorded legacy API responses → golden files (§9.3)
3. **ETL** (`scripts/legacy-migration/`): read-only extract → transform to v2 models (`LegacyIdMap` keeps every old ID and reference) → staging → validate → merge. Idempotent, re-runnable, per-agency batches
4. **Media:** re-ingest through the media pipeline (dedup kicks in automatically)
5. **Delta sync:** hourly legacy → v2 during the parallel run
6. **Validation report** per agency: listing/contact/lead/image counts, sample field diffs, URL checks — target < 0.5% unexplained differences
7. **Cutover:** legacy API hostname → feed-api shim (sites switch with zero touch); agents get dashboard access the same day; legacy becomes read-only
8. **Portal:** inmolink.es legacy URLs 301 via `LegacyUrlRedirect`
9. **Rollback:** DNS flip back within minutes during the cutover window
10. **Decommission:** after 90 stable days; final archive export kept encrypted in R2

**Path B — agencies coming from Resales Online or other CRMs**
1. Collect each agency's renewal date; schedule cutover just before it
2. Import their **own** listings via the Resales Online (own-only) or XML/CSV connector; import contacts/leads via CSV export
3. Run both inventories on their website in parallel (we manage their sites) until network parity in their area
4. Switch website feed, cancel old subscription at renewal — nobody pays twice

**Rollout:** pilot 15–20 agencies in one dense area (e.g. Marbella–Estepona) → fix → waves of 30–50 agencies per week.

---

## 15. TESTING, LOAD & CHAOS

**Per sprint**
- Vitest unit/integration; Playwright E2E on critical flows (signup → verify, listing create, import, website search → lead, viewing request → deal, checkout)
- Cross-tenant isolation suite on every model
- Golden-file contract tests for the v1 shim
- Lighthouse ≥ 90 on public pages; bundle budget (fail PR if main bundle > 250 KB)

**Synthetic 5,000-agency dataset** (`scripts/seed/`): 5,000 agencies, 25k users, 2M listings, 60M media rows (metadata; real images for pipeline tests), 10M contacts, 1M client profiles, 5,000 feed connections.

**k6 scenarios**

| Scenario | Target |
|---|---|
| Website API mix | 1,000 rps origin sustained, 2,000 rps spike via edge; p95 per SLO |
| Dashboard | 5,000 concurrent users; API p95 < 300 ms |
| Import storm | 500 feeds simultaneously; no tenant's queue age > 15 min |
| Matching storm | 10k listing changes in 5 min against 1M profiles; processed < 10 min |
| Realtime | 5,000 sockets, message fan-out p95 < 500 ms |
| Soak | 24 h at 50% load; no memory growth, no connection exhaustion |

**Chaos drills (before R1 go-live, then quarterly)**
- Kill search → Postgres fallback serves; kill feed-api origin → CDN stale serves
- Kill Postgres primary → promote standby within RTO
- Restart redis-queue → zero lost jobs
- AI provider returning 100% errors → core flows unaffected
- Full restore from PITR to a fresh server → measured RTO

---

## 16. RELEASE ROADMAP

Estimates assume one developer directing Claude (Opus 5.5) in two-week sprints. Progress is measured by **sprint exit criteria, not the calendar** — AI-assisted pace may be faster; human-dependent items (`docs/build/HUMAN-ACTIONS.md`) usually set the real pace. Every sprint is broken into numbered tasks with acceptance checks in `docs/build/BACKLOG-R1.md` and `docs/build/BACKLOG-R2-R4.md`.

### R0 + R1 — Switch-ready (~10 months at the estimates below)

| Sprint | Weeks | Scope | Exit criteria |
|---|---|---|---|
| S0 Foundation | 2 | Monorepo + module scaffolder, Docker, CI/CD (Kamal) to staging + prod, Postgres + PgBouncer + WAL-G, Redis ×2, search, Drizzle + RLS registry + isolation harness, outbox, cache, Auth.js + JWT, OpenTelemetry + Sentry, feature flags, i18n base, seed + synthetic generator | Login works on staging; restore drill passes; boundary and isolation checks fail on planted violations |
| S1 Tenancy | 2 | Agencies, verification, roles, invites, seats, 2FA, API keys, preferred agencies, agency profile, staff console shell, audit log | Staff verifies an agency; isolation tests green |
| S2 Taxonomy + i18n | 2 | Locations (PostGIS, groups, aliases), types/features (aliases), staff taxonomy admin, 9-locale framework | Legacy taxonomy imported by script |
| S3 Properties + media | 3 | Listing CRUD, per-listing commission, visibility + share scope, locks, media pipeline (SHA-256, pHash, variants, EXIF, HEIC), history, quality score v1, freshness, bookmarks, listing overrides, bulk edit | 10k listings with photos processed < 1 h on staging |
| S4 Developments | 2 | Development/phase/unit, price-list versions, documents, access rules | Legacy new-build data imported |
| S5 Search + read models | 2 | `ListingReadModel`, search adapter + single index, Postgres fallback, network search with commission + preferred filter, saved searches + alerts | Search p95 < 100 ms at 2M synthetic docs |
| S6 Imports | 3 | Connector framework (SSRF-safe fetch, XXE-safe streaming parser), Kyero, generic XML mapper, CSV/Excel, Resales Online (own), Milenio+, Infocasa, Inmoba, thinkSPAIN, alias queue, fair scheduler, anomaly guard | 100 MB feed streams; one feed cannot delay others |
| S7 Website API v2 | 2 | Endpoints, inventory policies, white-label + overrides, keys, quotas, CDN caching, anti-scraping, lead intake + speed-to-lead auto-ack, per-site XML feed, iFrame embed | 1,000 rps origin load test passes |
| S8 Legacy shim + WP plugin v2 | 3 | v1 shim with golden files, plugin v2 (blocks, shortcodes, SEO, cache, stale fallback, forms, auto-update), JS widget | 100% golden-file parity |
| S9 Portal exports | 2 | Kyero, thinkSPAIN, APITS, generic XML; selection rules; CEE validation; idealista/Fotocasa adapters behind flags | Feeds validate against portal specs |
| S10 CRM core | 3 | Contacts (consent), leads + source routing, pipeline, tasks, calendar (ICS), activity, acquisition board, data export, response-time KPI | Website lead lands with correct agency < 10 s |
| S11 MLS core + AMS | 3 | Client registration, viewing requests + terms snapshot, chat, notifications, network board, My collaborations | Full collaboration flow passes E2E |
| S12 Presentations + AI Studio + social | 3 | AI gateway, branded live selections, WhatsApp share, PDF brochure, AI descriptions + translations, text sanitizer, Client Mode, Facebook/Instagram posting | Selection shows new price within 5 min of owner edit |
| S13 Billing + staff console + onboarding | 2 | Stripe + SEPA, plans, seats, add-ons, trial, price locks, gates, bulk ops, onboarding checklist + tours, support tickets | Billing E2E in test mode |
| S14 Migration tooling | 2 | ETL, batches, validation reports, media re-ingest, redirects, delta sync, cutover/rollback runbook | Dry run of all 200 agencies < 0.5% unexplained diffs |
| S15 Portal MVP | 2 | inmolink.es on the new stack: search, detail, location pages, enquiries, sitemaps, 301s from legacy URLs | Legacy portal URLs resolve via 301; Lighthouse ≥ 90 |
| S16 Hardening | 2 | Load + chaos at 5,000-agency profile, pen test, DR drill, GDPR flows, runbooks, status page | All §15 targets met |
| S17 Pilot | 2–4 | 15–20 agencies cut over; fixes; go/no-go | Zero website outages; pilot agencies stay |

Then mass migration in waves (§14). Legacy stack is switched off 90 days after the last wave.

### R2 — Network (~5 months)
Matching engine + auto-send · embeddings pipeline · dedupe + clusters · deal room + e-signed agreements + forms library · developer portal + data ops console + AI price-list extraction · window cards · reports · PWA + push · photo intelligence (tagging, ordering, watermark/phone detection) · inmolink.es full SEO relaunch · **unique per-site AI content** · **client portal** · **agency referral programme** · rentals + rental portals.

### R3 — Outclass (~5 months)
Conversational agent (website + WhatsApp Cloud API) incl. full AI speed-to-lead · AI search everywhere · CRM copilot + voice notes · market insights + seller/buyer reports · email campaigns + auto-newsletters · hosted websites (Cloudflare for SaaS) · featured listings · valuation beta · **AI video reels + auto-posting** · client portal assistant · on-the-fly watermarking at the edge (no stored copies, keeps dedup intact).

### R4 — Ecosystem
Affiliate/partner program · partner API + outbound webhooks · native mobile app · enterprise SSO · franchise/multi-country (Portugal first) · advanced analytics.

**Scope rule:** R1 scope is frozen at S0. Anything new goes to R2+ unless it blocks migration.

---

## 17. OPERATIONS & OBSERVABILITY

- **Dashboards:** golden signals per service; queue depth and age per pool; per-tenant usage; feed health; freshness lag; AI spend; error budgets
- **Alerts** (phone + email) on SLO burn rate, queue age, replication lag, backup failure, certificate expiry, disk > 70%
- **Status page** (public) — agencies trust what they can see
- **Deploys:** zero-downtime rolling via Kamal; canary to pilot agencies via flags; one-command rollback
- **Runbooks** (`docs/runbooks/`): failover, PITR restore, reindex, outbox replay, feed storm, AI outage, scraping incident, agency cutover, agency rollback
- **On-call:** solo at first with strict alerting; shared rotation once a second engineer joins

---

## 18. ENGINEERING STANDARDS

- TypeScript strict, no `any` in new code; Biome; Vitest; MSW; Playwright; husky + lint-staged
- OpenAPI from Fastify → generated typed client (`packages/sdk`) used by web and widget
- Every architectural decision = ADR; every incident = TROUBLESHOOTING.md entry
- Expand/contract migrations; migrations validated against a production-shaped snapshot in CI
- Performance budgets in CI (bundle size, critical query plans)
- CLAUDE.md + `.claude/rules/` hold conventions, module boundaries and "never do" rules for AI-assisted coding (§23)
- Module boundaries enforced by dependency-cruiser; every module follows the layout in `docs/build/PATTERNS.md`
- Every PR: CI green + review (second engineer, or the `code-reviewer` and `security-auditor` subagents while solo)

---

## 19. TEAM & HIRING

| Order | Role | When | Why |
|---|---|---|---|
| 1 | Second full-stack engineer | Before R1 go-live | Bus factor, code review, on-call |
| 2 | Onboarding & support (ES/EN) | Migration waves | 200 agencies in a few months is a people job |
| 3 | New-build data ops (1–2) | R2 | Freshness SLA; reviewing AI extractions |
| 4 | DevOps/SRE (contract, part-time) | Stage B | HA, Patroni, capacity planning |
| 5 | Sales / partnerships on the coast | Post-migration | Growth to 1,000; developer relationships |
| 6 | Network manager | R2 | Network rules, disputes, agency quality |

---

## 20. RISKS

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Solo developer / bus factor | High | High | Hire #2 before go-live; ADRs, runbooks, CLAUDE.md |
| Legacy shim mismatch breaks client sites | Med | High | Golden-file tests, per-agency cutover, DNS rollback |
| Resales Online reacts (price cuts, API limits) | Med | Med | Own-listings-only imports; compete on AI/websites/data, not price alone; 3-year price locks |
| Network chicken-and-egg in new areas | Med | High | Launch dense (Costa del Sol), developers free, give-to-get |
| New-build data goes stale | High | High | Data ops + AI extraction + developer self-serve + 24 h SLA + "last verified" badges |
| Inventory scraping via API keys | Med | High | Quotas, anomaly detection, honeytokens, ToS |
| AI cost runaway | Med | Med | Per-tenant budgets, FAST model default, batch API, caching, per-plan caps on unique site content |
| AI errors in prices/legal text | Med | High | Human approval; AI never publishes those fields |
| Commission disputes | High | Med | Registrations, immutable snapshots, mediation process, network manager |
| GDPR breach | Low | Critical | RLS, encryption, pen tests, DPA, least-privilege staff access |
| idealista/Fotocasa approval delays | Med | Med | Launch with open XML portals; apply early |
| Single-site infrastructure failure | Low | High | Standby in another DC from R1; PITR; quarterly drills |
| Scope creep delays R1 | High | High | Frozen R1 scope; flags; strict sprint exits |

---

## 21. KPIs

**North star:** collaboration deals completed through the platform per month.

| Area | KPIs |
|---|---|
| Migration | % of the 200 migrated, time per cutover, website incidents during cutover (target 0), 90-day retention |
| Network | Active SHARED listings, % agencies sharing, network searches per agent, registrations, viewing requests, deals by stage |
| Websites | API availability, CDN hit rate, leads delivered per agency per month |
| Data quality | Duplicate rate, % listings confirmed < 90 days, new-build price-list age |
| AI | % listings with AI translations, match emails → enquiry rate, chatbot leads, AI cost per agency |
| Business | MRR/ARR, net revenue retention, churn, CAC payback, infra + AI cost < 10% of revenue |

---

## 22. HOW TO START

1. Create `E:\Repos\InmolinkCRM\` and copy in the kit: `PLAN.md`, `CLAUDE.md`, `.claude/`, `docs/build/`.
2. `git init` and commit: `docs: plan v2.1 and build kit`.
3. Start the human actions with long lead times now (`docs/build/HUMAN-ACTIONS.md`): legacy database dump and API logs, Meta business verification and app review, Stripe, Cloudflare, servers, lawyer.
4. Open Claude Code in the repo with Opus 5.5 and run `/next-task`. It picks **S0-01** from `docs/build/STATUS.md`, builds it, runs the gates, updates STATUS and commits. Repeat.
5. At the end of each sprint run `/sprint-review`, look at the demo notes it writes, and approve or redirect.

No feature code before S0 is complete: the scaffolder, boundary checks, RLS registry and isolation harness are what keep 100+ modules' worth of AI-written code consistent and fast.

---

## 23. BUILD SYSTEM FOR CLAUDE (OPUS 5.5)

The plan is executed by Claude Code. These files make that reliable over hundreds of sessions:

| File | Purpose | Loaded |
|---|---|---|
| `CLAUDE.md` | Operating manual: session protocol, golden rules, budgets, Definition of Done (< 200 lines) | Every session |
| `.claude/rules/*.md` | Detailed rules per area (database, api, frontend, workers, ai, testing, security, wp-plugin), scoped by file path | When matching files are touched |
| `docs/build/BACKLOG-R1.md` · `BACKLOG-R2-R4.md` | Every task: ID, plan refs, module, dependencies, what to build, acceptance checks | Per task |
| `docs/build/PATTERNS.md` | Reference code for every layer (schema + RLS, repo, service, route, feed route, job, outbox, cache, bulk load, Next.js page, tests) | Per task |
| `docs/build/STATUS.md` | Single source of progress: current task, done list, blockers, decisions | Start and end of every session |
| `docs/build/BUILD-GUIDE.md` | How Shahzaib runs the build: cadence, reviews, parallel work, when to step in | Human reference |
| `docs/build/HUMAN-ACTIONS.md` | Everything only a human can do, with the sprint that needs it | Human reference |
| `.claude/skills/` | `/next-task`, `/new-module`, `/perf-check`, `/sprint-review` | On demand |
| `.claude/agents/` | `code-reviewer`, `security-auditor`, `perf-auditor` subagents | On demand / sprint review |
| `.claude/settings.json` + `.claude/hooks/` | Auto-format after every edit; re-inject current status at session start and after compaction | Automatic |

**Rules of execution**
- One task per session where possible; read only the PLAN sections a task references (keeps context small and output consistent).
- A task is done only when every acceptance check passes and the Definition of Done in `CLAUDE.md` is met.
- If a task needs a human input that is missing, Claude builds against fixtures or mocks, marks the task `BLOCKED-HUMAN` with the H-number, and moves to the next unblocked task.
- If a task would contradict a decision in §3, Claude does not silently change it: it writes a proposed ADR in `docs/adr/`, notes it in STATUS, and asks at the next sprint review.

---

## APPENDIX A — WHAT CHANGED FROM PLAN v1

| Area | Plan v1 | Plan v2 | Why |
|---|---|---|---|
| User base | Greenfield | 200 clients + legacy data | Migration is the launch |
| Website feeds | Not covered | API v2 + legacy shim + WP plugin v2 | Core reason agencies pay |
| Portal exports | Imports only | Kyero, thinkSPAIN, APITS, generic, idealista/Fotocasa | Parity with legacy and Resales Online |
| New-builds | Not modelled | Development → Phase → Unit + data ops + AI extraction | Resales Online's biggest moat |
| CRM | Missing models | Full CRM + matching | Parity + main daily workflow |
| Agency badge | Mandatory everywhere | Agent-to-agent only; white-label to clients | Buyers would go direct |
| Lead routing | Always owner | By source; presenting agency for websites | Protects introducers |
| Commission | Per-agency default, handshake at sale | Per listing, accepted before viewing | Protects introducers |
| AMS board | 1:1 chat only | Network board with filters | Legacy feature agents use daily |
| Dedupe | Storage only | Listing clusters + canonical | 200+ agencies share the same homes |
| Languages | 4 | Legacy 9 | No regression; Dutch/Scandinavian buyers |
| Scale target | 150M properties | 2M listings, 60M media | Realistic; resources go to reliability |
| Read replica | Same VPS | Standby in another DC | Real high availability |
| Backups | Nightly pg_dump | WAL-G PITR, RPO ≤ 5 min | 24 h of CRM data loss is unacceptable |
| Redis | One instance | Queue + cache split | BullMQ needs noeviction; cache needs LRU |
| Deploy | PM2 on one VPS | Docker + Kamal, multi-host ready | Horizontal scale |
| Pricing | Almost all free | Gates on website API, exports, new-builds, AI | Supports €800 model |
| AI | Icons, translation, description, search parsing | 11-feature AI layer | Main differentiator |
| Variants | Stored as rows | Deterministic keys | ~240M fewer rows at ceiling |
| Search | Index per locale | Single index, localized fields | Less RAM and indexing work |
| Passwords | Argon2id and bcrypt (conflict) | Argon2id | Consistency |
| Webhooks | v1 | R4 | Low value for agencies |
| AI icon suggester | v1 | Dropped | Not worth building |

---

## APPENDIX A2 — WHAT CHANGED IN v2.1

| Area | v2.0 | v2.1 | Why |
|---|---|---|---|
| ORM | Prisma + Kysely | Drizzle (one tool) | Cleaner RLS transactions and bulk SQL; less tooling |
| Code structure | Many feature packages | Modular monolith: `packages/core` modules + `platform` adapters, thin apps, enforced boundaries | Consistent structure across AI-written code; no circular deps |
| Build method | Not specified | Claude Code kit: CLAUDE.md, path rules, backlog with acceptance checks, patterns, skills, subagents, hooks (§23) | Opus 5.5 builds task by task without drifting |
| Social posting | Missing (legacy had it) | FB/IG posting R1, AI reels R3 | No regression for legacy users |
| Client Mode | Missing | R1 | Resales Online parity |
| Preferred agencies | Missing | R1 + share scope | Resales Online parity |
| Listing overrides | Missing | R1 | Resales Online "edit descriptions" parity |
| Website XML / iFrame | API + widget only | + per-site XML + iFrame | Resales Online parity; web designers' choice |
| Data export | Dropped | CSV/Excel + full ZIP, every plan | Inmoconnect parity; trust |
| Bookmarks | Missing | R1 | Inmoconnect parity |
| Onboarding | Missing | R1 checklist + tours | Resales Online parity; faster activation |
| Referrals | Missing | R2 | Growth to 1,000 agencies |
| Rentals | Implicit | R2 rental fields + rental portals | Resales Online parity |
| Unique site content | — | R2, lazy + capped | SEO moat for agency websites |
| Speed-to-lead | — | R1 auto-ack + KPI, R3 AI | Conversion moat |
| Client portal | — | R2 | Buyer experience moat |
| Public portal | R2 relaunch | R1 MVP + R2 relaunch | Legacy stack can be switched off at cutover |
| Trial | None | 14-day Pro for new signups | Conversion |
| Outbound fetch | Not specified | SSRF-safe fetcher, XXE-safe parsing | Feeds and images come from user-supplied URLs |
| AI models | Named in plan | Env-configured tiers (FAST / SMART) | Models change; code shouldn't |
| Sprints | S0–S16 | S0–S17 (Portal MVP added) | Reflects new scope |

---

## APPENDIX B — GLOSSARY

| Term | Meaning |
|---|---|
| MLS | Multiple Listing Service — agencies sharing listings with each other |
| AMS | Agent Messaging System — network message board |
| Introducer | Agency that brings the buyer to another agency's listing |
| Presenting agency | Agency whose website, selection or document shows the listing to the client |
| Client registration | Introducer's timestamped claim on a client for a listing |
| Arras | Spanish private purchase contract with deposit, before completion at the notary |
| CEE | Certificado de Eficiencia Energética — energy rating certificate |
| CIF / NIF | Spanish company / tax identification numbers |
| IVA | Spanish VAT |
| APITS | A Place in the Sun (portal) |
| PITR | Point-in-time recovery |
| RLS | Postgres row-level security |
| RPO / RTO | Max data loss / max time to recover |
