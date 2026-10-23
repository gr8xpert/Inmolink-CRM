// Runs the WordPress plugin's PHPCS + PHPUnit suite in Docker (S8-03): a throwaway MariaDB and a PHP 8.3 runner with
// the plugin copied into the image (no bind mounts). The stack is removed afterwards, pass or fail.
//   pnpm wp:test             → lint + tests
//   pnpm wp:test -- phpunit  → any command in the runner (e.g. `composer test`, `vendor/bin/phpunit --filter Sync`)
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const COMPOSE = ['compose', '-f', join(import.meta.dirname, '../../apps/wp-plugin/docker-compose.test.yml')];

function docker(args: string[]): number {
  const result = spawnSync('docker', [...COMPOSE, ...args], { stdio: 'inherit' });
  return result.status ?? 1;
}

const command = process.argv.slice(2).filter((a) => a !== '--');
let status = docker(['build', 'php']);
if (status === 0) status = docker(['run', '--rm', 'php', ...command]);
docker(['down', '--volumes', '--remove-orphans']);
process.exit(status);
