// tsx scripts/ops/inventory.ts <staging|production> <group> — prints the ansible_host of each host in an
// Ansible inventory group, one per line (scripts/ops/deploy.sh, the restore-drill workflow). A host's
// variables may be declared under any group, as in Ansible itself (staging-1 is in app, db_primary, …).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

type HostVars = Record<string, unknown> | null;
interface Group {
  hosts?: Record<string, HostVars> | null;
  children?: Record<string, Group | null> | null;
}

const ROOT = join(import.meta.dirname, '..', '..');

export function loadInventory(env: string): Group {
  if (!/^(staging|production)$/.test(env)) throw new Error(`unknown environment ${env}`);
  const doc = parse(readFileSync(join(ROOT, 'infra', 'ansible', 'inventories', env, 'hosts.yml'), 'utf8')) as {
    all: Group;
  };
  return doc.all;
}

function walk(group: Group, visit: (name: string, g: Group) => void, name = 'all'): void {
  visit(name, group);
  for (const [child, g] of Object.entries(group.children ?? {})) walk(g ?? {}, visit, child);
}

/** Host names in `group` (including its children), merged host vars from every group that mentions them. */
export function groupHosts(inventory: Group, group: string): { name: string; vars: Record<string, unknown> }[] {
  const vars = new Map<string, Record<string, unknown>>();
  walk(inventory, (_, g) => {
    for (const [host, v] of Object.entries(g.hosts ?? {})) vars.set(host, { ...vars.get(host), ...(v ?? {}) });
  });
  const members = new Set<string>();
  walk(inventory, (name, g) => {
    if (name !== group) return;
    walk(g, (_, sub) => {
      for (const host of Object.keys(sub.hosts ?? {})) members.add(host);
    });
  });
  return [...members].map((name) => ({ name, vars: vars.get(name) ?? {} }));
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const [env, group] = process.argv.slice(2);
  if (!env || !group) {
    console.error('usage: inventory.ts <staging|production> <group>');
    process.exit(2);
  }
  const hosts = groupHosts(loadInventory(env), group);
  if (hosts.length === 0) {
    console.error(`no hosts in group ${group}`);
    process.exit(1);
  }
  for (const h of hosts) console.log(String(h.vars.ansible_host ?? h.name));
}
