# Agency cutover and rollback (S14-06)

Moving agencies to v2 (PLAN §14, ADR 0006). **S17-F4 (decision 2026-11-01):** the old Inmolink system never runs beside
v2 — there is no legacy `/v1` API shim, no legacy hostname DNS switch, no hourly legacy delta and no parallel run for
Path A. A legacy agency's data arrives once, by the one-time import of a restored dump (`legacy:extract` →
`legacy:load` → `legacy:validate`); its client websites move to the v2 API (v2 keys, the v2 WordPress plugin or the
managed site). The inmolink.es legacy URLs keep their 301s (S14-05).

- **One agency's cutover** (Path A and Path B): `pnpm legacy:cutover` runs the agency's checklist. Every step is
  recorded on the checklist (`migration_cutovers`), audited (`migration.cutover.*` in the agency's audit log, actor
  system), idempotent and resumable; `rollback` undoes the reversible steps in reverse order.

Target: one agency's cutover and its rollback each complete in **< 30 minutes** (the staging rehearsal, H11).
Every command takes `--test` / runs against the dev stack locally; on staging and production the env carries the
`DATABASE_URL_*` secrets. The restored copy of the legacy dump (H1) is named per run with `--url` (or
`LEGACY_DUMP_URL` in the operator's shell) — a dedicated SELECT-only login; no app or worker ever reads it.

**Target guard (S14 review)** — `legacy:load`, `legacy:cutover`, `legacy:delta` and `legacy:validate` print the database host they will write to and refuse to run unless it is named:
`--target <database host>` (e.g. `--target localhost` on the dev stack, the staging / production database host there)
must match the host of every `DATABASE_URL_*`. `--test` is refused when any `DATABASE_URL_*` is set or `NODE_ENV` is
production.

## Before the cutover (per agency)

1. **Path A:** `legacy:extract` → `legacy:load` → `legacy:validate` (S14-01…03) from a restored dump. Should the
   agency keep working in legacy between that dump and its cutover day, the cutover's `FINAL_DELTA` loads what changed
   from the freeze-day dump (`pnpm legacy:delta --url <dump>` does the same by hand). Legacy URL redirects (S14-05)
   are loaded.
2. **Founding offer** (PLAN §11): in the staff console grant the plan for the switch-over period (free) and set the
   founding price lock (S13-02). Nothing in the checklist does this.
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
| A | `FINAL_DELTA` | one last delta from the freeze-day restored dump (`--url` or `LEGACY_DUMP_URL`; none: `NO_LEGACY_SOURCE`) | `NO_LEGACY_SOURCE`, `DELTA_INCOMPLETE` (failed batch: see the delta log), `DELTA_WITHDRAW_GUARD`, `DELTA_STOPPED` (`legacy:delta --reopen` first) | re-done next time |
| A | `VALIDATE` | gate: the latest report is PASS and newer than the final delta — run `pnpm legacy:validate --staging <fresh extract> --agency <legacy id>` after the final delta | `NO_VALIDATION_REPORT`, `VALIDATION_FAILED`, `VALIDATION_STALE` | re-done next time |
| A | `STOP_DELTA` | no later delta loads into the agency (agents now work in v2) | — | delta re-opened |
| A | `ENABLE_ACCESS` | password-reset e-mail to every member the load created (their way into the dashboard) — once per v2 user, never an existing member matched by e-mail; the only place it is sent (`legacy:load` mails nobody); batched, a resumed run mails nobody twice | — | kept (mails sent) |
| A, B | `NOTIFY` | `MIGRATION_CUT_OVER` notification to the agency's admins | — | re-done next time |
| B | `PARITY` | gate: v2 network in the area ≥ 95 % of the old provider's — or accept it with `--confirm PARITY` | `PARITY_NOT_CONFIGURED`, `PARITY_NOT_REACHED` | re-done next time |
| B | `SWITCH_FEED` | switch the managed site to the v2 inventory only, then `--confirm SWITCH_FEED` (inventory mode V2) | `CONFIRM_SWITCH_FEED` | back to PARALLEL |

When it completes the checklist is **CUT_OVER** (`migration.cutover.completed` with the elapsed time). Then:

- Call the agency: their team has the sign-in e-mails; the dashboard is theirs.
- Path A: legacy stays read-only for them (it is retired); their websites read the v2 API with v2 keys.
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

## Deploying S17-F4 (once, every environment)

- **Migration `0181_s17_f4_drop_legacy_query_key`** revokes every API key that was flagged for the legacy `?api_key=`
  query parameter (such a key has lived in URLs: CDN, proxy and site logs) and then drops the flag. Before deploying,
  list them (`select id, agency_id, prefix from api_keys where legacy_query_key and revoked_at is null`) and tell those
  agencies to create a new key; after it, they are revoked (cached lookups expire within seconds). Then
  `pnpm db:migrate && pnpm db:rls`.
- **Worker:** the maintenance pool removes the stale BullMQ scheduler of the retired hourly delta
  (`RETIRED_SCHEDULERS` in `apps/worker/src/processors/index.ts`) at start; its log says
  `retired job scheduler removed` once. Nothing to do by hand.
- Delete the retired env vars from servers and secrets (the legacy database URL and its two limits, the `/v1`
  network-owner flag). The legacy API hostname is retired with the old system; do not point it at feed-api.

## Rehearsal on staging (H11, before the pilot wave)

1. Restore a recent legacy dump into a staging copy (SELECT-only login); extract, load, validate one test agency.
2. Time `run` (all steps) and `rollback` with a stopwatch; both < 30 minutes. Repeat the `run` after the rollback.
3. Write the times and anything that stopped a run into STATUS.
