// S12-F16 → packages/core/src/modules/chat/__tests__/network-closed.test.ts
import { describe, expect, it } from 'vitest';
import { isNetworkClosedRefusal } from '../service';

describe('the fan-out network refusal (S12-F12 review)', () => {
  it('[S12-F16] only P0001 with hint network_closed reads as a closed thread; other 42501s and errors do not', () => {
    const closed = Object.assign(new Error('closed'), { code: 'P0001', hint: 'network_closed' });
    expect(isNetworkClosedRefusal(closed)).toBe(true);
    // Drizzle wraps the driver error in `cause`
    expect(isNetworkClosedRefusal(Object.assign(new Error('Failed query'), { cause: closed }))).toBe(true);
    expect(isNetworkClosedRefusal(Object.assign(new Error('rls'), { code: '42501' }))).toBe(false);
    expect(isNetworkClosedRefusal(Object.assign(new Error('other'), { code: 'P0001', hint: 'something' }))).toBe(false);
    expect(isNetworkClosedRefusal(Object.assign(new Error('other'), { code: 'P0001' }))).toBe(false);
    expect(isNetworkClosedRefusal(undefined)).toBe(false);
  });
});
