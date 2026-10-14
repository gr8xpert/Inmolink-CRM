// pnpm test:int:root — tsx scripts/ci/run-projects.ts <group> [<group> …], a group = comma-separated vitest projects
//
// Runs each group as its own `vitest run --project … --reporter=dot`, one after another (groups share the
// test stack, so they must not overlap), and always runs every group: a failing group no longer skips the
// rest the way `a && b && c` did (S2-F3). Prints a summary and exits 1 if any group failed.
import { runGroups, summary, vitestGroup } from './root-projects';

const groups = process.argv.slice(2);
if (groups.length === 0) {
  console.error('usage: tsx scripts/ci/run-projects.ts <project[,project…]> …');
  process.exit(2);
}
const results = runGroups(groups, vitestGroup);
console.log(`\nroot test projects:\n${summary(results)}`);
process.exitCode = results.every((r) => r.ok) ? 0 : 1;
