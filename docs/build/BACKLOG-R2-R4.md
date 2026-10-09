# Backlog — R2 (Network), R3 (Outclass), R4 (Ecosystem)

Same format and rules as `BACKLOG-R1.md`. Start R2 only after the R1 pilot go/no-go (S17-02). Tasks are slightly coarser here: before starting a task, split it into sub-tasks in STATUS if it will not fit one session (`R2-03a`, `R2-03b`, …), each with its own acceptance checks.

---

## R2 — Network

### R2-01 · Embeddings pipeline
Ref §8 #4 §3 #47 · Mod ai-features, search · Dep S12-01 S5-01 · ⚡
**Build:** multilingual embeddings for listings (from read-model text + structured facts) and client profiles via `ai.embed`; `halfvec` columns with HNSW indexes; re-embed on material change (hash); backfill job via batch.
**Done when:**
- kNN query over 2M listing vectors p95 < 50 ms on staging
- Unchanged listings are never re-embedded

### R2-02 · Client profiles and matching engine
Ref §3 #23 §7 M9 · Mod matching · Dep R2-01 S10-01 S12-04 · ⚡
**Build:** client profiles (hard criteria, wishes text, embedding, mode OFF/REVIEW/AUTO_SEND, frequency); engine: SQL hard filters → vector score → learned boost from likes/dismissals → explanation strings; triggers on listing events + nightly sweep; REVIEW queue UI; AUTO_SEND creates a selection and sends it (email/WhatsApp link) in the client's language.
**Done when:**
- Matching storm: 10k listing changes vs 1M profiles processed in < 10 min (staging)
- Explanations list satisfied/unsatisfied criteria correctly (fixture tests)
- A client never receives the same listing twice

### R2-03 · Duplicate detection and clusters
Ref §3 #13 §10 · Mod dedupe · Dep S3-04 R2-01 · ⚡
**Build:** candidate generation by blocking (shared SHA-256 images, pHash LSH buckets, geo cell + type + beds), scoring (signals from §10), clustering with canonical choice rules, review queue (0.7–0.9), dispute flow; website/portal/selection serializers show canonical only; agents see "listed by N agencies" with each one's terms.
**Done when:**
- Precision ≥ 98% on the labelled fixture set at the auto-cluster threshold
- Client-facing outputs never show two members of one cluster

### R2-04 · Deal room
Ref §3 #10 §7 M10 · Mod mls · Dep S11-02 S11-03
**Build:** deals created from accepted viewings; stages OFFER → RESERVATION → ARRAS → COMPLETION (+ FELL_THROUGH); documents, tasks, chat thread; commission amounts computed from the snapshot; handshake at completion; dispute + staff mediation UI.
**Done when:**
- Commission split amounts match the snapshot to the cent (property tests)
- Completed deals are immutable except via audited staff mediation

### R2-05 · Forms library and e-signature
Ref §7 M13 · Mod documents · Dep S12-05 · [H17]
**Build:** document templates (listing agreement, reservation, viewing sheet, offer, collaboration agreement) per locale, branded; generation; simple electronic signature flow (email OTP, signature capture, audit trail PDF) behind a provider adapter; collaboration agreement signed from the deal room.
**Done when:** signed PDF includes audit trail (signers, timestamps, IP, document hash) and verifies against the stored hash

### R2-06 · Window cards
Ref §7 M13 · Mod presentations · Dep S12-05
**Build:** ≥ 10 templates at launch (A4/A3, portrait/landscape), QR code to the live listing page, PDF/HTML output, agency branding.
**Done when:** batch of 50 cards renders in one job; QR resolves to the branded selection/listing page

### R2-07 · Developer portal
Ref §7 M3 · Mod developments, web · Dep S4-03 S11-05
**Build:** developer-focused dashboard: bulk upload (CSV/Kyero/price-list file), availability toggles, access OPEN/PRIVATE_NETWORK, enquiries and reservations by agency, engagement stats (views, selections, enquiries), announcements to the network board.
**Done when:** *(E2E)* developer uploads a development, restricts it to 3 agencies, and only those agencies can find it

### R2-08 · Data ops console and AI price-list extraction
Ref §8 #5 §7 M3 · Mod developments, ai-features, admin · Dep R2-07 S12-01 · [H12]
**Build:** staff queue of incoming price lists (upload/email-in); AI extraction (SMART for complex PDFs/images, FAST for simple tables) into units; diff against current; human approve/edit; publish; freshness SLA tracking (24 h) and "last verified" badge.
**Done when:**
- Extraction eval set (≥ 30 real-world price lists) reaches ≥ 95% field accuracy before approval
- Nothing is published without human approval; every change is audited

### R2-09 · Photo intelligence
Ref §8 #2 #7 · Mod ai-features, media · Dep S12-01 S3-04
**Build:** room tagging, cover suggestion, auto-ordering, quality warnings (dark, blurry, small), alt text per locale, detection of logos/watermarks/phone numbers in photos (flag for white-label outputs).
**Done when:** eval sets pass; flagged photos are excluded from client-facing outputs when the agency opts in

### R2-10 · Reports
Ref §7 M18 · Mod reports · Dep S10-09 S11-06
**Build:** agency (listings, leads by source, conversion, response times, agent performance, collaboration revenue), listing (views/enquiries per channel), staff (tenant health, AI spend, search gaps); daily aggregates into partitioned stats tables; CSV export.
**Done when:** report queries read only aggregates (≤ 5 queries, p95 < 500 ms)

### R2-11 · PWA and push
Ref §3 #48 §7 M23 · Mod web · Dep S11-04
**Build:** installable PWA (manifest, service worker with safe caching), web push for notifications, camera upload flow for listings.
**Done when:** push notification arrives on Android Chrome and iOS Safari (installed PWA) *(manual)*

### R2-12 · Portal full SEO relaunch
Ref §7 M14 · Mod public · Dep S15-03 R2-03
**Build:** richer location landing pages (stats, FAQ JSON-LD, internal linking), similar listings, AI search box, programmatic area content, performance tuning.
**Done when:** Search Console reports no coverage errors for sitemaps; Lighthouse ≥ 95 on key templates

### R2-13 · Unique per-site AI content
Ref §3 #55 §9.6 · Mod websites, ai-features · Dep S7-02 S12-01 R2-03 · ⚡
**Build:** `site_listing_contents`; lazy generation triggers (first detail request, sitemap inclusion); priority queue by traffic; per-plan monthly caps; batch generation (FAST); STALE marking on material change; precedence in the serializer; staff cost dashboard.
**Done when:**
- Two sites presenting the same listing get different text with identical facts (validator)
- Cap reached → owner text used; no provider calls beyond cap
- Unchanged listings are never regenerated

### R2-14 · Client portal
Ref §3 #61 §7 M26 · Mod client-portal, public · Dep S12-04 S10-06
**Build:** magic-link access (hashed tokens, expiry, revoke), white-labelled portal in the client's language: selections with live data, likes/notes, viewing schedule, shared documents, contact the agent; events to CRM and matching.
**Done when:**
- A client sees only their own items; tokens are single-purpose and revocable
- Portal pages pass the white-label test and Lighthouse ≥ 90

### R2-15 · Agency referral programme
Ref §3 #62 §7 M27 · Mod referrals, billing · Dep S13-02
**Build:** referral codes/links, attribution at signup, reward when the referred agency pays its first invoice (Stripe customer-balance credit), referred discount, dashboard.
**Done when:** rewards are granted once per referred agency and reversed on refund within 30 days

### R2-16 · Rentals and rental portals
Ref §1 §7 M7 · Mod properties, exports · Dep S9-02
**Build:** long-term rental fields (monthly rent, deposit, availability date, furnished), rental search filters, rental portal exports where specs are available.
**Done when:** rental listings flow through website API, portal and exports with correct fields

---

## R3 — Outclass

### R3-01 · Conversational agent (website + WhatsApp)
Ref §8 #8 §3 #26 · Mod ai-features, crm · Dep R2-02 S12-08 · [H3]
**Build:** port the n8n chatbot to the core platform: tools (search inventory, get listing, check availability, book viewing in calendar, create lead + client profile, hand off to human); website chat widget and WhatsApp Cloud API channel; multilingual; transcripts on the CRM timeline; guardrails (no prices/commission invented, no legal advice), per-tenant config and budget.
**Done when:**
- Conversation eval set (≥ 100 scripted dialogues) passes: correct tool calls, no invented facts
- Human handoff works mid-conversation on both channels

### R3-02 · Speed-to-lead with AI
Ref §3 #60 · Mod crm, ai-features · Dep R3-01
**Build:** replace templated auto-ack with an AI reply (answers the question from listing data, proposes viewing slots, collects qualification) within 60 s; agency opt-in and tone settings.
**Done when:** p95 first reply < 60 s; agency can review/disable per channel

### R3-03 · AI search everywhere
Ref §8 #3 · Mod search · Dep S12-08 R2-01
**Build:** natural-language search with semantic rerank in dashboard network search, portal and widget.
**Done when:** eval accuracy ≥ 90%; p95 < 600 ms uncached

### R3-04 · CRM copilot and voice notes
Ref §8 #9 · Mod ai-features, crm · Dep S12-01 S10-04
**Build:** lead summary, next best action, follow-up drafts in the client's language, voice note → transcript → notes + tasks.
**Done when:** eval sets pass; drafts are never sent without user action

### R3-05 · Market insights and reports
Ref §8 #10 · Mod reports, ai-features · Dep R2-10 R2-03
**Build:** area stats (price/m², days on market, price drops) from canonical network data with minimum-sample rules; seller pitch and buyer report PDFs; valuation estimate beta (clearly labelled range, comparables shown).
**Done when:** stats suppressed when sample < threshold; reports render in < 15 s

### R3-06 · Lead scoring
Ref §8 #11 · Mod crm · Dep R2-10
**Build:** rules-based score from intent signals (engagement, budget fit, response), later model-based; shown in inbox sorting.
**Done when:** score recalculates on events; documented signal weights

### R3-07 · Email campaigns and auto-newsletters
Ref §7 M15 · Mod marketing · Dep S10-01 R2-02 · [H3]
**Build:** verified sending domains (DKIM/SPF/DMARC checks), templates, segments, campaigns via SES, suppressions, bounces/complaints, open/click tracking, auto-newsletters from matching data.
**Done when:** bounce/complaint handling suppresses addresses automatically; unsubscribe works one-click

### R3-08 · Hosted websites
Ref §9.5 §7 M6 · Mod websites, public · Dep R2-12 R2-13 · [H3]
**Build:** multi-tenant Next.js site themes on `apps/public` (custom domains via Cloudflare for SaaS), page sections editor, blog, SEO, unique content, leads; migration path for WP clients who want it.
**Done when:** a new agency site goes live on a custom domain with TLS in < 15 min; Lighthouse ≥ 95

### R3-09 · Featured listings
Ref §7 M15 · Mod marketing, public · Dep R2-12 S13-02
**Build:** paid placements on portal surfaces with clear labelling, scheduling, reporting.
**Done when:** placements respect plan counts and date windows

### R3-10 · AI video reels
Ref §3 #58 §7 M25 · Mod social, media · Dep S12-07 R2-09 · [H16]
**Build:** reel templates (9:16, 1:1), shot order from photo tags, captions per language, licensed music, ffmpeg rendering in a dedicated pool, auto-post to Instagram/Facebook.
**Done when:** a 30-second reel renders in < 2 min; CPU-heavy rendering never delays other pools

### R3-11 · Client portal assistant
Ref §8 #15 · Mod client-portal, ai-features · Dep R2-14 R3-01
**Build:** assistant inside the client portal answering questions about the client's selections from listing data; handoff to the agent.
**Done when:** eval set passes; no facts beyond listing data

### R3-12 · Edge watermarking
Ref §16 R3 · Mod media, infra · Dep S7-06
**Build:** on-the-fly watermarking at the CDN edge for client-facing image URLs (agency logo), no stored copies.
**Done when:** watermark applied per presenting agency without new R2 objects; cache hit rate unchanged ±5%

---

## R4 — Ecosystem

### R4-01 · Affiliate / partner programme
Ref §7 M24 · Mod referrals, websites · Dep R2-15 R2-14
**Build:** partner accounts (PARTNER role), branded portfolio pages, referral tracking to completion, payout records, partner plans.
**Done when:** referral attribution survives the full lead → deal → completion path

### R4-02 · Partner API and outbound webhooks
Ref §3 #45 · Mod platform, websites · Dep S7-03
**Build:** OAuth client credentials for partners, scoped API, webhooks (HMAC-signed, retries 1m/5m/30m/2h/12h, dead-letter, replay UI).
**Done when:** webhook delivery is at-least-once with signature verification examples in docs

### R4-03 · Native mobile app
Ref §3 #48 · Mod apps/mobile · Dep R2-11
**Build:** Expo app reusing contracts/SDK: listings, leads, chat, calendar, camera upload, push.
**Done when:** store builds pass review *(manual)*

### R4-04 · Enterprise SSO
Ref §16 R4 · Mod identity · Dep S1-04
**Build:** SAML/OIDC per agency, SCIM-lite user provisioning.
**Done when:** login via a test IdP; deprovisioned users lose access within 5 minutes

### R4-05 · Multi-country and franchise
Ref §16 R4 · Mod taxonomy, billing, compliance · Dep S2-01 S13-02
**Build:** country packs (taxonomy, legal fields, energy rules, currency, locales), country-level partner admin, Portugal first.
**Done when:** a Portuguese agency can onboard, list, share and export without code changes beyond the country pack

### R4-06 · Advanced analytics
Ref §16 R4 · Mod reports · Dep R2-10
**Build:** analytics store (ClickHouse or a Postgres analytics replica) fed from events; long-range dashboards.
**Done when:** dashboard queries over 2 years of events return in < 2 s
