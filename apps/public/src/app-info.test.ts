import { describe, expect, it } from 'vitest';
import { APP_NAME, describeApp } from './app-info';

describe('app public', () => {
  it('[S0-01] builds against @inmolink/ui', () => {
    expect(APP_NAME).toBe('public');
    expect(describeApp()).toContain('@inmolink/ui');
  });
});
