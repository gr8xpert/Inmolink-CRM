// pnpm legacy:extract --out <dir outside the repo> [--url <postgres url> | LEGACY_DATABASE_URL] [--agency <id>]...
//   [--map <entities.json>] [--batch 1000]
//
// Read-only extract of the restored legacy dump into NDJSON staging files per agency + inventory.json (S14-01).
// Never writes to the legacy database; the connection is read-only at session and transaction level.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { DEFAULT_ENTITIES, type EntitySpec, runExtract } from './extract-lib';

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    out: { type: 'string' },
    agency: { type: 'string', multiple: true },
    map: { type: 'string' },
    batch: { type: 'string' },
  },
});

try {
  const url = values.url ?? process.env.LEGACY_DATABASE_URL;
  if (!url) throw new TypeError('--url or LEGACY_DATABASE_URL is required (a restored COPY of the legacy dump)');
  if (!values.out) throw new TypeError('--out <dir> is required (outside the repository)');
  const entities: EntitySpec[] = values.map ? JSON.parse(readFileSync(values.map, 'utf8')) : DEFAULT_ENTITIES;
  const inv = await runExtract({
    url,
    outDir: values.out,
    entities,
    agencyIds: values.agency,
    batchSize: values.batch ? Number(values.batch) : undefined,
  });
  console.log(
    JSON.stringify(
      { agencies: inv.agencies.length, totals: inv.totals, uncoveredTables: inv.uncoveredTables },
      null,
      2,
    ),
  );
} catch (err) {
  console.error('legacy extract failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
