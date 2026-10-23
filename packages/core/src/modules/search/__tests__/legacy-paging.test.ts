import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { fallbackCondition } from '../repo';
import { SEARCH_RESULT_CAP, searchOffsetCursor } from '../website';

/** S8-02: what the v1 shim asks of search — offset cursors for legacy page numbers, and a target by its id. */

const decode = (c: string) => JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as unknown;

describe('[S8-02] legacy paging and detail by id', () => {
  it('[S8-02] a legacy page offset becomes an engine cursor; the first page has none, past the cap there is no page', () => {
    expect(searchOffsetCursor('newest', 0)).toBeUndefined();
    expect(decode(searchOffsetCursor('price_asc', 40) as string)).toEqual({ s: 'price_asc', o: 40 });
    expect(searchOffsetCursor('newest', SEARCH_RESULT_CAP - 1)).toEqual(expect.any(String));
    expect(searchOffsetCursor('newest', SEARCH_RESULT_CAP)).toBeNull();
    expect(() => searchOffsetCursor('newest', -1)).toThrow(RangeError);
    expect(() => searchOffsetCursor('newest', 1.5)).toThrow(RangeError);
  });

  it('[S8-02] a target id filter is a parameterized primary-key condition (fallback statements only)', () => {
    const id = '0195f0a5-0801-7000-8000-000000000001';
    const q = new PgDialect().sqlToQuery(fallbackCondition({ op: 'eq', field: 'targetId', value: id }));
    expect(q.sql).toBe('target_id = $1');
    expect(q.params).toEqual([id]);
  });
});
