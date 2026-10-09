import { describe, expect, it } from 'vitest';
import { APP_NAME, describeApp } from './app';

describe('app worker', () => {
  it('[S0-01] builds against @inmolink/core', () => {
    expect(APP_NAME).toBe('worker');
    expect(describeApp()).toContain('@inmolink/core');
  });
});
