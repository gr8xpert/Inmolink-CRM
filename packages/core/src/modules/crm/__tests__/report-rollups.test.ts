import { describe, expect, it } from 'vitest';
import { median, mergeReportParts, mergeResponseParts } from '../report-rollups';
import { kpiSegments, utcDays } from '../report-rollups-repo';

const t = (iso: string) => new Date(iso);

describe('report rollups (pure parts)', () => {
  it('[S11-F10] a KPI range splits into its whole UTC days (rollup) and the partial days at its ends (raw)', () => {
    expect(kpiSegments(t('2026-09-01T00:00:00Z'), t('2026-09-03T00:00:00Z'))).toEqual([
      { kind: 'days', from: '2026-09-01', to: '2026-09-03' },
    ]);
    expect(kpiSegments(t('2026-09-01T10:00:00Z'), t('2026-09-04T05:00:00Z'))).toEqual([
      { kind: 'raw', from: t('2026-09-01T10:00:00Z'), to: t('2026-09-02T00:00:00Z') },
      { kind: 'days', from: '2026-09-02', to: '2026-09-04' },
      { kind: 'raw', from: t('2026-09-04T00:00:00Z'), to: t('2026-09-04T05:00:00Z') },
    ]);
    // inside one day, or across one midnight with no whole day: raw only
    expect(kpiSegments(t('2026-09-01T10:00:00Z'), t('2026-09-02T09:00:00Z'))).toEqual([
      { kind: 'raw', from: t('2026-09-01T10:00:00Z'), to: t('2026-09-02T09:00:00Z') },
    ]);
    expect(kpiSegments(t('2026-09-01T10:00:00Z'), t('2026-09-01T10:00:00Z'))).toEqual([]);
    expect(utcDays('2026-08-30', '2026-09-02')).toEqual(['2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02']);
  });

  it('[S11-F10] exact medians from the pooled histogram: odd → the middle one, even → the mean of the two middle ones', () => {
    expect(median([90, 10, 20])).toBe(20);
    expect(median([10, 20, 90, 100])).toBe(55);
    expect(median([])).toBeNull();
    const merged = mergeResponseParts([
      // a rollup day and a raw partial day of the same responder, an unanswered part, another responder
      { userId: 'a', leads: 2, responded: 2, secondsSum: 30, seconds: [10, 20] },
      { userId: 'a', leads: 1, responded: 1, secondsSum: 5, seconds: [5] },
      { userId: null, leads: 2, responded: 0, secondsSum: 0, seconds: [] },
      { userId: 'b', leads: 2, responded: 2, secondsSum: 190, seconds: [90, 100] },
    ]);
    expect(merged).toEqual([
      { userId: null, leads: 7, responded: 5, medianSeconds: 20, avgSeconds: 45 },
      { userId: 'a', leads: 3, responded: 3, medianSeconds: 10, avgSeconds: 12 },
      { userId: 'b', leads: 2, responded: 2, medianSeconds: 95, avgSeconds: 95 },
    ]);
    // 1 and 2 → 1.5 rounds like the SQL it replaces (half up)
    expect(
      mergeResponseParts([{ userId: null, leads: 2, responded: 2, secondsSum: 3, seconds: [1, 2] }])[0],
    ).toMatchObject({
      medianSeconds: 2,
      avgSeconds: 2,
    });
  });

  it('[S11-F10] the report per stage from its parts: leads now from the stage counts, moves pooled over days and raw edges', () => {
    expect(
      mergeReportParts([
        { stageId: 's', part: 'cur', a: 4, b: 0, s: 99.6, stays: [] },
        { stageId: 's', part: 'moves', a: 2, b: 2, s: 180, stays: [60, 120] },
        { stageId: 's', part: 'moves', a: 1, b: 1, s: 600, stays: [600] },
        { stageId: 'w', part: 'moves', a: 3, b: 0, s: 0, stays: [] },
      ]),
    ).toEqual([
      {
        stageId: 's',
        current: 4,
        currentAvgSeconds: 100,
        entered: 3,
        exited: 3,
        avgSeconds: 260,
        medianSeconds: 120,
      },
      {
        stageId: 'w',
        current: 0,
        currentAvgSeconds: null,
        entered: 3,
        exited: 0,
        avgSeconds: null,
        medianSeconds: null,
      },
    ]);
  });
});
