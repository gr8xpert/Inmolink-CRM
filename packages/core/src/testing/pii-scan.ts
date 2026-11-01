import { withSystem } from '@inmolink/db';
import { sql } from 'drizzle-orm';

/**
 * PII scans for erasure tests (S16-04): every place in schema `public` that can hold text — text / varchar / char /
 * citext columns, their arrays and json(b), on ordinary tables and partitioned parents (partitions through their
 * parent) — searched case-insensitively for distinctive tokens, one statement per table. With `agencyId`, only tables
 * with an `agency_id` column, and only that agency's rows (the agency erasure). Bytea is ciphertext and not scanned;
 * encrypted text columns (`*_enc`) are ciphertext too — tests decrypt the ones that hold client data themselves.
 * Answers `table.column` for each hit.
 */

const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('testing.piiScan', fn);
const ident = (s: string) => `"${s.replaceAll('"', '""')}"`;

async function textColumns(): Promise<Map<string, { columns: string[]; tenant: boolean }>> {
  const cols = await system(
    async (tx) =>
      (
        await tx.execute(sql`
        select c.relname as table_name, a.attname as column_name,
               exists (select 1 from pg_attribute x where x.attrelid = c.oid and x.attname = 'agency_id'
                         and not x.attisdropped) as tenant
          from pg_attribute a
          join pg_class c on c.oid = a.attrelid
          join pg_namespace n on n.oid = c.relnamespace
          join pg_type t on t.oid = a.atttypid
         where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
           and a.attnum > 0 and not a.attisdropped
           and (t.typname in ('text', 'varchar', 'bpchar', 'citext', 'json', 'jsonb', '_text', '_varchar', '_bpchar')
                or t.typcategory = 'S')
         order by 1, 2`)
      ).rows as { table_name: string; column_name: string; tenant: boolean }[],
  );
  const byTable = new Map<string, { columns: string[]; tenant: boolean }>();
  for (const c of cols) {
    const entry = byTable.get(c.table_name) ?? { columns: [], tenant: c.tenant };
    entry.columns.push(c.column_name);
    byTable.set(c.table_name, entry);
  }
  return byTable;
}

export async function scanForTokens(tokens: readonly string[], opts: { agencyId?: string } = {}): Promise<string[]> {
  if (opts.agencyId && !/^[0-9a-f-]{36}$/i.test(opts.agencyId)) throw new Error('scanForTokens: not an agency id');
  // literals (tokens are test-made; quotes doubled anyway): one plain statement per table
  const list = `array[${tokens.map((t) => `'%${t.toLowerCase().replaceAll("'", "''")}%'`).join(', ')}]::text[]`;
  const hits: string[] = [];
  for (const [table, { columns, tenant }] of await textColumns()) {
    if (opts.agencyId && !tenant) continue;
    const checks = columns.map((c) => `bool_or(lower(${ident(c)}::text) like any(${list})) as ${ident(c)}`);
    const where = opts.agencyId ? ` where agency_id = '${opts.agencyId}'::uuid` : '';
    const found = await system(async (tx) => {
      const res = await tx.execute(sql.raw(`select ${checks.join(', ')} from ${ident(table)}${where}`));
      return res.rows[0] as Record<string, boolean | null>;
    });
    for (const [column, hit] of Object.entries(found)) if (hit) hits.push(`${table}.${column}`);
  }
  return hits;
}

/** Every storage object's key and text body containing a token (memory store contents), for file scans. */
export function scanObjects(
  objects: ReadonlyMap<string, { body: Uint8Array }>,
  tokens: readonly string[],
  unzip?: (body: Uint8Array) => string[],
): string[] {
  const hits: string[] = [];
  const lower = tokens.map((t) => t.toLowerCase());
  for (const [key, { body }] of objects) {
    const texts = [Buffer.from(body).toString('utf8'), ...(unzip ? unzip(body) : [])].map((t) => t.toLowerCase());
    if (texts.some((t) => lower.some((tok) => t.includes(tok)))) hits.push(key);
  }
  return hits;
}
