import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The collaboration server actions (S17-F56) with only the transport below them mocked: what reaches `apiRequest` is what
 * the API gets.
 */
const h = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  timeZone: vi.fn(),
  redirects: [] as string[],
}));

vi.mock('@/server/api', () => ({ apiRequest: h.apiRequest }));
vi.mock('@/server/actions', () => ({ requireSession: async () => ({ userId: 'u1' }) }));
vi.mock('@/server/agency-time-zone', () => ({ readAgencyTimeZone: h.timeZone }));
vi.mock('next-intl/server', () => ({ getLocale: async () => 'en' }));
vi.mock('@/i18n/navigation', () => ({ getPathname: ({ href }: { href: string }) => `/en${href}` }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    h.redirects.push(to);
    throw new Error('NEXT_REDIRECT');
  },
}));

const { registerClientAction, requestViewingAction } = await import('./actions');

const REGISTRATION = '01900000-0000-7000-8000-000000000001';
const CONTACT = '01900000-0000-7000-8000-000000000002';
const LISTING = '01900000-0000-7000-8000-000000000003';
const IDEMPOTENCY_ID = '01900000-0000-7000-8000-000000000004';

const form = (values: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) f.set(k, v);
  return f;
};
const run = async (action: (f: FormData) => Promise<void>, f: FormData) => {
  await expect(action(f)).rejects.toThrow('NEXT_REDIRECT');
  return h.redirects.at(-1) ?? '';
};

beforeEach(() => {
  h.apiRequest.mockReset();
  h.timeZone.mockReset();
  h.redirects.length = 0;
});

describe('[S17-F56] request viewing action', () => {
  const viewingForm = () =>
    form({
      registrationId: REGISTRATION,
      idempotencyKey: IDEMPOTENCY_ID,
      proposedStartAt: '2026-11-20T10:30',
      back: 'direction=OUT&type=REGISTRATION&evil=1',
    });

  it('[S17-F56] forwards the form’s Idempotency-Key and the agency-zone instant', async () => {
    h.timeZone.mockResolvedValue('Europe/Madrid');
    h.apiRequest.mockResolvedValue({ ok: true, status: 201, data: {} });
    const to = await run(requestViewingAction, viewingForm());
    expect(h.apiRequest).toHaveBeenCalledTimes(1);
    const [, path, , init] = h.apiRequest.mock.calls[0] as [unknown, string, unknown, Record<string, unknown>];
    expect(path).toBe('/v1/mls/viewing-requests');
    expect(init.headers).toEqual({ 'idempotency-key': IDEMPOTENCY_ID });
    // 10:30 in Madrid in November (UTC+1) is 09:30 UTC
    expect(init.body).toEqual({ registrationId: REGISTRATION, proposedStartAt: '2026-11-20T09:30:00.000Z' });
    // back to the same filters, nothing the page does not know
    expect(to).toBe('/en/collaborations?direction=OUT&type=REGISTRATION&done=viewingRequested');
  });

  it('[S17-F56] the same wall clock in summer is another instant (UTC+2)', async () => {
    h.timeZone.mockResolvedValue('Europe/Madrid');
    h.apiRequest.mockResolvedValue({ ok: true, status: 201, data: {} });
    await run(
      requestViewingAction,
      form({ ...Object.fromEntries(viewingForm()), proposedStartAt: '2027-07-01T10:30' }),
    );
    const init = h.apiRequest.mock.calls[0]?.[3] as { body: { proposedStartAt: string } };
    expect(init.body.proposedStartAt).toBe('2027-07-01T08:30:00.000Z');
  });

  it('[S17-F56] without the agency’s time zone nothing is sent: guessing would book the wrong hour', async () => {
    h.timeZone.mockResolvedValue(null);
    const to = await run(requestViewingAction, viewingForm());
    expect(h.apiRequest).not.toHaveBeenCalled();
    expect(to).toContain('error=generic');
  });

  it('[S17-F56] the API’s refusal comes back as its key', async () => {
    h.timeZone.mockResolvedValue('Europe/Madrid');
    h.apiRequest.mockResolvedValue({
      ok: false,
      status: 422,
      error: { code: 'VIEWING_TERMS_INCOMPLETE', message: 'x' },
    });
    expect(await run(requestViewingAction, viewingForm())).toContain('error=VIEWING_TERMS_INCOMPLETE');
  });

  it('[S17-F56] a missing time or a malformed key is refused before the API', async () => {
    h.timeZone.mockResolvedValue('Europe/Madrid');
    expect(
      await run(requestViewingAction, form({ registrationId: REGISTRATION, idempotencyKey: IDEMPOTENCY_ID })),
    ).toContain('error=TIME_REQUIRED');
    expect(
      await run(requestViewingAction, form({ ...Object.fromEntries(viewingForm()), idempotencyKey: 'short' })),
    ).toContain('error=VALIDATION_FAILED');
    expect(h.apiRequest).not.toHaveBeenCalled();
  });
});

describe('[S17-F56] register client action', () => {
  const registerForm = () => form({ kind: 'LISTING', id: LISTING, contactId: CONTACT });

  it('[S17-F56] 201 is a new registration, 200 the agency’s own still valid', async () => {
    h.apiRequest.mockResolvedValueOnce({ ok: true, status: 201, data: {} });
    expect(await run(registerClientAction, registerForm())).toContain('done=registered');
    h.apiRequest.mockResolvedValueOnce({ ok: true, status: 200, data: {} });
    expect(await run(registerClientAction, registerForm())).toContain('done=alreadyRegistered');
    const init = h.apiRequest.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(init.body).toEqual({ contactId: CONTACT, target: { kind: 'LISTING', id: LISTING } });
  });

  it('[S17-F56] a refusal returns to the register page with its key', async () => {
    h.apiRequest.mockResolvedValue({
      ok: false,
      status: 403,
      error: { code: 'NETWORK_GIVE_TO_GET_LOCKED', message: 'x' },
    });
    const to = await run(registerClientAction, registerForm());
    expect(to).toBe(`/en/collaborations/register?kind=LISTING&id=${LISTING}&error=NETWORK_GIVE_TO_GET_LOCKED`);
  });

  it('[S17-F56] no contact chosen is refused before the API', async () => {
    const to = await run(registerClientAction, form({ kind: 'LISTING', id: LISTING }));
    expect(to).toContain('error=NO_CONTACT');
    expect(h.apiRequest).not.toHaveBeenCalled();
  });
});
