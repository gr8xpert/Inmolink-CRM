import { AppError } from '@inmolink/platform/errors';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const core = vi.hoisted(() => ({
  submitPortalLead: vi.fn(),
  checkPortalLeadLimits: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
}));
vi.mock('@inmolink/core/modules/website-api', () => core);
vi.mock('@inmolink/platform/rate-limit', () => ({ rateLimiter: () => ({}) }));
vi.mock('@/server/env', () => ({
  publicConfig: async () => ({ PORTAL_URL: 'https://inmolink.test' }),
  portalOriginOf: (c: { PORTAL_URL?: string }) => new URL(c.PORTAL_URL ?? 'http://localhost:3101').origin,
}));
vi.mock('@/server/embed', () => ({ clientAddress: async () => ({ ip: '203.0.113.7', bucket: '203.0.113.7' }) }));
vi.mock('./data', () => ({ PORTAL_LOCALES: ['en', 'es'] }));

const { enquiryResponse } = await import('./enquiry');

const BACK = '/es/property/villa-en-rojales-ab12cd34';
const fields = (o: Record<string, string> = {}) =>
  new URLSearchParams({
    locale: 'es',
    code: 'AB12CD34',
    back: BACK,
    name: 'Jane Buyer',
    email: 'jane@example.com',
    message: 'Is it still available?',
    privacyAccepted: 'on',
    idempotencyKey: 'portal-0123456789abcdef',
    'cf-turnstile-response': 'token',
    ...o,
  });
const post = (body: URLSearchParams | string, headers: Record<string, string> = {}) =>
  enquiryResponse(
    new Request('http://portal.test/api/portal/enquiry', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: body.toString(),
    }),
  );

beforeEach(() => {
  core.submitPortalLead.mockReset();
  core.submitPortalLead.mockResolvedValue({ accepted: { id: 'x' }, created: true, ownerAgencyId: 'a' });
  core.checkPortalLeadLimits.mockClear();
});

describe('portal enquiry post (S15-02)', () => {
  it('[S15-02] a plain form post is validated, limited, handed to core, and answered 303 back to the listing', async () => {
    const res = await post(fields({ phone: '+34 600 000 000', marketingConsent: 'on' }));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${BACK}?enquiry=sent#enquiry`);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(core.checkPortalLeadLimits).toHaveBeenCalledWith({}, { ip: '203.0.113.7', code: 'AB12CD34' });
    expect(core.submitPortalLead).toHaveBeenCalledWith(
      {
        locale: 'es',
        code: 'AB12CD34',
        body: expect.objectContaining({
          name: 'Jane Buyer',
          email: 'jane@example.com',
          phone: '+34 600 000 000',
          privacyAccepted: true,
          marketingConsent: true,
          turnstileToken: 'token',
        }),
      },
      { ip: '203.0.113.7', idempotencyKey: 'portal-0123456789abcdef', limiter: {} },
    );
  });

  it('[S15-03] an agency profile’s form: a general enquiry for that agency, answered back on its profile page', async () => {
    const agency = '01900000-0000-7000-8000-0000000000a1';
    const back = `/es/agency/${agency}/move-homes`;
    const res = await post(fields({ code: '', agency: agency.toUpperCase(), back }));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${back}?enquiry=sent#enquiry`);
    expect(core.checkPortalLeadLimits).toHaveBeenCalledWith({}, { ip: '203.0.113.7' });
    expect(core.submitPortalLead).toHaveBeenCalledWith(
      { locale: 'es', agencyId: agency, body: expect.not.objectContaining({ ref: expect.anything() }) },
      expect.objectContaining({ idempotencyKey: 'portal-0123456789abcdef' }),
    );
    // An agency that is not listed: its own notice; a back path that is no portal page goes home.
    core.submitPortalLead.mockRejectedValueOnce(new AppError('NOT_FOUND'));
    const gone = await post(fields({ code: '', agency, back: '//evil.example/x' }));
    expect(gone.headers.get('location')).toBe('/es?enquiry=NOT_FOUND#enquiry');
    // Neither a listing nor an agency: refused before core.
    core.submitPortalLead.mockClear();
    expect((await post(fields({ code: '', agency: '' }), { accept: 'application/json' })).status).toBe(400);
    expect(core.submitPortalLead).not.toHaveBeenCalled();
  });

  it('[S15-02] consent is required and links are refused (the website lead contract); nothing reaches core', async () => {
    for (const bad of [
      fields({ privacyAccepted: '' }),
      fields({ name: 'Visit https://spam.example' }),
      fields({ email: 'not-an-email' }),
      fields({ code: '' }),
    ]) {
      const res = await post(bad, { accept: 'application/json' });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ status: 'error', error: 'VALIDATION_FAILED' });
    }
    expect(core.submitPortalLead).not.toHaveBeenCalled();
  });

  it('[S15-02] rate limited, refused by Turnstile or a gone listing: the visitor sees why; JSON for the script', async () => {
    core.checkPortalLeadLimits.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 30 });
    expect((await post(fields(), { accept: 'application/json' })).status).toBe(429);
    core.submitPortalLead.mockRejectedValueOnce(new AppError('TURNSTILE_FAILED'));
    expect(await (await post(fields(), { accept: 'application/json' })).json()).toEqual({
      status: 'error',
      error: 'TURNSTILE_FAILED',
    });
    core.submitPortalLead.mockRejectedValueOnce(new AppError('LISTING_NOT_FOUND'));
    expect((await post(fields())).headers.get('location')).toBe(`${BACK}?enquiry=LISTING_NOT_FOUND#enquiry`);
    core.submitPortalLead.mockRejectedValueOnce(new AppError('IDEMPOTENCY_KEY_REUSED'));
    expect((await post(fields())).headers.get('location')).toBe(`${BACK}?enquiry=generic#enquiry`);
  });

  it('[S15-02] the answer never leaves the portal: an off-site or non-listing "back" goes to the locale home', async () => {
    for (const back of [
      'https://evil.example/',
      '//evil.example',
      '/\\evil.example',
      '/es/properties',
      '/es/property/x?y=1',
    ]) {
      expect((await post(fields({ back }))).headers.get('location'), back).toBe('/es?enquiry=sent#enquiry');
    }
  });

  it('[S15-02] urlencoded only, and the body is capped', async () => {
    const json = await enquiryResponse(
      new Request('http://portal.test/api/portal/enquiry', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(json.status).toBe(415);
    expect((await post(fields({ message: 'x'.repeat(20_000) }))).status).toBe(413);
  });
});

describe('portal enquiry post: origin (S15-02 review)', () => {
  it('[S15-02] a browser post from another site is refused; the portal origin and no Origin pass', async () => {
    expect((await post(fields(), { origin: 'https://evil.example' })).status).toBe(403);
    expect((await post(fields(), { origin: 'null' })).status).toBe(403);
    expect(core.submitPortalLead).not.toHaveBeenCalled();
    expect((await post(fields(), { origin: 'https://inmolink.test' })).status).toBe(303);
    expect((await post(fields())).status).toBe(303);
  });
});
