import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { PLATFORM_AGENCY_ID } from '@inmolink/platform/tenancy';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
/** The one definition. Everything else — outbox, RLS generator, registry predicates, services — imports it. */
const DEFINITION = 'packages/platform/src/tenancy/index.ts';
const SOURCE = /\.(ts|tsx)$/;
const TEST = /(\.(test|spec|int\.test)\.tsx?$|[\\/]__tests__[\\/])/;

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.next') continue;
      yield* sourceFiles(path);
    } else if (SOURCE.test(entry.name) && !TEST.test(path)) {
      yield path;
    }
  }
}

describe('platform agency id', () => {
  it('[S1-F2] is defined once, in platform/outbox, and RLS and the registry use that definition', () => {
    expect(PLATFORM_AGENCY_ID).toBe(NIL_UUID);
    const literal: string[] = [];
    for (const group of ['packages', 'apps', 'scripts']) {
      for (const file of sourceFiles(join(ROOT, group))) {
        if (readFileSync(file, 'utf8').includes(NIL_UUID)) literal.push(relative(ROOT, file).replaceAll('\\', '/'));
      }
    }
    // A second literal could drift from the first: `emit()` would write one id and RLS check another.
    expect(literal).toEqual([DEFINITION]);
    for (const file of ['packages/db/src/tenancy/rls.ts', 'packages/db/src/tenancy/registry.ts']) {
      const source = readFileSync(join(ROOT, file), 'utf8');
      expect(source).toMatch(/PLATFORM_AGENCY_ID[^;]*from '@inmolink\/platform\/(tenancy|outbox)'/);
      expect(source).toMatch(/\$\{PLATFORM_AGENCY_ID\}/);
    }
  });
});
