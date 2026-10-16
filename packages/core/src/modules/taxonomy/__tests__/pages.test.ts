import { gzipSync } from 'node:zlib';
import { WebsiteLocationChildrenDto } from '@inmolink/contracts';
import { describe, expect, it } from 'vitest';
import { CHILDREN_PAGE_BYTES, CHILDREN_PAGE_MAX, childrenPageJson, childrenPages, type TreeNode } from '../tree';

/** Children pages of the website API (S3-F2): size-bounded, so any parent stays inside the feed-api budget. */

const uuid = (i: number) => `0190a000-0000-7000-8000-${String(i).padStart(12, '0')}`;
/** Worst case: the longest name (200 chars, 2-byte letters) and slug (120 chars) the contract allows. */
const node = (i: number): TreeNode => ({
  id: uuid(i),
  level: 'AREA',
  code: `C${i}`.padEnd(40, 'x'),
  name: `Ñandú ${i} ${'áéíóúñ'.repeat(40)}`.slice(0, 200),
  slug: `area-${i}-${'q'.repeat(120)}`.slice(0, 120),
});

describe('children pages', () => {
  it('[S3-F2] children responses stay ≤ 150 KB gzip for any parent', () => {
    const children = Array.from({ length: 12_000 }, (_, i) => node(i));
    const pages = childrenPages(children);
    expect(pages.length).toBeGreaterThan(1);
    const seen: string[] = [];
    pages.forEach((items, p) => {
      const next = p + 1 < pages.length ? String(p + 1) : null;
      const json = childrenPageJson('es', uuid(999_999), items, next);
      expect(Buffer.byteLength(json)).toBeLessThanOrEqual(CHILDREN_PAGE_BYTES + 200);
      expect(gzipSync(json).length).toBeLessThanOrEqual(150 * 1024);
      expect(items.length).toBeLessThanOrEqual(CHILDREN_PAGE_MAX);
      const body = WebsiteLocationChildrenDto.parse(JSON.parse(json));
      expect(body.nextCursor).toBe(next);
      seen.push(...body.children.map((c) => c.id));
    });
    // every child once, in order
    expect(seen).toEqual(children.map((c) => c.id));
  });

  it('[S3-F2] small parents are one page; short names fill up to the item cap', () => {
    expect(childrenPages([])).toEqual([[]]);
    expect(childrenPages([node(1)])).toHaveLength(1);
    const short = Array.from({ length: 2_500 }, (_, i) => ({
      id: uuid(i),
      level: 'CITY',
      code: null,
      name: 'X',
      slug: 'x',
    }));
    expect(childrenPages(short).map((p) => p.length)).toEqual([CHILDREN_PAGE_MAX, CHILDREN_PAGE_MAX, 500]);
  });
});
