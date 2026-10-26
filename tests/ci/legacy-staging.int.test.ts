import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  legacyRowsOf,
  parseAgencyArg,
  readInventory,
  stagedAgencies,
  stagedSource,
} from '../../scripts/legacy-migration/staging';

/** Staging readers of the legacy loads (S4-04, S14-02): what `legacy:load` reads from the S14-01 extract. */

const dir = mkdtempSync(join(tmpdir(), 'inmolink-staging-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('legacy staging readers', () => {
  it('[S14-02] streams a staged file in batches, line by line; a line that is not JSON is marked with its number', async () => {
    const own = mkdtempSync(join(tmpdir(), 'inmolink-stream-'));
    mkdirSync(join(own, 'agency-8'));
    const lines = Array.from({ length: 7 }, (_, i) => (i === 4 ? '{oops' : JSON.stringify({ id: i + 1 })));
    writeFileSync(join(own, 'agency-8', 'contacts.ndjson'), `${lines.join('\n')}\n`);
    const source = stagedSource(own, '8', 'contacts');
    const batches: unknown[][] = [];
    for await (const b of source?.batches(3) ?? []) batches.push([...b]);
    expect(batches).toEqual([
      [{ id: 1 }, { id: 2 }, { id: 3 }],
      [{ id: 4 }, { __unparsableLine: 5 }, { id: 6 }],
      [{ id: 7 }],
    ]);
    expect(stagedSource(own, '8', 'leads')).toBeUndefined(); // not staged
    rmSync(own, { recursive: true, force: true });
  });

  it('[S4-04] agencies and legacy counts come from the inventory, else the agency directories', () => {
    mkdirSync(join(dir, 'agency-7'));
    expect(readInventory(dir)).toBeNull();
    expect(stagedAgencies(dir, null)).toEqual(['7']);
    const inventory = {
      entities: ['developments'],
      agencies: [{ agencyId: '7', entities: { developments: { legacyRows: 3, extractedRows: 3, sha256: 'x' } } }],
      totals: { developments: 3 },
      uncoveredTables: [],
    };
    writeFileSync(join(dir, 'inventory.json'), JSON.stringify(inventory));
    const read = readInventory(dir);
    expect(stagedAgencies(dir, read)).toEqual(['7']);
    expect(legacyRowsOf(read, '7', 'developments')).toBe(3);
    expect(legacyRowsOf(read, '7', 'development_units')).toBeUndefined();
  });

  it('[S4-04] --agency names a legacy agency and, on its first run, the v2 agency it became', () => {
    expect(parseAgencyArg('12')).toEqual({ legacyAgencyId: '12' });
    expect(parseAgencyArg('12=0190A1B2-0000-7000-8000-000000000001')).toEqual({
      legacyAgencyId: '12',
      agencyId: '0190a1b2-0000-7000-8000-000000000001',
    });
    expect(() => parseAgencyArg('12=acme')).toThrow(/not an agency id/);
    expect(() => parseAgencyArg('a/b')).toThrow(/invalid legacy agency id/);
  });
});
