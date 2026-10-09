import { describe, expect, it } from 'vitest';
import { APP_NAME, describeApp } from './app';

describe('app realtime', () => {
  it('[S0-01] builds against @inmolink/core', () => {
    expect(APP_NAME).toBe('realtime');
    expect(describeApp()).toContain('@inmolink/core');
  });
});
