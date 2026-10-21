import { describe, expect, it } from 'vitest';
import { createTurnstileVerifier } from './index';

const reply = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('turnstile', () => {
  it('[S1-F5] accepts a token solved for the expected action and sends the secret, never trusting the client', async () => {
    let sent: Record<string, unknown> = {};
    const fetch = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ success: true, action: 'login' }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const v = createTurnstileVerifier({ secretKey: 's3cret', fetch });
    expect(await v.verify('tok', { action: 'login', remoteIp: '203.0.113.9' })).toBe(true);
    expect(sent).toEqual({ secret: 's3cret', response: 'tok', remoteip: '203.0.113.9' });
  });

  it('[S1-F5] with hostnames set, only tokens solved on those hosts pass', async () => {
    const on = (hostname: string) =>
      createTurnstileVerifier({
        secretKey: 's',
        hostnames: ['app.inmolink.es'],
        fetch: reply(200, { success: true, action: 'login', hostname }),
      }).verify('t', { action: 'login' });
    expect(await on('app.inmolink.es')).toBe(true);
    expect(await on('evil.example')).toBe(false);
  });

  it('[S7-05] per-call hostnames (a website form page) replace the configured ones for that call', async () => {
    const verifier = (hostname: string) =>
      createTurnstileVerifier({
        secretKey: 's',
        hostnames: ['app.inmolink.es'],
        fetch: reply(200, { success: true, action: 'website-lead', hostname }),
      });
    const onSite = { action: 'website-lead', hostnames: ['www.costa.example'] };
    expect(await verifier('www.costa.example').verify('t', onSite)).toBe(true);
    expect(await verifier('www.other.example').verify('t', onSite)).toBe(false);
    expect(await verifier('app.inmolink.es').verify('t', onSite)).toBe(false);
  });

  it('[S1-F5] refuses failures, other actions, bad tokens and outages (fails closed)', async () => {
    const secretKey = 's';
    const ok = { success: true, action: 'login' };
    expect(await createTurnstileVerifier({ secretKey, fetch: reply(200, ok) }).verify('t', { action: 'signup' })).toBe(
      false,
    );
    const failed = reply(200, { success: false, 'error-codes': ['timeout-or-duplicate'] });
    expect(await createTurnstileVerifier({ secretKey, fetch: failed }).verify('t', { action: 'login' })).toBe(false);
    expect(await createTurnstileVerifier({ secretKey, fetch: reply(500, ok) }).verify('t', { action: 'login' })).toBe(
      false,
    );
    const down = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    expect(await createTurnstileVerifier({ secretKey, fetch: down }).verify('t', { action: 'login' })).toBe(false);
    const never = reply(200, ok);
    const v = createTurnstileVerifier({ secretKey, fetch: never });
    expect(await v.verify('', { action: 'login' })).toBe(false);
    expect(await v.verify('x'.repeat(2_049), { action: 'login' })).toBe(false);
  });
});
