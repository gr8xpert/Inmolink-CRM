import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as billingWorker from '@inmolink/core/modules/billing/worker';
import * as exportsWorker from '@inmolink/core/modules/exports/worker';
import { isDeclaredEvent } from '@inmolink/platform/outbox';
import { describe, expect, it } from 'vitest';
import { POOL_JOBS } from './processors';
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
        // A module whose subscriptions enqueue worker-only jobs registers them through its worker entry (S9-03).
        expect(body, name).toMatch(new RegExp(String.raw`\b${camel(name)}(?:Worker)?\.register\w*Subscriptions\(\)`));
      }
    }
  });

  it('[S1-03] every job a module defines runs in a worker pool (an unlisted job is enqueued but never processed)', () => {
    const pooled = new Set(Object.values(POOL_JOBS).flatMap((jobs) => jobs.map((j) => j.name)));
    for (const [name, mod] of Object.entries(MODULES)) {
      const jobs = Object.entries(mod).find(([k]) => k === `${camel(name)}Jobs`)?.[1] as
        | Record<string, { name: string }>
        | undefined;
      for (const job of Object.values(jobs ?? {})) expect(pooled.has(job.name), job.name).toBe(true);
    }
    // Worker-only entries (S9-03): their jobs too.
    for (const job of Object.values(exportsWorker.exportsJobs)) expect(pooled.has(job.name), job.name).toBe(true);
    for (const job of Object.values(billingWorker.billingNoticeJobs)) expect(pooled.has(job.name), job.name).toBe(true);
  });
});
