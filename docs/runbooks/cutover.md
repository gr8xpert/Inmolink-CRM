# Agency cutover, DNS switch and rollback (S14-06)

Moving agencies to v2 (PLAN §14, ADR 0006). Two kinds of switch:

- **The legacy API hostname** (Path A, once for all legacy sites): its DNS moves from legacy to feed-api, whose `/v1`
  shim answers every legacy client website unchanged (website-api.md › Legacy v1 shim). Rollback = DNS flip back.
- **One agency's cutover** (Path A and Path B): `pnpm legacy:cutover` runs the agency's checklist. Every step is
  recorded on the checklist (`migration_cutovers`), audited (`migration.cutover.*` in the agency's audit log, actor
  system), idempotent and resumable; `rollback` undoes the reversible steps in reverse order.

Target: one agency's cutover and its rollback each complete in **< 30 minutes** (the staging rehearsal, H11).
Every command takes `--test` / runs against the dev stack locally; on staging and production the env carries the
`DATABASE_URL_*` secrets and `LEGACY_DATABASE_URL` (read-only legacy access, H1).

## Before the parallel run (per agency)

1. **Path A:** `legacy:extract` → `legacy:load` → `legacy:validate` (S14-01…03); the hourly delta (S14-04) keeps v2
   current from then on. Legacy URL redirects (S14-05) are loaded.
2. **Founding offer** (PLAN §11): in the staff console grant the plan for the parallel run (free) and set the founding
   price lock (S13-02). Nothing in the checklist does this.
3. Plan the checklist (H11 gives the date / renewal date):

   ```sh
   # Path A (legacy Inmolink agency)
   pnpm legacy:cutover plan --agency <v2 uuid> --path A --legacy <legacy agency id> --scheduled 2027-03-01
   # Path B (Resales Online / another CRM): scheduled 7 days before the old provider renews unless --scheduled
   pnpm legacy:cutover plan --agency <v2 uuid> --path B --provider resales-online --renewal 2027-03-15 \
     --area <location uuid> --area <location uuid> --old-area-listings 4200
   ```

   Re-running `plan` updates dates and the parity numbers (not once cut over, not during a run).
4. **Renewal tracking:** every Monday `pnpm legacy:cutover due --days 30` lists the open checklists scheduled within
   30 days (earliest first). Book each agency's slot; Path B agencies must be cut over before their renewal date —
   nobody pays twice.

## Path B: parallel inventory

While planned, a Path B agency's website runs in **PARALLEL** inventory mode: the managed site keeps the old
provider's inventory next to the v2 one (their own listings imported by the Resales Online own-only / XML / CSV
connector; contacts and leads by CSV). `pnpm legacy:cutover parity --agency <uuid>` compares the v2 network listings
in the agency's area (any location level) with the old provider's count (`--old-area-listings`, from its feed or
back office): parity is ≥ 95 %. Update the old count with `plan` as it moves.

## DNS switch of the legacy API hostname (Path A, once)

Before: every legacy agency is loaded and its delta runs; website-api.md › Cutover checklist steps 1–2 are done
(legacy keys marked, Cloudflare rewrite `/api/*` → `/v1/*`, query strings out of every log); `/v1` load-tested.

1. `pnpm legacy:cutover dns-check` must print *ready*: every migrated legacy agency has a PASS validation report
   (it lists the ones without, exit code 1). Fix or re-validate those first.
2. Lower the hostname's DNS TTL to 60 s a day before (H5); note the current target (the legacy origin) in the
   change ticket — it is the rollback.
3. Flip the record to feed-api (Cloudflare, proxied). Watch for 15 minutes: Grafana → feed-api `/v1` rate, 4xx/5xx,
   p95; `pnpm legacy:traffic` sample of the legacy sites still answering. 401s mean a key not marked as legacy:
   `pnpm legacy:key-flag --agency <uuid> --prefix <prefix> --on --reason <code>`.
4. The legacy sites now read v2 data, kept current from legacy by the hourly delta until each agency is cut over.

**DNS rollback:** flip the record back to the noted legacy origin (≤ 60 s TTL: sites follow within minutes). The
v2 data stays as it is; nothing else to undo. Record the timeline and why.

## One agency's cutover (`run`)

```sh
pnpm legacy:cutover run --agency <v2 uuid> [--confirm FREEZE] [--confirm SWITCH_FEED]
pnpm legacy:cutover status --agency <v2 uuid>
```

The run executes the open steps in order and stops at the first one it cannot complete, logging `stoppedAt` and a
reason code (also `lastError` on the checklist; exit code 1). Fix the reason and run again — it resumes there. Two
runs of one agency never interleave (a 30-minute lease; a crashed run's lease expires).

| Path | Step | What it does | Stops with | Rollback |
|---|---|---|---|---|
| A | `FREEZE` | legacy read-only for the agency (legacy control, H1) — without it, do it in the legacy admin and pass `--confirm FREEZE` | `CONFIRM_FREEZE` | unfrozen |
| A | `FINAL_DELTA` | one last delta from the frozen legacy (needs `LEGACY_DATABASE_URL` or `--url`) | `NO_LEGACY_SOURCE`, `DELTA_INCOMPLETE` (failed batch: see the delta log), `DELTA_WITHDRAW_GUARD`, `DELTA_STOPPED` (`legacy:delta --reopen` first) | re-done next time |
| A | `VALIDATE` | gate: the latest report is PASS and newer than the final delta — run `pnpm legacy:validate --staging <fresh extract> --agency <legacy id>` after the final delta | `NO_VALIDATION_REPORT`, `VALIDATION_FAILED`, `VALIDATION_STALE` | re-done next time |
| A | `STOP_DELTA` | the hourly delta stops for the agency (agents now work in v2) | — | delta re-opened |
| A | `ENABLE_ACCESS` | password-reset e-mail to every migrated member (their way into the dashboard), batched; a resumed run mails nobody twice | — | kept (mails sent) |
| A, B | `NOTIFY` | `MIGRATION_CUT_OVER` notification to the agency's admins | — | re-done next time |
| B | `PARITY` | gate: v2 network in the area ≥ 95 % of the old provider's — or accept it with `--confirm PARITY` | `PARITY_NOT_CONFIGURED`, `PARITY_NOT_REACHED` | re-done next time |
| B | `SWITCH_FEED` | switch the managed site to the v2 inventory only, then `--confirm SWITCH_FEED` (inventory mode V2) | `CONFIRM_SWITCH_FEED` | back to PARALLEL |

When it completes the checklist is **CUT_OVER** (`migration.cutover.completed` with the elapsed time). Then:

- Call the agency: their team has the sign-in e-mails; the dashboard is theirs.
- Path A: legacy stays read-only for them; the legacy API traffic of their site is already on the shim (DNS above).
  As their site moves to the plugin or header keys, rotate the key and clear its legacy flag.
- Path B: cancel the old provider's subscription at its renewal date.
- Record the rehearsal / cutover time in STATUS (staging rehearsal: H11).

## One agency's rollback (`rollback`, within 7 days)

```sh
pnpm legacy:cutover rollback --agency <v2 uuid> [--confirm FREEZE] [--confirm SWITCH_FEED] [--force]
```

Undoes the reversible steps in reverse order: the delta re-opens (legacy is the source again), legacy is unfrozen
(automatically with the legacy control; by hand otherwise, then `--confirm FREEZE`), the Path B site goes back to both
inventories (switch it, then `--confirm SWITCH_FEED`). The gates, the final delta and the notification re-open for the
next cutover; the members' password-reset e-mails stay sent (they may keep signing in to v2 — tell the agency to work
in legacy until the next cutover). A stopped rollback resumes like a run. After 7 days `--force` is required: what the
agents did in v2 since stays in v2 (legacy never gets v2 edits) — agree on it with the agency first.

Then: tell the agency, fix what caused the rollback, re-plan (`plan`), and run again — the final delta and the
validation gate run again.

## Rehearsal on staging (H11, before the pilot wave)

1. Restore a recent legacy dump into the staging legacy database; extract, load, validate one test agency.
2. Time `run` (all steps) and `rollback` with a stopwatch; both < 30 minutes. Repeat the `run` after the rollback.
3. Rehearse the DNS flip and flip-back with a staging hostname.
4. Write the times and anything that stopped a run into STATUS.
