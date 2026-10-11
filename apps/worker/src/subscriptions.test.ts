import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeclaredEvent } from '@inmolink/platform/outbox';
import { describe, expect, it } from 'vitest';
import { MODULES } from './subscriptions';

const MODULES_DIR = join(import.meta.dirname, '..', '..', '..', 'packages', 'core', 'src', 'modules');
const camel = (kebab: string) => kebab.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
const moduleDirs = readdirSync(MODULES_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

describe('worker subscriptions', () => {
  it('[S0-06] the worker loads every core module, so each event type is known to the dispatcher', () => {
    expect(Object.keys(MODULES).sort()).toEqual(moduleDirs);
    for (const [name, mod] of Object.entries(MODULES)) {
      const events = Object.entries(mod).find(([k]) => k === `${camel(name)}Events`)?.[1] as
        | Record<string, { type: string; version: number }>
        | undefined;
      for (const def of Object.values(events ?? {}))
        expect(isDeclaredEvent(def.type, def.version), def.type).toBe(true);
    }
  });

  it('[S0-06] every module with a subscriptions.ts is registered at start-up', () => {
    const wiring = readFileSync(join(import.meta.dirname, 'subscriptions.ts'), 'utf8');
    const body = wiring.slice(wiring.indexOf('export function registerSubscriptions'));
    for (const name of moduleDirs) {
      const files = readdirSync(join(MODULES_DIR, name));
      if (files.includes('subscriptions.ts')) {
        expect(body, name).toMatch(new RegExp(String.raw`\b${camel(name)}\.register\w*Subscriptions\(\)`));
      }
    }
  });
});
