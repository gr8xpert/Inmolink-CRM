import { describe, expect, it } from 'vitest';
import { closeEmail, configureEmail, createMemoryMailer, createResendMailer, mailer } from './index';

const message = { to: 'ana@example.com', subject: 'Hello', text: 'Hi', html: '<p>Hi</p>', tag: 'identity.test' };

describe('email adapter', () => {
  it('[S0-09] the memory driver records messages and the process mailer is swappable', async () => {
    const memory = createMemoryMailer();
    await configureEmail(memory);
    await mailer().send(message);
    expect(memory.sent).toEqual([message]);
    await closeEmail();
    expect(() => mailer()).toThrow(/not configured/);
  });

  it('[S0-09] refuses header injection and bad recipients', async () => {
    const memory = createMemoryMailer();
    await expect(memory.send({ ...message, subject: 'Hi\r\nBcc: x@y.z' })).rejects.toThrow(/subject/);
    await expect(memory.send({ ...message, to: 'a@b.c, d@e.f' })).rejects.toThrow(/recipient/);
    await expect(memory.send({ ...message, to: 'not-an-email' })).rejects.toThrow(/recipient/);
    expect(memory.sent).toHaveLength(0);
  });

  it('[S0-09] the resend driver posts JSON with the API key and fails on non-2xx without echoing the body', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const ok = createResendMailer({
      from: 'Inmolink <no-reply@inmolink.test>',
      resendApiKey: 're_test',
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init as RequestInit });
        return new Response(JSON.stringify({ id: 'em_1' }), { status: 200 });
      },
    });
    await expect(ok.send(message)).resolves.toEqual({ id: 'em_1' });
    const [call] = calls;
    if (!call) throw new Error('no request');
    expect(call.url).toBe('https://api.resend.com/emails');
    expect((call.init.headers as Record<string, string>).authorization).toBe('Bearer re_test');
    expect(JSON.parse(String(call.init.body))).toMatchObject({ to: ['ana@example.com'], subject: 'Hello' });

    const failing = createResendMailer({
      from: 'x@inmolink.test',
      resendApiKey: 're_test',
      fetch: async () => new Response('secret detail', { status: 422 }),
    });
    await expect(failing.send(message)).rejects.toThrow('resend send failed (422)');
  });
});
