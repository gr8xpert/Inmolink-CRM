// PostToolUse hook: format the file Claude just edited with Biome.
// Cross-platform (Windows/macOS/Linux). Never fails the tool call.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

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
  // Run Biome's JS entry with this Node binary: no shell, so a file name can never be
  // interpreted as a command (cmd.exe metacharacters such as & | ^ on Windows).
  const biome = join(root, 'node_modules', '@biomejs', 'biome', 'bin', 'biome');
  const target = file ? resolve(root, file) : '';
  const rel = target ? relative(root, target) : '';
  const insideRepo = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);

  if (insideRepo && FORMATTABLE.test(target) && existsSync(target) && existsSync(biome)) {
    spawnSync(process.execPath, [biome, 'check', '--write', '--no-errors-on-unmatched', '--', target], {
      cwd: root,
      stdio: 'ignore',
      shell: false,
      timeout: 20000,
    });
  }
} catch {
  // Formatting is best-effort; never block Claude.
}
process.exit(0);
