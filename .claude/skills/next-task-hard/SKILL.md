---
name: next-task-hard
description: Build a hard Inmolink backlog task (hot-path ⚡, security 🔒 or S0 foundation) on Opus. Loads only that task via scripts/task-brief.mjs, builds, verifies including perf and security checks, records and commits. Use when /next-task says a task is hard.
argument-hint: "<task-id>"
disable-model-invocation: true
model: opus
effort: high
---

# Hard task (Opus)

1. **Load the brief — nothing else.** Run `node scripts/task-brief.mjs $ARGUMENTS`.
   Do NOT open PLAN.md, BACKLOG-R1.md or BACKLOG-R2-R4.md. If you need another PATTERNS or PLAN section, Grep its heading and read only that section.

2. **Readiness.** A dependency not `DONE` → stop and say which one (it may be routine: `/next-task <dep>`). A missing `[Hn]` input → build against fixtures/mocks behind a flag and mark the task `BLOCKED-HUMAN Hn` at the end.

3. **Build.** Short plan (files per layer + one test name per acceptance check), then implement following the PATTERNS shapes. Read only the files of the module you are changing; don't re-read files you just wrote.

4. **Verify.**
   - `pnpm db:generate && pnpm db:migrate && pnpm db:rls` if the schema changed.
   - `pnpm verify` (quiet output: failures only). Fix until green; re-run only a failing test when you need detail.
   - ⚡ task → run `/perf-check` and fix any budget breach.

5. **Review.** Run the `code-reviewer` subagent on the diff. 🔒 task → also run `security-auditor`. Fix every "must fix" / Critical / High.

6. **Record.** STATUS.md (task → `DONE` + one-line summary, perf numbers for ⚡ tasks, next task under **Now**), one CHANGELOG line, commit `feat(<module>): <summary> [<ID>]`.

7. **Report** in three lines (built · verify/perf/security result · next task), then end with: `Run /clear, then /next-task.`
