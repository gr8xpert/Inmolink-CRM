import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

// Brings up the `test` compose profile (idempotent). It stays running between runs; `pnpm infra:down` stops it.
export default function setup(): void {
  execFileSync('docker', ['compose', '--profile', 'test', 'up', '-d', '--wait'], {
    cwd: join(import.meta.dirname, '..', '..'),
    stdio: 'inherit',
    timeout: 300_000,
  });
}
