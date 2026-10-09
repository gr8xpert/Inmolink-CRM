// PostToolUse hook: format the file Claude just edited with Biome.
// Cross-platform (Windows/macOS/Linux). Never fails the tool call.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const FORMATTABLE = /\.(ts|tsx|js|jsx|mjs|cjs|json|jsonc|css)$/i;

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

try {
  const input = JSON.parse(readStdin() || '{}');
  const file = input?.tool_input?.file_path;
  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const biome = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'biome.cmd' : 'biome');

  if (file && FORMATTABLE.test(file) && existsSync(file) && existsSync(biome)) {
    spawnSync(biome, ['check', '--write', '--no-errors-on-unmatched', file], {
      cwd: root,
      stdio: 'ignore',
      shell: process.platform === 'win32',
      timeout: 20000,
    });
  }
} catch {
  // Formatting is best-effort; never block Claude.
}
process.exit(0);
