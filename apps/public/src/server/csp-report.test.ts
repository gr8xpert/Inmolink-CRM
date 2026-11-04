import type { RateLimitRule } from '@inmolink/platform/rate-limit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type CspViolation, cspReportResponse, MAX_REPORT_BYTES, violationsOf } from './csp-report';

const consume = vi.fn(async (_rule: RateLimitRule, _bucket: string) => ({ allowed: true, retryAfterSeconds: 0 }));
vi.mock('@inmolink/platform/rate-limit', () => ({ rateLimiter: () => ({ consume }) }));
vi.mock('./embed', () => ({ clientAddress: async () => ({ ip: '203.0.113.7', bucket: '203.0.113.7' }) }));

const post = (body: string, type = 'application/csp-report', headers: Record<string, string> = {}) =>
  new Request('https://portal.test/api/csp-report', {
    method: 'POST',
    headers: { 'content-type': type, 'x-forwarded-for': '203.0.113.7', ...headers },
    body,
  });

const REPORT = JSON.stringify({
  'csp-report': {
    'document-uri': 'https://portal.test/en/property/villa-x?email=ana@example.com',
    referrer: 'https://mail.example/inbox?u=ana',
    'violated-directive': 'script-src-elem',
    'effective-directive': 'script-src-elem',
    'blocked-uri': 'https://evil.example/x.js?token=secret',
    'script-sample': 'steal(document.cookie)',
    'source-file': 'https://portal.test/en/property/villa-x?email=ana@example.com',
  },
});

beforeEach(() => consume.mockClear());

describe('CSP report endpoint (S16-F8)', () => {
  it('[S16-F8] a report is logged as directive, blocked origin and page path only — no query, referrer, sample or address', async () => {
    const logged: CspViolation[] = [];
    const res = await cspReportResponse(post(REPORT), (v) => logged.push(v));
    expect(res.status).toBe(204);
    expect(logged).toEqual([
      { directive: 'script-src-elem', blocked: 'https://evil.example', path: '/en/property/villa-x' },
    ]);
    expect(JSON.stringify(logged)).not.toMatch(/ana|secret|cookie|203\.0\.113|mail\.example/);
    // The Reporting API shape too; inline / eval keep their keyword.
    expect(
      violationsOf([
        {
          type: 'csp-violation',
          body: { effectiveDirective: 'script-src', blockedURL: 'inline', documentURL: 'https://p.test/es?q=1' },
        },
        { type: 'deprecation', body: {} },
      ]),
    ).toEqual([{ directive: 'script-src', blocked: 'inline', path: '/es' }]);
    expect(violationsOf({ 'csp-report': { 'effective-directive': "x'; drop", 'blocked-uri': 'nonsense' } })).toEqual([
      { directive: 'unknown', blocked: 'other', path: 'unknown' },
    ]);
  });

  it('[S17-F16] the rule passes the real limiter check, so a report is not a 500', async () => {
    const { assertRule } = await vi.importActual<typeof import('@inmolink/platform/rate-limit')>(
      '@inmolink/platform/rate-limit',
    );
    consume.mockClear();
    await cspReportResponse(post(REPORT), () => {});
    const rule = consume.mock.calls[0]?.[0];
    expect(rule).toBeDefined();
    expect(() => assertRule(rule as RateLimitRule)).not.toThrow();
  });

  it('[S16-F8] limited per client address, capped at 8 KB (declared or streamed), JSON report types only', async () => {
    expect((await cspReportResponse(post(REPORT), () => {})).status).toBe(204);
    expect(consume).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'public.csp-report', scope: 'ip' }),
      '203.0.113.7',
    );
    consume.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 30 });
    expect((await cspReportResponse(post(REPORT), () => {})).status).toBe(429);
    const big = JSON.stringify({ 'csp-report': { pad: 'x'.repeat(MAX_REPORT_BYTES) } });
    expect((await cspReportResponse(post(big), () => {})).status).toBe(413);
    expect(
      (await cspReportResponse(post(REPORT, 'application/csp-report', { 'content-length': '999999' }), () => {}))
        .status,
    ).toBe(413);
    expect((await cspReportResponse(post(REPORT, 'text/plain'), () => {})).status).toBe(415);
    expect((await cspReportResponse(post('{nope', 'application/json'), () => {})).status).toBe(400);
    // Refused before any body is read: a wrong type costs nothing.
    consume.mockClear();
    await cspReportResponse(post(REPORT, 'text/plain'), () => {});
    expect(consume).not.toHaveBeenCalled();
  });
});
