# Build guide — running the Inmolink build with Claude Code (Opus 5.5)

For Shahzaib. Claude reads `CLAUDE.md` and the backlog; this file is how you drive it.

## 1. What is in the kit

| Path | What it does |
|---|---|
| `PLAN.md` | The product and architecture plan (what and why) |
| `CLAUDE.md` | Claude's operating manual — loaded every session |
| `.claude/rules/` | Detailed rules per area, loaded only when Claude touches those files |
| `.claude/skills/` | `/next-task`, `/new-module`, `/perf-check`, `/sprint-review` |
| `.claude/agents/` | Reviewer subagents: `code-reviewer`, `security-auditor`, `perf-auditor` |
| `.claude/settings.json` + `.claude/hooks/` | Auto-format after edits; inject current status at session start; safe permissions |
| `docs/build/BACKLOG-R1.md`, `BACKLOG-R2-R4.md` | Every task with acceptance checks |
| `docs/build/PATTERNS.md` | Reference code for every layer |
| `docs/build/STATUS.md` | Progress, blockers, decisions |
| `docs/build/HUMAN-ACTIONS.md` | What only you can do, and when it is needed |

## 2. One-time setup (Windows)

1. Install Node.js LTS, Git for Windows (Claude Code uses its Git Bash for shell commands), Docker Desktop (WSL 2 backend) and Claude Code. `setup-inmolink.ps1` checks all of these and prints the install command for anything missing.
2. Enable pnpm: `corepack enable`.
3. Put the kit zip and `setup-inmolink.ps1` in your repo folder (e.g. `E:\Repos\InmolinkCRM\`) and run the script: it extracts the kit, writes `.gitignore`, runs `git init` and makes the first commit.
4. Create a private GitHub repo and push.
5. Start the long-lead items in `HUMAN-ACTIONS.md` now — especially H3 (Meta verification), H6 (portal partners), H7 (lawyer), H1/H2 (legacy dump and API logs).

## 3. The daily loop

1. Open a terminal in `E:\Repos\InmolinkCRM`, run `claude`, select Opus 5.5 with `/model`.
2. Type `/next-task`. Claude reads STATUS, builds the task, runs the gates, reviews its own diff, updates STATUS and commits.
3. Read its three-line report. If it flags a decision or a blocker, answer it.
4. `/clear` and run `/next-task` again. One task per session keeps quality high and context small.

To work on a specific task: `/next-task S6-04`.

## 4. End of each sprint

1. `/sprint-review S3` (use the sprint number).
2. Read `docs/build/reviews/S3.md`. Follow the **demo script** on your machine or staging — this is where you catch "works but not what agents need".
3. Approve or redirect: write your answers under **Decisions** in STATUS (or just tell Claude in the next session).

## 5. When you need to step in

- **Decisions** in STATUS marked "proposed ADR" — Claude will not change a PLAN §3 decision without you.
- **BLOCKED-HUMAN** tasks — complete the H-item and tell Claude.
- **Exit criteria not met** at sprint review.
- **Critical/High security findings.**
- UI and wording — Claude builds functional, consistent UI; you (and pilot agents) judge whether it fits how agents work.

## 6. Keeping it fast and well-structured

These are already enforced by the kit; watch that they stay that way:
- Do not skip S0. The module scaffolder, boundary checks, RLS registry, isolation tests and outbox are what keep a large AI-written codebase consistent and fast.
- Every hot-path task ends with a `/perf-check` line in STATUS. If those lines stop appearing, ask why.
- If you see business logic in `apps/*` or a module reaching into another module's tables, ask Claude to run `code-reviewer` and fix it before moving on.
- Keep `CLAUDE.md` under ~200 lines. Put new detailed rules in `.claude/rules/` with a `paths:` scope.

## 7. Parallel work (optional, later)

Once the foundation is done, independent tasks can run in separate sessions using git worktrees (one session per worktree, one module per session). Good candidates: connectors (S6-03…S6-07) after S6-02, portal writers (S9-02) alongside CRM tasks. Merge through pull requests with CI green. Never run two sessions on the same module at the same time.

## 8. Safety

- `.env` files are blocked from Claude's reads by `settings.json`; give secrets through env, not chat.
- Never give local sessions production database credentials. Production changes go through CI/CD (Kamal) only.
- Legacy dumps and real client data stay outside the repo.
- `git push --force` and `git reset --hard` are denied by default; push normally after reviewing.

## 9. Changing the plan

Edit `PLAN.md` and the backlog (or ask Claude to propose the edit), add a line under **Decisions** in STATUS, and commit. Claude follows the files, not the chat history — so if it is not in the files, it will not survive the next `/clear`.
