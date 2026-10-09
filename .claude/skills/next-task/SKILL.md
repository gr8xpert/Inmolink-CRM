---
name: next-task
description: Build the next Inmolink backlog task end to end — pick it from docs/build/STATUS.md, implement it to the Definition of Done, verify, update status and commit. Use when asked to continue the build or work on the next (or a named) task.
argument-hint: "[task-id]"
disable-model-invocation: true
---

# Build the next task

Target task: `$ARGUMENTS` if given, otherwise the task under **Now** in `docs/build/STATUS.md`, otherwise the first `TODO` task (in sprint order) whose dependencies are all `DONE`.

1. **Load only what you need**
   - The task block in `docs/build/BACKLOG-R1.md` or `docs/build/BACKLOG-R2-R4.md`.
   - The PLAN.md sections listed in its `Ref:` line.
   - The `docs/build/PATTERNS.md` sections for the layers you will touch.
   - Existing code of the module you are changing (start from its `index.ts`).

2. **Check readiness**
   - All `Depends:` tasks are `DONE`. If not, switch to the dependency.
   - If it needs a human input marked `[Hn]` that is missing, build against fixtures/mocks behind a feature flag, then mark it `BLOCKED-HUMAN Hn` with what is left.

3. **Plan (short, in the conversation)**
   - Files to add/change per layer (schema → repo → service → events/jobs → contracts → routes → UI → tests).
   - One test name per acceptance check: `[<task-id>] <check>`.

4. **Implement** following PATTERNS. New module → run `/new-module <name>` first.

5. **Verify**
   - `pnpm db:generate && pnpm db:migrate && pnpm db:rls` if the schema changed.
   - `pnpm verify` until green.
   - If the task touches a hot path (feed-api, search, imports, matching, media, read models, list endpoints): run `/perf-check` and fix any budget breach.
   - Module-sized task: run the `code-reviewer` subagent on the diff; sensitive areas (auth, RLS, keys, imports, uploads, payments, webhooks) also `security-auditor`. Fix every "must fix".

6. **Record**
   - `docs/build/STATUS.md`: mark the task `DONE` with a one-line summary (and perf numbers for hot paths), add any assumptions under **Decisions**, put the next task under **Now**.
   - `CHANGELOG.md`: one line under Unreleased.
   - Commit: `feat(<module>): <summary> [<task-id>]` (use `fix`, `chore`, `docs`, `perf`, `test` as appropriate).

7. **Report** in three lines: what was built, verification result, next task. If context is long, suggest `/clear` before continuing.
