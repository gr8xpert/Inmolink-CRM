---
name: sprint-review
description: Close an Inmolink sprint — confirm every task is done or human-blocked, run the full gates and reviewer subagents over the sprint diff, fix critical findings, write the sprint report and demo script, and move STATUS to the next sprint.
argument-hint: "<sprint e.g. S3>"
disable-model-invocation: true
---

# Sprint review — `$0`

1. **Completeness**: list every `$0-*` task from the backlog with its STATUS state. Anything not `DONE` or `BLOCKED-HUMAN` → finish it first or explain why it moves (needs Shahzaib's approval in the report).

2. **Full gates**: `pnpm verify`, `pnpm test:e2e`, `pnpm test:isolation`, `pnpm perf:smoke` (all scenarios touched this sprint). Record results.

3. **Reviews** on the sprint diff (`git diff sprint-<previous>-done..HEAD`):
   - `code-reviewer` subagent — structure, boundaries, patterns, tests.
   - `security-auditor` subagent — tenancy, auth, input handling, secrets, white-label leaks.
   - `perf-auditor` subagent — budgets, indexes, caching, bundles.
   Fix every **must fix** now; log **should fix** items as tasks in the backlog (next sprint, ID suffix `-F<n>`).

4. **Exit criteria**: check the sprint's exit criteria from PLAN §16; mark each pass/fail with evidence.

5. **Report** → `docs/build/reviews/$0.md`:
   - What shipped (by task), what is blocked and on which H-item
   - Gate and perf results, review findings and fixes
   - **Demo script for Shahzaib**: 5–10 click-by-click steps to see the sprint's features locally or on staging, with seed logins
   - Risks and decisions needing approval

6. **Close**: update STATUS (sprint closed, next sprint's first task under **Now**), tag `sprint-$0-done`, commit `docs: sprint $0 review`.
