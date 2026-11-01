import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadStackEnv } from '@inmolink/db/testing';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * S16-F11: every operation the code base runs over the limits connection (`rateLimitConnection()`, redis-queue's
 * `limits` user in production) is allowed by the production ACL (`redis_limits_acl`, infra/ansible group_vars).
 *
 * The operations are derived from the source, not listed by hand: each non-test file of `apps/*\/src` and
 * `packages/*\/src` that uses the limits connection is scanned for
 * - the commands it sends: method chains on `redis` (`redis.get(…)`, `redis.multi().set(…).exec()`), Lua
 *   `redis.call('X', …)` inside its scripts (ACL checks each script command), `defineCommand` scripts (EVALSHA / EVAL),
 *   the connection's CLIENT SETNAME and the health check's PING;
 * - the key prefixes it writes as literals (`'inl:cm'`, `` `inl:rl:mfa-proof:${…}` ``).
 * Each command is then checked with `ACL DRYRUN` as a user with the production ACL, on a key under each of the file's
 * prefixes. A new command or key prefix on the limits connection fails here until the ACL allows it.
 *
 * Convention the scan relies on (checked): the limits connection is held in a variable named `redis`.
 */

const ROOT = join(import.meta.dirname, '..', '..');

/** The ACL that production gives redis-queue's `limits` user (Ansible group_vars). */
function limitsAcl(): string {
  const vars = readFileSync(join(ROOT, 'infra', 'ansible', 'group_vars', 'all.yml'), 'utf8');
  const acl = vars.match(/^redis_limits_acl: "([^"]+)"$/m)?.[1];
  if (!acl) throw new Error('redis_limits_acl missing from infra/ansible/group_vars/all.yml');
  return acl;
}

/** The RateLimiter runs its scripts on the connection `index.ts` hands it. */
const LIMITER = 'packages/platform/src/rate-limit/limiter.ts';
/** ioredis connection lifecycle and promise methods, not ACL-checked commands (QUIT is answered before the ACL). */
const LIFECYCLE = new Set([
  'on',
  'once',
  'off',
  'quit',
  'disconnect',
  'connect',
  'duplicate',
  'definecommand',
  'bind',
  'then',
  'catch',
  'finally',
]);

/** `ACL DRYRUN` arguments per command (`k` = a key under the prefix). A new command needs a line here. */
const DRYRUN_ARGS: Record<string, (k: string) => string[] | null> = {
  ping: () => ['PING'],
  'client|setname': () => ['CLIENT', 'SETNAME', 'inmolink-limits'],
  multi: () => ['MULTI'],
  exec: () => ['EXEC'],
  get: (k) => ['GET', k],
  set: (k) => ['SET', k, '1'],
  del: (k) => ['DEL', k],
  incrby: (k) => ['INCRBY', k, '1'],
  pexpire: (k) => ['PEXPIRE', k, '1000'],
  pfadd: (k) => ['PFADD', k, 'a'],
  pfcount: (k) => ['PFCOUNT', k],
  eval: (k) => ['EVAL', 'return 1', '1', k],
  evalsha: (k) => ['EVALSHA', 'e0e1f9fabfc9d4800c877a703b823ac0578ff8db', '1', k],
};
const KEYLESS = new Set(['ping', 'client|setname', 'multi', 'exec']);

interface LimitsUse {
  file: string;
  commands: Set<string>;
  prefixes: Set<string>;
  /** Uses of the connection the scan cannot follow (not held as `redis`). */
  untracked: string[];
}

/** Skips a balanced `(…)` starting at `i` (at the `(`); returns the index after `)`. Strings are skipped whole. */
function skipParens(src: string, i: number): number {
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === "'" || c === '"' || c === '`') {
      const end = src.indexOf(c, j + 1);
      if (end < 0) return src.length;
      j = end;
    } else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return j + 1;
  }
  return src.length;
}

/** Commands sent through a `redis` value: method chains, Lua `redis.call`, defined scripts. */
function scanCommands(src: string, known: Set<string>): { commands: Set<string>; unknown: string[] } {
  const commands = new Set<string>();
  const unknown: string[] = [];
  for (const m of src.matchAll(/\bredis\b/g)) {
    let i = (m.index ?? 0) + m[0].length;
    for (;;) {
      const link = /^\s*\??\.\s*([A-Za-z_$][\w$]*)\s*(\()?/.exec(src.slice(i));
      if (!link) break;
      const name = (link[1] as string).toLowerCase();
      i += link[0].length;
      if (!link[2]) break; // a property (`redis.status`)
      const open = i - 1;
      if (name === 'call' || name === 'pcall') {
        const cmd = /^\(\s*['"]([A-Za-z|]+)['"]/.exec(src.slice(open))?.[1]?.toLowerCase();
        if (cmd) commands.add(cmd);
        else unknown.push('redis.call(<dynamic>)');
      } else if (LIFECYCLE.has(name)) {
        // not a command
      } else if (known.has(name)) {
        commands.add(name);
      } else {
        unknown.push(`redis.${link[1]}`);
      }
      i = skipParens(src, open);
    }
  }
  // ioredis scripts: EVALSHA, EVAL when the script is not cached yet.
  if (/\.defineCommand\(/.test(src)) for (const c of ['evalsha', 'eval']) commands.add(c);
  if (/\bconnectionName:/.test(src)) commands.add('client|setname');
  if (/\bredisCheck\(rateLimitConnection\)/.test(src)) commands.add('ping');
  return { commands, unknown };
}

/** Key prefixes written as literals: `'inl:cm'`, `` `inl:rl:mfa-proof:${…}` `` → `inl:cm`, `inl:rl:mfa-proof`. */
function scanPrefixes(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(/['"`](inl:[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)*):?/g)) out.add(m[1] as string);
  return out;
}

/** Calls of the connection (or a local wrapper of it) whose result is not held as `redis`. */
function scanUntracked(src: string): string[] {
  const wrappers = ['rateLimitConnection'];
  for (const m of src.matchAll(/function\s+(\w+)\s*\(\)[^{]*\{([^}]*)\}/g)) {
    if (/\brateLimitConnection\(\)/.test(m[2] as string)) wrappers.push(m[1] as string);
  }
  const out: string[] = [];
  for (const name of wrappers) {
    for (const m of src.matchAll(new RegExp(`\\b${name}\\(\\)`, 'g'))) {
      const before = src.slice(Math.max(0, (m.index ?? 0) - 40), m.index);
      if (/function\s+$/.test(before)) continue; // its definition
      if (/(?:const|let)\s+redis\s*=\s*(?:await\s+)?$/.test(before)) continue;
      out.push(`${name}() not held as \`redis\``);
    }
  }
  return out;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.next', '__tests__', 'testing'].includes(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (
      /\.(ts|tsx|mts)$/.test(e.name) &&
      !/\.(test|int\.test|spec)\.tsx?$/.test(e.name) &&
      !e.name.endsWith('.d.ts')
    )
      out.push(p);
  }
  return out;
}

/** Every non-test source file that uses the limits connection, with what it sends. */
function limitsUses(known: Set<string>): { uses: LimitsUse[]; ownConnections: string[] } {
  const files = ['apps', 'packages'].flatMap((top) =>
    readdirSync(join(ROOT, top), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .flatMap((d) => {
        const src = join(ROOT, top, d.name, 'src');
        try {
          return sourceFiles(src);
        } catch {
          return [];
        }
      }),
  );
  const uses: LimitsUse[] = [];
  const ownConnections: string[] = [];
  for (const path of files) {
    const file = relative(ROOT, path).replaceAll('\\', '/');
    const src = readFileSync(path, 'utf8');
    // The limits URL reaches Redis only through `rateLimitConnection()` (platform/rate-limit).
    if (/REDIS_LIMITS_URL/.test(src) && /new Redis\(/.test(src) && file !== 'packages/platform/src/rate-limit/index.ts')
      ownConnections.push(file);
    if (!/\brateLimitConnection\b/.test(src) && file !== LIMITER) continue;
    const { commands, unknown } = scanCommands(src, known);
    uses.push({ file, commands, prefixes: scanPrefixes(src), untracked: [...scanUntracked(src), ...unknown] });
  }
  return { uses, ownConnections };
}

let admin: Redis;
let known: Set<string>;
const user = `limits-acl-${Date.now().toString(36)}`;

/** Commands of `use` the ACL user may not run, as `CMD key: reason`. */
async function denied(use: LimitsUse): Promise<string[]> {
  const out: string[] = [];
  const keys = [...use.prefixes].map((p) => `${p}:acl-probe`);
  for (const cmd of use.commands) {
    const args = DRYRUN_ARGS[cmd];
    if (!args) {
      out.push(`${cmd}: no DRYRUN_ARGS entry (a new command on the limits connection — check redis_limits_acl)`);
      continue;
    }
    for (const key of KEYLESS.has(cmd) ? ['-'] : keys) {
      const argv = args(key) as string[];
      const res = String(await admin.call('ACL', 'DRYRUN', user, ...argv).catch((e: Error) => e.message));
      if (res !== 'OK') out.push(`${argv.slice(0, 2).join(' ')}: ${res}`);
    }
  }
  return out;
}

beforeAll(async () => {
  loadStackEnv('test');
  admin = new Redis(process.env.REDIS_LIMITS_URL as string, { protocol: 2, maxRetriesPerRequest: 1 });
  known = new Set(((await admin.call('COMMAND', 'LIST')) as string[]).map((c) => c.toLowerCase()));
  await admin.call('ACL', 'SETUSER', user, 'on', `>pw-${user}`, ...limitsAcl().split(' '));
});

afterAll(async () => {
  await admin.call('ACL', 'DELUSER', user).catch(() => {});
  admin.disconnect();
});

describe('limits ACL coverage (S16-F11)', () => {
  it('[S16-F11] every limits-connection command and key prefix of the code base is allowed by the production ACL', async () => {
    const { uses, ownConnections } = limitsUses(known);
    expect(ownConnections).toEqual([]);
    // The scan sees the known users (guards against the scan going blind).
    const byFile = new Map(uses.map((u) => [u.file, u]));
    const cm = byFile.get('packages/core/src/modules/identity/client-mode.ts');
    expect([...(cm?.commands ?? [])].sort()).toEqual(['del', 'exec', 'get', 'multi', 'set']);
    expect([...(cm?.prefixes ?? [])]).toEqual(['inl:cm']);
    const limiter = byFile.get(LIMITER);
    expect([...(limiter?.commands ?? [])].sort()).toEqual(
      ['eval', 'evalsha', 'get', 'incrby', 'pexpire', 'pfadd', 'pfcount'].sort(),
    );
    expect([...(limiter?.prefixes ?? [])]).toEqual(['inl:rl']);
    const mfa = byFile.get('packages/core/src/modules/identity/two-factor.ts');
    expect(mfa?.prefixes.has('inl:rl:mfa-proof')).toBe(true);
    expect([...(mfa?.commands ?? [])]).toEqual(expect.arrayContaining(['eval', 'incrby', 'pexpire']));
    expect(byFile.get('packages/core/src/modules/social/service.ts')?.prefixes.has('inl:social:state')).toBe(true);
    expect(byFile.get('packages/platform/src/rate-limit/index.ts')?.commands.has('client|setname')).toBe(true);
    expect(byFile.get('apps/api/src/main.ts')?.commands.has('ping')).toBe(true);

    const problems: string[] = [];
    for (const use of uses) {
      for (const u of use.untracked) problems.push(`${use.file}: ${u}`);
      if (use.prefixes.size === 0 && [...use.commands].some((c) => !KEYLESS.has(c)))
        if (use.file !== 'packages/platform/src/rate-limit/index.ts')
          problems.push(`${use.file}: keyed command, no prefix`);
      for (const d of await denied(use)) problems.push(`${use.file}: ${d}`);
    }
    expect(problems).toEqual([]);
  });

  it('[S16-F11] a new limits-connection command or key prefix fails the check until the ACL allows it', async () => {
    const newCommand = scanCommands("await redis.hset('inl:cm:x', 'a', '1');", known);
    expect(newCommand.commands).toEqual(new Set(['hset']));
    expect(
      await denied({
        file: 'new-command.ts',
        commands: newCommand.commands,
        prefixes: new Set(['inl:cm']),
        untracked: [],
      }),
    ).toEqual([expect.stringMatching(/hset: no DRYRUN_ARGS entry/)]);
    // Allowed on its own prefix, refused under a new one.
    const src = "const redis = rateLimitConnection(); await redis.set('inl:jobs:' + id, '1', 'EX', 60, 'NX');";
    const use = { file: 'new-prefix.ts', ...scanCommands(src, known), prefixes: scanPrefixes(src), untracked: [] };
    expect(use.prefixes).toEqual(new Set(['inl:jobs']));
    expect(await denied(use)).toEqual([expect.stringMatching(/^SET inl:jobs:acl-probe: .*no permissions/i)]);
    // A known command in a Lua script on a counter key that the ACL keeps from counters (no SET on `inl:rl:*`).
    const lua = scanCommands("redis.call('SET', KEYS[1], ARGV[1])", known);
    expect(
      await denied({ file: 'lua.ts', commands: lua.commands, prefixes: new Set(['inl:rl']), untracked: [] }),
    ).toEqual([expect.stringMatching(/^SET inl:rl:acl-probe/)]);
    // The connection used without `redis`: the scan cannot follow it, so it is reported.
    expect(scanUntracked('const c = rateLimitConnection(); await c.get(k);')).toHaveLength(1);
    expect(scanUntracked('const redis = await rateLimitConnection();')).toEqual([]);
  });

  it('[S16-F11] the ACL keeps queue keys and admin commands out of reach and SET off the counters', async () => {
    const res = async (...argv: string[]) =>
      String(await admin.call('ACL', 'DRYRUN', user, ...argv).catch((e: Error) => e.message));
    expect(await res('SET', 'inl:cm:n:x', '1')).toBe('OK');
    expect(await res('SET', 'inl:social:state:x', '1')).toBe('OK');
    expect(await res('SET', 'inl:rl:x', '1')).not.toBe('OK');
    expect(await res('DEL', 'inl:rl:x')).not.toBe('OK');
    expect(await res('GET', 'inl:imports:meta')).not.toBe('OK');
    expect(await res('HSET', 'inl:cm:x', 'a', '1')).not.toBe('OK');
    expect(await res('KEYS', 'inl:cm:*')).not.toBe('OK');
    expect(await res('FLUSHALL')).not.toBe('OK');
    expect(await res('CONFIG', 'GET', 'maxmemory')).not.toBe('OK');
  });
});
