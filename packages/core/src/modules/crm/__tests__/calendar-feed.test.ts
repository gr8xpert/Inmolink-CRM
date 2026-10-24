import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { validateIcs } from '../../../testing/ics-validator';
import { FEED_MAX_EVENTS, FEED_MAX_GZIP_BYTES, FEED_TEXT_CHARS, feedPriority, renderCalendarFeed } from '../calendar';
import type { FeedEventRow } from '../calendar-repo';

/** Text that compresses poorly (pseudo-random words), so the size budget is tested near its worst case. */
function noise(seed: number, chars: number): string {
  let x = seed * 2_654_435_761 + 1;
  let out = '';
  while (out.length < chars) {
    x = (x * 1_103_515_245 + 12_345) % 2_147_483_648;
    out += `${x.toString(36)} `;
  }
  return out.slice(0, chars);
}

const NOW = new Date('2026-10-24T12:00:00Z');
const row = (i: number, dayOffset: number): FeedEventRow => ({
  id: `01900000-0000-7000-8000-${String(i).padStart(12, '0')}`,
  type: 'VIEWING',
  title: noise(i, 200),
  description: noise(i + 1, 4_000),
  location: noise(i + 2, 300),
  startsAt: new Date(NOW.getTime() + dayOffset * 86_400_000),
  endsAt: new Date(NOW.getTime() + dayOffset * 86_400_000 + 3_600_000),
  status: 'SCHEDULED',
  version: 3,
  updatedAt: NOW,
  memberNames: Array.from({ length: 21 }, (_, k) => noise(i * 50 + k, 40)),
  contactNames: Array.from({ length: 20 }, (_, k) => noise(i * 70 + k, 60)),
});

describe('calendar feed size', () => {
  it('[S10-06] 1,000 max-size events stay ≤ 150 KB gzip: descriptions cut, the farthest events dropped first', async () => {
    // 600 past (up to 30 days back) and 400 upcoming events, every text at its maximum
    const rows = Array.from({ length: FEED_MAX_EVENTS }, (_, i) => row(i, i < 600 ? -(i % 30) - 0.5 : (i % 365) + 0.5));
    const file = await renderCalendarFeed(rows, { locale: 'en', now: NOW });
    expect(file.gzip.byteLength).toBeLessThanOrEqual(FEED_MAX_GZIP_BYTES);
    expect(gunzipSync(file.gzip).toString('utf8')).toBe(file.body);
    const { problems, events } = validateIcs(file.body);
    expect(problems).toEqual([]);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events)
      expect(Array.from(e.text('DESCRIPTION') ?? '').length).toBeLessThanOrEqual(2 * FEED_TEXT_CHARS + 2);
    // what was dropped is the lowest priority: every upcoming event kept comes before any past one
    const kept = new Set(events.map((e) => e.raw('UID')?.split('@')[0]));
    const order = feedPriority(rows, NOW, FEED_MAX_EVENTS);
    const lastKept = order.findLastIndex((r) => kept.has(r.id));
    expect(order.slice(0, lastKept + 1).every((r) => kept.has(r.id))).toBe(true);
    expect(order[0]?.startsAt.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('[S10-06] upcoming events come first (soonest first), then the latest past ones', () => {
    const rows = [row(1, -1), row(2, 5), row(3, -10), row(4, 1)];
    expect(feedPriority(rows, NOW, 3).map((r) => r.id.slice(-1))).toEqual(['4', '2', '1']);
  });
});
