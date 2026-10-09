import { describe, expect, it } from 'vitest';
import { APP_NAME, describeApp } from './app-info';

describe('app web', () => {
  it('[S0-01] builds against @inmolink/ui', () => {
    expect(APP_NAME).toBe('web');
    expect(describeApp()).toContain('@inmolink/ui');
  });
});
