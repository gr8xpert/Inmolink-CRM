import { describe, expect, it } from 'vitest';
import { sqlState } from './errors';

describe('error handler helpers', () => {
  it('[S1-09] unmapped database errors are logged with their SQLSTATE, also when wrapped', () => {
    expect(sqlState(Object.assign(new Error('canceling statement'), { code: '57014' }))).toBe('57014');
    expect(sqlState(new Error('Failed query', { cause: Object.assign(new Error('dup'), { code: '23505' }) }))).toBe(
      '23505',
    );
    expect(sqlState(Object.assign(new Error('x'), { code: 'FST_ERR_BAD_URL' }))).toBeUndefined();
    expect(sqlState('nope')).toBeUndefined();
  });
});
