import { describe, expect, it } from 'vitest';
import { clientIpFromForwarded } from './client-ip';

describe('clientIpFromForwarded', () => {
  it('[S0-09] hop count picks the N-th entry from the right, so a forged left part is ignored', () => {
    expect(clientIpFromForwarded('6.6.6.6, 203.0.113.7', 1)).toBe('203.0.113.7');
    expect(clientIpFromForwarded('6.6.6.6, 203.0.113.7, 10.0.0.2', 2)).toBe('203.0.113.7');
    expect(clientIpFromForwarded('203.0.113.7', 3)).toBe('203.0.113.7');
  });

  it('[S0-09] a proxy list skips trusted hops from the right', () => {
    expect(clientIpFromForwarded('6.6.6.6, 203.0.113.7, 10.1.2.3, 127.0.0.1', ['loopback', '10.0.0.0/8'])).toBe(
      '203.0.113.7',
    );
    expect(clientIpFromForwarded('2001:db8::1, ::1', ['loopback'])).toBe('2001:db8::1');
  });

  it('[S0-09] normalizes ports and IPv4-mapped addresses; garbage gives undefined', () => {
    expect(clientIpFromForwarded('[2001:db8::1]:443', 1)).toBe('2001:db8::1');
    expect(clientIpFromForwarded('203.0.113.7:5000', 1)).toBe('203.0.113.7');
    expect(clientIpFromForwarded('::ffff:203.0.113.7', false)).toBe('203.0.113.7');
    expect(clientIpFromForwarded('not-an-ip', 1)).toBeUndefined();
    expect(clientIpFromForwarded(null, 1)).toBeUndefined();
  });
});
