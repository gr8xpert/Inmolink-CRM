import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { exactMatchesSql, fuzzyMatchesSql, type KeyQuery } from '../repo';

/** S7-F10 review: a level of a batch is two array parameters, never one bind per (key, parent) pair. */
const queries = (n: number): KeyQuery[] =>
  Array.from({ length: n }, (_, i) => ({
    key: `barrio ${i}`,
    parentId: i % 3 === 0 ? null : `0195f0a5-0003-7000-8000-${i.toString(16).padStart(12, '0')}`,
  }));
const render = (q: ReturnType<typeof exactMatchesSql>) => new PgDialect().sqlToQuery(q);

describe('taxonomy match statements (S7-F10)', () => {
  it('[S7-F10] (key, parent) queries bind a constant number of parameters: 40,000 pairs as many as 10', () => {
    for (const build of [
      (q: KeyQuery[]) => exactMatchesSql('location', q, 'AREA'),
      (q: KeyQuery[]) => fuzzyMatchesSql('location', q, 'AREA'),
      (q: KeyQuery[]) =>
        exactMatchesSql(
          'feature',
          q.map((x) => ({ ...x, parentId: null })),
        ),
    ]) {
      const few = render(build(queries(10)));
      const many = render(build(queries(40_000)));
      expect(many.params.length).toBe(few.params.length);
      expect(many.params.length).toBeLessThan(20);
      expect(many.sql).toBe(few.sql);
      // The arrays themselves carry the pairs, nulls included.
      const keys = many.params.find((p) => Array.isArray(p) && p[0] === 'barrio 0') as string[];
      expect(keys).toHaveLength(40_000);
    }
    // Exact lookups stay on their btrees: `= any($keys)` beside the join.
    expect(render(exactMatchesSql('location', queries(3), 'AREA')).sql).toMatch(/"alias_key" = any\(\$\d+::text\[\]\)/);
  });
});
