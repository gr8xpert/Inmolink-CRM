import { describe, expect, it, vi } from 'vitest';
import { browserEnv, checkPdfRenderer, createPuppeteerRenderer } from './index';

/** The `pdf` pool's boot check (S17-F53). No browser needed: what it reports when there is none. */
const logger = () => ({ info: vi.fn(), error: vi.fn() });

describe('PDF browser check at boot (S17-F53)', () => {
  it('[S17-F53] the browser gets no secret of the worker environment', () => {
    expect(
      browserEnv({
        PATH: '/usr/bin',
        HOME: '/tmp',
        DATABASE_URL_APP_PUBLIC: 'postgres://secret',
        S3_SECRET_ACCESS_KEY: 'secret',
        HMAC_KEY: 'secret',
        REDIS_QUEUE_URL: 'redis://secret',
      }),
    ).toEqual({ PATH: '/usr/bin', HOME: '/tmp' });
  });

  it('[S17-F53] a missing browser binary is logged at error level, says what to check, and does not throw', async () => {
    const log = logger();
    const renderer = createPuppeteerRenderer({
      executablePath: '/nonexistent/chromium',
      allowedOrigins: ['https://media.example'],
      concurrency: 1,
      timeoutMs: 5_000,
    });
    await expect(checkPdfRenderer(renderer, log as never)).resolves.toBe(false);
    expect(log.error).toHaveBeenCalledTimes(1);
    const [fields, message] = log.error.mock.calls[0] as [{ err: Error }, string];
    expect(fields.err).toBeInstanceOf(Error);
    expect(message).toContain('the browser is missing or will not start');
    expect(message).toContain('PDF_CHROME_EXECUTABLE');
    expect(log.info).not.toHaveBeenCalled();
    await renderer.close();
  });

  it('[S17-F53] a browser that fails to start (no usable sandbox) is reported the same way', async () => {
    const log = logger();
    const render = vi.fn().mockRejectedValue(new Error('Failed to launch the browser process: No usable sandbox!'));
    await expect(checkPdfRenderer({ render }, log as never)).resolves.toBe(false);
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it('[S17-F53] an answer that is not a PDF is a failure; a PDF logs nothing at error level', async () => {
    const bad = logger();
    await expect(
      checkPdfRenderer({ render: async () => new TextEncoder().encode('<html>') }, bad as never),
    ).resolves.toBe(false);
    expect(bad.error).toHaveBeenCalledTimes(1);

    const good = logger();
    await expect(
      checkPdfRenderer({ render: async () => new TextEncoder().encode('%PDF-1.4\n') }, good as never),
    ).resolves.toBe(true);
    expect(good.error).not.toHaveBeenCalled();
    expect(good.info).toHaveBeenCalledTimes(1);
  });
});
