import { MAX_EVENT_PAYLOAD_BYTES } from '@inmolink/platform/outbox';
import { describe, expect, it } from 'vitest';
import { PUBLIC_DOCS_EVENT_TARGETS } from '../events';
import { publicDocsEvents } from '../service';

/** A UUID-shaped id from a number (deterministic, valid for `z.uuid()`). */
const uuid = (n: number, prefix = 1) =>
  `${prefix.toString(16).padStart(8, '0')}-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

describe('search.publicDocs.changed payload (S13-F7)', () => {
  it('[S13-F7] worst case stays within the outbox cap: every target exactly once, ids omitted when all are new', () => {
    const owner = uuid(1, 9);
    const targets = Array.from({ length: PUBLIC_DOCS_EVENT_TARGETS * 2 }, (_, i) => uuid(i, 2));
    // Two groups of `MAX_PREFERRED_AGENCIES` (200) preferred agencies that lose sight of their targets, a different
    // development before and after for every unit, and every other target new to the network.
    const groups = [0, 1].map((g) => Array.from({ length: 200 }, (_, i) => uuid(i, 10 + g)));
    const rows = targets.map((targetId) => ({ targetId, ownerAgencyId: owner }));
    const before = new Map(
      targets.map((id, i) => [
        id,
        {
          developmentId: uuid(i, 3),
          status: 'ACTIVE',
          networkHidden: false,
          shareScope: 'PREFERRED',
          preferredAgencyIds: groups[i % 2] as string[],
        },
      ]),
    );
    const after = new Map(
      targets.map((id, i) => [
        id,
        {
          developmentId: uuid(i, 4),
          public: true,
          status: 'ACTIVE',
          networkHidden: false,
          shareScope: i % 2 === 0 ? 'ALL' : 'PREFERRED',
          preferredAgencyIds: i % 2 === 0 ? null : [],
        },
      ]),
    );
    const events = publicDocsEvents(rows as never, before as never, after as never, new Set(targets));
    const payloads = events.map((e) => e.payload as { targetIds: string[]; networkShownIds?: string[] });
    for (const p of payloads) expect(Buffer.byteLength(JSON.stringify(p))).toBeLessThanOrEqual(MAX_EVENT_PAYLOAD_BYTES);
    const seen = payloads.flatMap((p) => p.targetIds);
    expect(seen).toHaveLength(targets.length);
    expect(new Set(seen)).toEqual(new Set(targets));
    // The even targets (shared with ALL now, new text) are new to the network; the odd ones are seen by nobody.
    const shown = payloads.flatMap((p) => p.networkShownIds ?? p.targetIds);
    expect(new Set(shown)).toEqual(new Set(targets.filter((_, i) => i % 2 === 0)));

    // A chunk where every target is new to the network: `networkShownIds` is omitted (absent = every target).
    const even = rows.filter((_, i) => i % 2 === 0).slice(0, 10);
    const [allNew, ...rest] = publicDocsEvents(even as never, new Map() as never, after as never, new Set());
    expect(rest).toEqual([]);
    expect(allNew?.payload).not.toHaveProperty('networkShownIds');
    expect((allNew?.payload as { targetIds?: string[] } | undefined)?.targetIds).toHaveLength(10);
  });
});
