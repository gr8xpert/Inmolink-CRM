import { describe, expect, it } from 'vitest';
import { refusalLogFields } from './api-refusal';

const res = (status: number, headers: Record<string, string> = {}) => ({ status, headers: new Headers(headers) });

describe('refusal logging', () => {
  it('[S17-F7] a refusal that did not come from the API is logged, with the edge headers and no query', () => {
    const fields = refusalLogFields(
      '/v1/agency/verification/documents?kind=TAX_ID',
      res(403, { 'content-type': 'text/html', 'cf-mitigated': 'challenge' }),
      false,
    );
    expect(fields).toEqual({
      status: 403,
      path: '/v1/agency/verification/documents',
      fromApi: false,
      contentType: 'text/html',
      cfMitigated: 'challenge',
    });
  });

  it("[S17-F7] the API's own refusals stay quiet, except 401 and 5xx", () => {
    expect(refusalLogFields('/v1/x', res(403), true)).toBeNull();
    expect(refusalLogFields('/v1/x', res(422), true)).toBeNull();
    expect(refusalLogFields('/v1/x', res(401), true)).not.toBeNull();
    expect(refusalLogFields('/v1/x', res(500), true)).not.toBeNull();
  });
});
