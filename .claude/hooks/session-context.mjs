// SessionStart hook: print the current build status so Claude starts (and resumes
// after compaction) knowing the sprint, the task under "Now", blockers and recent commits.
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const statusPath = join(root, 'docs', 'build', 'STATUS.md');

function section(md, heading) {
  const start = md.indexOf(`## ${heading}`);
  if (start === -1) return '';
  const rest = md.slice(start);
  const next = rest.indexOf('\n## ', 3);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

const out = ['# Inmolink build context (auto-injected)'];

if (existsSync(statusPath)) {
  const md = readFileSync(statusPath, 'utf8');
  for (const h of ['Now', 'Current sprint', 'Blocked']) {
    const s = section(md, h);
    if (s) out.push(s.split('\n').slice(0, 25).join('\n'));
  }
} else {
  out.push('docs/build/STATUS.md not found — start with task S0-01 in docs/build/BACKLOG-R1.md.');
}

try {
  const log = execSync('git log --oneline -5', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();
  if (log) out.push(`## Recent commits\n${log}`);
} catch {
  // not a git repo yet
}

out.push('Protocol: CLAUDE.md → Session protocol. Use /next-task to continue.');
process.stdout.write(`${out.join('\n\n')}\n`);
