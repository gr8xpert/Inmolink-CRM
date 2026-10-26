import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  legacyRowsOf,
  parseAgencyArg,
  readInventory,
  readStaged,
  stagedAgencies,
} from '../../scripts/legacy-migration/staging';

/** Staging readers of the legacy loads (S4-04): what `legacy:developments` reads from the S14-01 extract. */

const dir = mkdtempSync(join(tmpdir(), 'inmolink-staging-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('legacy staging readers', () => {
  it('[S4-04] reads every staged row; a line that is not JSON is kept for the report, not dropped', async () => {
    mkdirSync(join(dir, 'agency-7'));
    writeFileSync(
      join(dir, 'agency-7', 'developments.ndjson'),
      '{"id":1,"name":"A"}\r\n\n{broken\n{"id":3,"name":"C"}\n',
    );
    expect(await readStaged(dir, '7', 'developments')).toEqual([{ id: 1, name: 'A' }, null, { id: 3, name: 'C' }]);
    expect(await readStaged(dir, '7', 'development_units')).toEqual([]); // not staged: no rows
    await expect(readStaged(dir, '../x', 'developments')).rejects.toThrow(/unsafe legacy agency id/);
    await expect(readStaged(dir, '7', '../secrets')).rejects.toThrow(/invalid entity name/);
  });

  it('[S4-04] agencies and legacy counts come from the inventory, else the agency directories', () => {
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
