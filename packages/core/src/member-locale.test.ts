import { describe, expect, it } from 'vitest';
import { requestLocale } from './member';

describe('request locale', () => {
  it('[S17-F18] the language of the page wins over the agency default', () => {
    expect(requestLocale('en', ['es', 'en'])).toBe('en');
  });

  it('[S17-F18] a missing, unknown or browser-style value falls back to the agency, then the default', () => {
    expect(requestLocale(undefined, ['es', 'en'])).toBe('es');
    expect(requestLocale('xx', ['es', 'en'])).toBe('es');
    expect(requestLocale('en-US,en;q=0.9', ['es', 'en'])).toBe('es');
    expect(requestLocale(undefined, ['de'])).toBe('de');
    expect(requestLocale(undefined, [])).toBeTruthy();
  });
});
