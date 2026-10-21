import { describe, expect, it } from 'vitest';
import { ApiOrigin, CreateApiKeyBody } from './api-keys';

describe('API key contracts', () => {
  it('[S1-05] origins are normalised browser origins (https, or http://localhost)', () => {
    expect(ApiOrigin.parse(' https://WWW.Example.com ')).toBe('https://www.example.com');
    expect(ApiOrigin.parse('https://example.com:8443')).toBe('https://example.com:8443');
    expect(ApiOrigin.parse('http://localhost:3000')).toBe('http://localhost:3000');
    for (const bad of [
      'http://example.com',
      'https://example.com/',
      'https://example.com/path',
      'https://user@example.com',
      'https://*.example.com',
      'example.com',
      'https://localhost',
      'javascript:alert(1)',
      'https://example.com:443',
      'http://localhost:80',
    ]) {
      expect(ApiOrigin.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('[S1-05] a publishable key needs an allowed origin; a secret key takes none', () => {
    const base = { name: 'Website', scopes: ['listings:read'] };
    expect(CreateApiKeyBody.safeParse({ ...base, kind: 'PUBLISHABLE' }).success).toBe(false);
    expect(
      CreateApiKeyBody.safeParse({ ...base, kind: 'PUBLISHABLE', allowedOrigins: ['https://example.com'] }).success,
    ).toBe(true);
    expect(
      CreateApiKeyBody.safeParse({ ...base, kind: 'SECRET', allowedOrigins: ['https://example.com'] }).success,
    ).toBe(false);
    expect(CreateApiKeyBody.parse({ ...base, kind: 'SECRET' })).toMatchObject({ allowedOrigins: [] });
    // The tier is not the agency's to choose (staff set HIGH).
    expect(CreateApiKeyBody.safeParse({ ...base, kind: 'SECRET', rateTier: 'HIGH' }).success).toBe(false);
  });

  it('[S1-05] scopes come from the closed list, at least one, no duplicates', () => {
    const base = { name: 'Website', kind: 'SECRET' };
    expect(CreateApiKeyBody.safeParse({ ...base, scopes: [] }).success).toBe(false);
    expect(CreateApiKeyBody.safeParse({ ...base, scopes: ['admin'] }).success).toBe(false);
    expect(CreateApiKeyBody.safeParse({ ...base, scopes: ['listings:read', 'listings:read'] }).success).toBe(false);
    expect(CreateApiKeyBody.safeParse({ ...base, scopes: ['listings:read'], extra: 1 }).success).toBe(false);
  });

  it('[S1-05] publishable keys get read scopes and, since S7-05 (Turnstile), the website form scopes', () => {
    const base = { name: 'Widget', kind: 'PUBLISHABLE', allowedOrigins: ['https://example.com'] };
    expect(CreateApiKeyBody.safeParse({ ...base, scopes: ['listings:read', 'search:ai'] }).success).toBe(true);
    for (const scope of ['leads:write', 'viewing-requests:write']) {
      expect(CreateApiKeyBody.safeParse({ ...base, scopes: ['listings:read', scope] }).success, scope).toBe(true);
    }
  });
});
