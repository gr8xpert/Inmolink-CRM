# PLAN.md edits — fresh start, no legacy coexistence (DRAFT for owner approval)

> **Status:** proposed · 2026-11-02 · not applied. PLAN.md is unchanged until Shahzaib approves.
> Sources: owner decisions 2026-11-01 (no coexistence → S17-F4, a6e2bdea; ADR 0006 amendment), 2026-11-01 (`UNIT_SPLIT_BP` → S17-F5, cba07d1d), 2026-11-02 (no copy of the old database: start fresh).

**Summary**
1. The `/v1` legacy API shim, golden files, DNS cutover of the old API hostname and the hourly delta / parallel run are gone (S17-F4, ADR 0006 amended). Every PLAN passage that promises them is rewritten.
2. There is no legacy database copy: the pilot and launch agencies onboard fresh (Resales-Online / XML / CSV imports = today's Path B). The one-time import code, `legacy_id_maps`, `platform/legacy-dump`, manual `legacy:delta` and portal 301s are kept, dormant, for a dump that may arrive later.
3. "Migrate the 200" becomes "onboard the 200": targets, moats, rollout, KPIs and hiring rows are reworded; client websites move to API v2 / WP plugin v2 instead of a zero-touch DNS switch.
4. New-build commission split: per development, default 50/50 (`developments.commission_split_bp` = 5000), owner agency admins change it (S17-F5) — added to §3 #7 and M3.
5. Pilot (S17) = 15–20 Resales-Online clients picked by Claude from the owner's list (H11), staged on the existing VPS; Stripe / Meta / status page (H3) after launch. Items marked **OWNER TO DECIDE** need a call before applying.

Convention: **Now** = current PLAN text (quoted, shortened with …). **Proposed** = replacement. **Why** = one line. Line numbers are PLAN.md as of 6aaefecd.

---

## Header (l. 3)

- **Now:** `> **Version** 2.1 · 2026-10-10 · supersedes v2.0 and Plan v1 · **Status:** locked for build`
- **Proposed:** `> **Version** 2.2 · 2026-11-02 · supersedes v2.1 · **Status:** locked for build · v2.2 = fresh start, no legacy coexistence (Appendix A3)`
- **Why:** a §3 decision change must be visible, not silent (CLAUDE.md "Never"). **OWNER TO DECIDE:** bump to 2.2 + new Appendix A3, or keep 2.1 and add a dated amendment note only.

## §0 Executive summary — Starting position (l. 20–24)

- **Now:** `**Starting position — not greenfield.**` / `- 200 existing clients to migrate (legacy Inmolink users and agencies currently paying Resales Online ~€2,400/yr).` / `- **Odoo is retired.** Legacy data is extracted once (read-only scripts), then the legacy stack is switched off after cutover. …`
- **Proposed:**
  - `**Starting position — known market, fresh data.**`
  - `- 200 existing clients to bring over (legacy Inmolink users and agencies currently paying Resales Online ~€2,400/yr). They onboard fresh: own listings via their Resales Online / XML / CSV feeds, contacts via CSV (§14).`
  - `- **No coexistence with legacy Inmolink.** v2 never runs beside the old system and does not depend on it. There is no copy of the legacy database today; the one-time import toolkit is kept and runs only if a dump becomes available (§14, ADR 0006). **Odoo is retired.** Nothing in v2 depends on Odoo.`
- **Why:** 2026-11-01 no-coexistence decision (a6e2bdea, ADR 0006 amendment) + 2026-11-02 "start fresh".

## §0 Executive summary — Targets (l. 30)

- **Now:** `| R1 launch | 200 migrated | €160k |`
- **Proposed:** `| R1 launch | 200 onboarded | €160k |`
- **Why:** no data migration for launch (2026-11-02). **OWNER TO DECIDE:** is 200 still the R1 target without a legacy import, or should R1 launch = pilot + first waves (e.g. 50) with 200 as an R1+ milestone?

## §0 Executive summary — Why we win, moat 2 (l. 36)

- **Now:** `2. **Zero-pain migration** — the legacy API shim keeps every existing client website running on day one; we move agencies, they don't move themselves.`
- **Proposed:** `2. **Zero-pain onboarding** — we import the agency's own feed, connect its website to API v2 / WordPress plugin v2 and keep the old provider running until renewal; we move agencies, they don't move themselves.`
- **Why:** shim removed (S17-F4, a6e2bdea); moving in is now Path B for everyone.

## §0 Executive summary — Releases (l. 46)

- **Now:** `**R1 Switch-ready** (pilot + migrate the 200)`
- **Proposed:** `**R1 Switch-ready** (pilot + onboard the 200)`
- **Why:** as above.

## §1 Competitive matrix — Website feed row (l. 63)

- **Now:** `| Website feed (API / XML / iFrame) | ✅ | Kyero/CSV + WP | ✅ REST + WP | **R1** API v2 + legacy shim + WP v2 + XML + iFrame |`
- **Proposed:** `| … | **R1** API v2 + WP v2 + JS widget + XML + iFrame |`
- **Why:** no legacy shim (S17-F4).

## §2 Product principles — #8 (l. 106)

- **Now:** `8. **Migration is a product feature.** Moving in must be a one-day, done-for-you job.`
- **Proposed:** `8. **Onboarding is a product feature.** Moving in must be a one-day, done-for-you job: feed import, website connected, team invited.`
- **Why:** principle stands, but it is onboarding, not data migration (2026-11-02).

## §3 Decisions matrix

### #7 Commission (l. 122)
- **Now:** `… New-builds: set by developer per development or unit | Δ |`
- **Proposed:** `… New-builds: commission set by the developer per development or unit; the collaborating (selling) agency's share is per development (`commission_split_bp`, default 5000 = 50/50), changed only by the owner agency's admins | Δ **2.2** |`
- **Why:** S17-F5 (cba07d1d), owner decision 2026-11-01 replacing the fixed `UNIT_SPLIT_BP`.

### #20 Website delivery (l. 135)
- **Now:** `| 20 | Website delivery | Website API v2 + legacy API shim + WordPress plugin v2 + JS widget (SPW-AI) + per-site XML feed + iFrame embed. …`
- **Proposed:** `| 20 | Website delivery | Website API v2 + WordPress plugin v2 + JS widget (SPW-AI) + per-site XML feed + iFrame embed. Legacy client websites are reconnected to v2 at onboarding (no `/v1`). Hosted Next.js sites in R3 | Δ **2.2** |`
- **Why:** S17-F4 (a6e2bdea).

### #28 Billing (l. 143)
- **Now:** `… staff manual grants; legacy price-lock coupons | Δ |`
- **Proposed:** `… staff manual grants; founding-member price-lock coupons. Stripe goes live after launch (H3); the pilot runs on staff manual grants | Δ |`
- **Why:** "legacy" here meant founding members, not the old system; H3 (Stripe) after launch per 2026-11-02. **OWNER TO DECIDE:** confirm pilot billing = manual grants.

### #42 Feature flags (l. 157) — no change
- `… ships dark → pilot agencies → everyone` stays correct.

### #43 API versioning (l. 158)
- **Now:** `| 43 | API versioning | `/v1` (legacy shim, frozen) and `/v2`; 12-month deprecation notice | Δ |`
- **Proposed:** `| 43 | API versioning | `/v2` is the first public version (`/v1/*` answers 404); a future breaking version gets a 12-month deprecation notice | Δ **2.2** |`
- **Why:** S17-F4 — feed-api returns 404 for `/v1/*` (ADR 0006 amendment).

### #44 Observability (l. 159)
- **Now:** `… Sentry, public status page | Δ |`
- **Proposed:** `… Sentry, public status page (after launch, with H3) | Δ |`
- **Why:** H3 accounts (incl. status page) come after launch (2026-11-02). **OWNER TO DECIDE:** status page post-launch acceptable for the pilot?

### #63 Portal timing (l. 178)
- **Now:** `… (search, detail, location pages, leads, 301s) so the legacy stack can be switched off; full SEO relaunch in R2`
- **Proposed:** `… (search, detail, location pages, leads, 301s from legacy inmolink.es URLs) so the old portal can be retired; full SEO relaunch in R2`
- **Why:** 301s kept (ADR 0006 decision 7); "switched off" no longer depends on a cutover.

## §4.1 Load assumptions (l. 188) — no change
- `Legacy data point: 150 agents → 20k properties …` is a sizing input, still valid.

## §4.2 Service-level objectives (l. 211)

- **Now:** `| Website API (v1 shim + v2) | **99.95%** | p95 < 150 ms edge-cached · < 400 ms origin |`
- **Proposed:** `| Website API (v2) | **99.95%** | p95 < 150 ms edge-cached · < 400 ms origin |`
- **Why:** no `/v1` (S17-F4).

## §5.2 Deployables (l. 253)

- **Now:** `| `apps/feed-api` | Website API v1 shim + v2, XML portal feeds — **read-only, isolated** | …`
- **Proposed:** `| `apps/feed-api` | Website API v2, XML portal feeds — **read-only, isolated** | dedicated feed nodes + CDN |`
- **Why:** S17-F4.

## §5 Repository layout (l. 344, 363, 365)

- **Now:** `│   ├── feed-api/               Fastify website API v1 shim + v2, XML feeds — read-only, isolated` · `├── tests/  e2e (Playwright) · load (k6) · isolation · golden (legacy API)` · `├── scripts/  legacy-migration/ · seed/ · …`
- **Proposed:** `│   ├── feed-api/               Fastify website API v2, XML feeds — read-only, isolated` · `├── tests/  e2e (Playwright) · load (k6) · isolation` · `├── scripts/  legacy-migration/ (one-time import, dormant) · seed/ · …`
- **Why:** golden tests + recorder deleted in a6e2bdea; import scripts kept. **Check before applying:** the actual path of the kept import scripts (`scripts/legacy-migration/` vs the `migration` module + `platform/legacy-dump`).

## §6 Domain model — Legacy migration (l. 482–483)

- **Now:** `**Legacy migration**` / `- `LegacyIdMap` … · `LegacyUrlRedirect` … · `MigrationBatch` …`
- **Proposed:** `**Legacy import (kept, dormant — runs only if a legacy dump is supplied)**` + same model list.
- **Why:** tables and code kept (ADR 0006 decisions 4, 6, 7 stand); not run for the pilot (2026-11-02).

## §7 Module specifications

### M3 · New developments (l. 514)
- **Now:** `- Development → Phase → Unit with live status; versioned price lists with diffs; documents; payment terms; developer commission`
- **Proposed:** `- … payment terms; developer commission + per-development collaborator split (default 50/50, owner agency admins change it; snapshotted on each viewing request)`
- **Why:** S17-F5 (cba07d1d).

### M6 · Website delivery (l. 532)
- **Now:** `See §9. Website API v2, legacy shim, WordPress plugin v2, JS widget, …`
- **Proposed:** `See §9. Website API v2, WordPress plugin v2, JS widget, …`
- **Why:** S17-F4.

### M14 · Public portal (l. 578)
- **Now:** `- R1 MVP (2.1): … 301s from legacy URLs — enough to switch the legacy stack off`
- **Proposed:** `- R1 MVP (2.1): … 301s from legacy inmolink.es URLs — enough to retire the old portal`
- **Why:** 301s kept (S17-F4 keep-list); no cutover dependency.

### M19 · Billing & plans (l. 603)
- **Now:** `- Legacy price lock (founding members), …`
- **Proposed:** `- Founding-member price lock, …` (meaning unchanged).
- **Why:** avoid confusion with the removed legacy bridge. Cosmetic — **OWNER TO DECIDE** whether to touch it.

### M22 · Legacy migration (l. 612)
- **Now:** `### M22 · Legacy migration — R1` / `See §14.`
- **Proposed:** `### M22 · Onboarding & legacy import — R1` / `See §14. Onboarding = Path B for every agency. The legacy import toolkit is built and kept but not run for the pilot (no dump available).`
- **Why:** 2026-11-02 "start fresh".

### M25 · Social media (l. 624) — no change
- `restores the legacy feature agents already use` still true as a product claim. Note: Meta accounts (H3) come after launch, so FB/IG posting stays dark for the pilot.

## §9.1 Website API v2 (l. 683) — no change
- `GET /v2/changes?since=` "Delta feed for plugin caches" is the v2 plugin delta, unrelated to the legacy delta.

## §9.3 Legacy API shim (`/v1`) (l. 700–703)

- **Now:** `### 9.3 Legacy API shim (`/v1`)` / `- Before writing it: capture real legacy traffic … → **golden files**` / `- Shim maps legacy requests to v2 … 100% golden-file parity` / `- Cutover trick: point the legacy API hostname at feed-api … Rollback = DNS flip`
- **Proposed:**
  ```
  ### 9.3 Legacy client websites (no `/v1` shim — v2.2)
  - Withdrawn 2026-11-01 (ADR 0006 amendment): no `/v1` shim, no golden files, no DNS cutover of the legacy API hostname. feed-api answers `/v1/*` with 404.
  - Existing client websites move to v2 at onboarding: WordPress sites install plugin v2; custom sites switch to API v2 or the JS widget / iFrame. We do the switch for the agency (principle 8).
  - Old plugin URLs that matter for SEO are covered by `LegacyUrlRedirect` 301s where we host them.
  ```
- **Why:** S17-F4 (a6e2bdea). **OWNER TO DECIDE:** keep §9.3 as a short "withdrawn" stub (keeps numbering, recommended) or delete it and renumber §9.4–9.6.

## §9.4 WordPress plugin v2 (l. 706)

- **Now:** `- Gutenberg blocks + legacy shortcodes (backward compatible), …`
- **Proposed:** unchanged text, unless the owner says otherwise.
- **Why:** S17-F4 removed the plugin's legacy *settings* migration, not the shortcodes. **OWNER TO DECIDE:** keep legacy shortcode compatibility (helps sites switching plugins) or drop it.

## §11 Plans & pricing — Founding offer (l. 783)

- **Now:** `- **Founding offer:** migrated and pilot agencies lock €800/yr for 3 years; free during the parallel-run period; switch on their old provider's renewal date`
- **Proposed:** `- **Founding offer:** pilot and first-wave agencies lock €800/yr for 3 years; free until their old provider's renewal date (both inventories run on their site until then, Path B); billing starts when Stripe goes live after launch`
- **Why:** the parallel run now means Path B (old provider + v2), not legacy Inmolink + v2; H3 after launch. **OWNER TO DECIDE:** who counts as "founding" (pilot only, or all of the 200?).

## §14 Legacy migration (l. 815–837)

- **Now (heading + intro):** `## 14. LEGACY MIGRATION` / `Two migration paths, one toolkit.`
- **Proposed:** `## 14. ONBOARDING & LEGACY IMPORT` / `One onboarding path for every agency (fresh start, 2026-11-02). The legacy import toolkit is kept for later.`

- **Now (Path A, steps 1–10):** `**Path A — legacy Inmolink agencies**` / `1. **Inventory:** schema dump of the legacy database; catalogue of legacy API endpoints and real traffic …` / `2. **Contract capture:** … golden files (§9.3)` / `3. **ETL** …` / `5. **Delta sync:** hourly legacy → v2 during the parallel run` / `7. **Cutover:** legacy API hostname → feed-api shim …` / `9. **Rollback:** DNS flip back …` / `10. **Decommission:** …`
- **Proposed:**
  ```
  **Legacy import (kept, not run for the pilot)** — there is no copy of the legacy database today. If a dump arrives:
  1. **Restore** the dump outside the repo; read it only through `platform/legacy-dump` (read-only).
  2. **ETL:** one-time import per agency → v2 models (`LegacyIdMap` keeps every old ID and reference) → staging → validate → merge. Idempotent, re-runnable, per-agency batches.
  3. **Media:** re-ingest through the media pipeline (dedup kicks in automatically).
  4. **Validation report** per agency: counts, sample field diffs, URL checks — target < 0.5% unexplained differences.
  5. **Top-up:** a later dump can be loaded once by hand (`legacy:delta`); no hourly sync, no parallel run.
  6. **Portal:** inmolink.es legacy URLs 301 via `LegacyUrlRedirect` (kept regardless of the import).
  ```
- **Why:** ADR 0006 amendment — decisions 1, 2, 3, 5 withdrawn (inventory of API traffic, golden files, DNS cutover/rollback, hourly delta); 4, 6, 7 stand; S17-F4 keep-list (a6e2bdea). Decommission step dropped: there is nothing of ours to decommission. **OWNER TO DECIDE:** keep the "final archive export kept encrypted in R2" line if the old system's data must be archived anyway.

- **Now (Path B):** `**Path B — agencies coming from Resales Online or other CRMs**` / `1. Collect each agency's renewal date; schedule cutover just before it` / `2. Import their **own** listings via the Resales Online (own-only) or XML/CSV connector; …` / `3. Run both inventories …` / `4. Switch website feed, cancel old subscription at renewal — nobody pays twice`
- **Proposed:** `**Onboarding — every agency (legacy Inmolink, Resales Online or other CRMs)**` + steps 1–4 unchanged, with step 4 extended: `4. Switch the website to API v2 / plugin v2, cancel the old subscription at renewal — nobody pays twice. Legacy Inmolink sites switch the same way (no `/v1`).`
- **Why:** Path B is now the only path (2026-11-02).

- **Now (Rollout):** `**Rollout:** pilot 15–20 agencies in one dense area (e.g. Marbella–Estepona) → fix → waves of 30–50 agencies per week.`
- **Proposed:** `**Rollout:** pilot 15–20 Resales Online client agencies in one dense area (e.g. Marbella–Estepona), picked by Claude from the list the owner provides (H11), on staging first (existing VPS, IP-whitelisted at Resales Online) → fix → waves of 30–50 agencies per week.`
- **Why:** 2026-11-02 pilot + staging decisions. **OWNER TO DECIDE:** whether the staging VPS (77.68.115.185) is named in PLAN or only in HUMAN-ACTIONS/runbooks (recommend: not in PLAN — infra detail, and IPs change).

## §15 Testing — Per sprint (l. 846)

- **Now:** `- Golden-file contract tests for the v1 shim`
- **Proposed:** `- Contract tests for Website API v2 (OpenAPI response schemas)` — or delete the line.
- **Why:** golden tests deleted in a6e2bdea. **OWNER TO DECIDE:** replace or delete (v2 routes already declare response schemas, CLAUDE.md rule 8).

## §16 Release roadmap — R0 + R1 sprint table

### S2 / S4 exit criteria (l. 881, 883)
- **Now:** S2 `Legacy taxonomy imported by script` · S4 `Legacy new-build data imported`
- **Proposed:** no change — historical exit criteria of closed sprints (met against fixtures). Optionally append `(against fixtures; no dump — 2026-11-02)`.
- **Why:** sprints closed; rewriting history adds nothing. **OWNER TO DECIDE** on the optional note.

### S8 (l. 887)
- **Now:** `| S8 Legacy shim + WP plugin v2 | 3 | v1 shim with golden files, plugin v2 (…), JS widget | 100% golden-file parity |`
- **Proposed:** `| S8 WP plugin v2 (+ legacy shim, withdrawn) | 3 | plugin v2 (blocks, shortcodes, SEO, cache, stale fallback, forms, auto-update), JS widget. The v1 shim with golden files was built and removed in S17-F4 | Plugin v2 + widget pass E2E against API v2 |`
- **Why:** S17-F4 (a6e2bdea). **OWNER TO DECIDE:** wording of the replacement exit criterion (closed sprint — could also stay as-is with a "withdrawn 2026-11-01" note).

### S14 (l. 893)
- **Now:** `| S14 Migration tooling | 2 | ETL, batches, validation reports, media re-ingest, redirects, delta sync, cutover/rollback runbook | Dry run of all 200 agencies < 0.5% unexplained diffs |`
- **Proposed:** `| S14 Migration tooling | 2 | ETL, batches, validation reports, media re-ingest, redirects, manual delta load, onboarding runbook (hourly delta sync + DNS cutover/rollback withdrawn, S17-F4) | Fixture dry run < 0.5% unexplained diffs; the 200-agency dry run waits for a legacy dump (none today) |`
- **Why:** ADR 0006 amendment + 2026-11-02 no dump.

### S17 (l. 896)
- **Now:** `| S17 Pilot | 2–4 | 15–20 agencies cut over; fixes; go/no-go | Zero website outages; pilot agencies stay |`
- **Proposed:** `| S17 Pilot | 2–4 | 15–20 Resales Online client agencies (H11, Claude picks from the owner's list) onboarded fresh on staging then production: own-feed import, website on API v2 / plugin v2, team invited; fixes; go/no-go. Stripe, Meta and status page (H3) after launch | Zero website outages; pilot agencies stay |`
- **Why:** 2026-11-02 fresh start + H11/H3 decisions.

### After the table (l. 898)
- **Now:** `Then mass migration in waves (§14). Legacy stack is switched off 90 days after the last wave.`
- **Proposed:** `Then onboarding in waves (§14). The old Inmolink stack is not run beside v2; inmolink.es legacy URLs keep their 301s.`
- **Why:** no coexistence (2026-11-01). **OWNER TO DECIDE:** when the old system is actually switched off (outside v2's control — leave out of PLAN?).

### R1 scope rule (l. 909)
- **Now:** `Anything new goes to R2+ unless it blocks migration.`
- **Proposed:** `Anything new goes to R2+ unless it blocks onboarding.`
- **Why:** wording follows §14.

## §17 Operations & observability (l. 917, 919)

- **Now:** `- **Status page** (public) — agencies trust what they can see` · `- **Runbooks** …: failover, PITR restore, …, agency cutover, agency rollback`
- **Proposed:** `- **Status page** (public, after launch — H3) — agencies trust what they can see` · `- **Runbooks** …: failover, PITR restore, …, agency onboarding, agency offboarding / export`
- **Why:** H3 after launch; no DNS cutover/rollback (S17-F4). **Check before applying:** the runbook file names now in `docs/runbooks/`.

## §19 Team & hiring (l. 942, 945)

- **Now:** `| 2 | Onboarding & support (ES/EN) | Migration waves | 200 agencies in a few months is a people job |` · `| 5 | Sales / partnerships … | Post-migration | …`
- **Proposed:** `| 2 | … | Onboarding waves | 200 agencies in a few months is a people job |` · `| 5 | … | After the onboarding waves | …`
- **Why:** wording follows §14.

## §20 Risks (l. 955)

- **Now:** `| Legacy shim mismatch breaks client sites | Med | High | Golden-file tests, per-agency cutover, DNS rollback |`
- **Proposed:** `| Client website breaks when switched to API v2 / plugin v2 | Med | High | Done-for-you switch per agency, plugin stale fallback, old provider kept until renewal, staging rehearsal per pilot agency |`
- **Why:** the risk moves from the shim to the website switch (S17-F4).
- **Proposed new row:** `| No legacy data: agencies lose history (contacts, leads) on moving | Med | Med | CSV contact/lead import at onboarding; legacy import toolkit kept for a later dump |`
- **Why:** consequence of 2026-11-02 "start fresh". **OWNER TO DECIDE:** add or not.

## §21 KPIs (l. 976)

- **Now:** `| Migration | % of the 200 migrated, time per cutover, website incidents during cutover (target 0), 90-day retention |`
- **Proposed:** `| Onboarding | % of the 200 onboarded, time to onboard (feed live + website switched), website incidents during the switch (target 0), 90-day retention |`
- **Why:** follows §14.

## §22 How to start (l. 989)

- **Now:** `3. Start the human actions with long lead times now …: legacy database dump and API logs, Meta business verification …`
- **Proposed:** no change (historical bootstrap step), or append `(dump and API logs: not available — fresh start 2026-11-02)`.
- **Why:** step was executed at project start. **OWNER TO DECIDE.**

## Appendix A — What changed from Plan v1 (l. 1026–1027, 1072)

- **Now:** `| User base | Greenfield | 200 clients + legacy data | Migration is the launch |` · `| Website feeds | Not covered | API v2 + legacy shim + WP plugin v2 | Core reason agencies pay |` · `| Public portal | R2 relaunch | R1 MVP + R2 relaunch | Legacy stack can be switched off at cutover |`
- **Proposed:** leave Appendix A as the v1 → v2 record, and record the reversals in a new **Appendix A3** (below) instead.
- **Why:** appendices are change logs; editing old rows hides the history.

## New — Appendix A3 — What changed in v2.2 (fresh start)

```
## APPENDIX A3 — WHAT CHANGED IN v2.2 (2026-11-02)

| Area | v2.1 | v2.2 | Why |
|---|---|---|---|
| Legacy coexistence | `/v1` shim, golden files, DNS cutover, hourly delta, parallel run | None. `/v1/*` → 404; client sites move to API v2 / plugin v2 | Owner decision 2026-11-01; S17-F4 (a6e2bdea); ADR 0006 amended |
| Legacy data | One-time import of all 200 agencies | No dump exists; agencies onboard fresh via their own feeds + CSV; import toolkit kept dormant | Owner decision 2026-11-02 |
| New-build split | Fixed `UNIT_SPLIT_BP` in code | Per development, default 50/50, owner agency admins change it | Owner decision 2026-11-01; S17-F5 (cba07d1d) |
| Pilot | 15–20 agencies cut over | 15–20 Resales Online clients (H11) onboarded fresh, staging on the existing VPS first | Owner decision 2026-11-02 |
| Stripe / Meta / status page | Before launch | After launch (H3); pilot on manual grants | Owner decision 2026-11-02 |
```

---

**Not changed (checked):** §3 #9 terms snapshot, #42 flags; §4.1 sizing; §5 "canary to pilot agencies" (l. 272, 918); §9.1 `/v2/changes` delta feed; §9.2; M25 claim; Appendix A rows (see above); `Odoo` line kept inside the new §0 text.

**Other files that would follow an approval (not touched by this draft):** ADR 0006 already amended; a new ADR for "fresh start / no legacy import for launch" is suggested (CLAUDE.md: "Changing a PLAN §3 decision silently — write a proposed ADR"); `docs/build/STATUS.md` Decisions; `docs/build/HUMAN-ACTIONS.md` (H-item for the legacy dump → closed "not available"; H3 moved after launch).
