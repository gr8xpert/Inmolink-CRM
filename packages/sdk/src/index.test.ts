import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index';

describe('@inmolink/sdk', () => {
  it('[S0-01] exports a placeholder', () => {
    expect(PACKAGE_NAME).toBe('@inmolink/sdk');
  });
});
