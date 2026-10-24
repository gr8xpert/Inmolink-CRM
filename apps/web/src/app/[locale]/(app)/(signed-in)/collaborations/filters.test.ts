import { describe, expect, it } from 'vitest';
import { parseCollaborationParams, sectionsFor } from './filters';

describe('collaborations filters', () => {
  it('[S11-06] no filter loads the four lists, a direction or type narrows them', () => {
    expect(sectionsFor(parseCollaborationParams({}))).toEqual([
      'outRegistrations',
      'outViewings',
      'inRegistrations',
      'inViewings',
    ]);
    expect(sectionsFor(parseCollaborationParams({ direction: 'IN', type: 'VIEWING' }))).toEqual(['inViewings']);
    expect(sectionsFor(parseCollaborationParams({ direction: 'OUT' }))).toEqual(['outRegistrations', 'outViewings']);
  });

  it('[S11-06] a state only one kind has leaves the other kind out; EXPIRED fits both', () => {
    expect(sectionsFor(parseCollaborationParams({ state: 'ACTIVE' }))).toEqual(['outRegistrations', 'inRegistrations']);
    expect(sectionsFor(parseCollaborationParams({ state: 'SCHEDULED' }))).toEqual(['outViewings', 'inViewings']);
    const expired = parseCollaborationParams({ state: 'EXPIRED' });
    expect(sectionsFor(expired)).toHaveLength(4);
    expect(expired.regState).toBe('EXPIRED');
    expect(expired.viewStatus).toBe('EXPIRED');
  });

  it('[S11-06] junk params are ignored', () => {
    const f = parseCollaborationParams({
      direction: 'x',
      state: 'nope',
      kind: 'HOUSE',
      from: '2026-13-99',
      to: 'soon',
      cursor: '../',
    });
    expect(f).toMatchObject({
      direction: undefined,
      state: undefined,
      kind: undefined,
      from: undefined,
      to: undefined,
      cursor: undefined,
    });
  });
});
