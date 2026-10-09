import { describe, expect, it } from 'vitest';
import { AppError, ErrorCodes, isAppError } from './errors';

describe('AppError', () => {
  it('[S0-03] carries code, details and the mapped HTTP status', () => {
    const err = new AppError('VERSION_CONFLICT', { expected: 2 });
    expect(err).toBeInstanceOf(Error);
    expect(isAppError(err)).toBe(true);
    expect(err.code).toBe('VERSION_CONFLICT');
    expect(err.details).toEqual({ expected: 2 });
    expect(err.status).toBe(ErrorCodes.VERSION_CONFLICT);
    expect(err.retryable).toBe(false);
  });

  it('[S0-03] is not confused with plain errors', () => {
    expect(isAppError(new Error('VERSION_CONFLICT'))).toBe(false);
  });

  it('[S0-03] recognises an AppError from another copy of the package', () => {
    const foreign = Object.assign(new Error('FORBIDDEN'), { name: 'AppError', code: 'FORBIDDEN' });
    expect(isAppError(foreign)).toBe(true);
    expect(isAppError(Object.assign(new Error('x'), { name: 'AppError', code: 'NOPE' }))).toBe(false);
  });
});
