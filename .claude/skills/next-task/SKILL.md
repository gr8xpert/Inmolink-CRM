---
name: next-task
description: Build the next Inmolink backlog task on Sonnet. Loads only that task via scripts/task-brief.mjs, hands hard tasks (hot-path, security, foundation) to /next-task-hard, otherwise builds, verifies, records and commits. Use when asked to continue the build.
argument-hint: "[task-id]"
disable-model-invocation: true
model: sonnet
effort: medium
---

# Next task (routine tasks, Sonnet)

1. **Load the brief — nothing else.** Run `node scripts/task-brief.mjs $ARGUMENTS`.
   It prints the task (the one under **Now** in STATUS if no ID is given), its dependency states, the recommended model, and only the PLAN.md / PATTERNS.md excerpts the task cites.
   Do NOT open PLAN.md, BACKLOG-R1.md or BACKLOG-R2-R4.md. If you need another PATTERNS section, Grep its heading (`## §7 `) and read only that section.

2. **Route.** If the brief says `Recommended model: OPUS`, stop immediately and reply with exactly one line:
   `<ID> is a hard task. Run: /next-task-hard <ID>`
   Do nothing else in this turn.

3. **Readiness.** A dependency not `DONE` → work on that dependency instead (re-run step 1 with its ID). A missing `[Hn]` input → build against fixtures/mocks behind a flag and mark the task `BLOCKED-HUMAN Hn` at the end.

4. **Build.** Short plan (files per layer + one test name per acceptance check), then implement following the PATTERNS shapes. Read only the files of the module you are changing; don't re-read files you just wrote; don't explore unrelated modules.

5. **Verify.** `pnpm verify` (quiet output: failures only). Fix until green. If you need detail on one failing test, re-run only that test.

6. **Review.** Run the `code-reviewer` subagent only if this task created a new module. Otherwise check your diff against the Definition of Done in CLAUDE.md yourself.

7. **Record.** STATUS.md (task → `DONE` + one-line summary, next task under **Now**), one CHANGELOG line, commit `feat(<module>): <summary> [<ID>]`.

8. **Report** in three lines (built · verify result · next task), then end with: `Run /clear, then /next-task.`
