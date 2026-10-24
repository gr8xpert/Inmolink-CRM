import type { FastifyReply } from 'fastify';
import { describe, expect, it } from 'vitest';
import { sendError, sqlState } from './errors';

/** A reply that records its status, headers and body. */
function fakeReply() {
  const seen: { status?: number; headers: Record<string, string>; body?: unknown } = { headers: {} };
  const reply = {
    code(s: number) {
      seen.status = s;
      return reply;
    },
    header(k: string, v: string) {
      seen.headers[k] = v;
      return reply;
    },
    send(b: unknown) {
      seen.body = b;
      return reply;
    },
  };
  return { reply: reply as unknown as FastifyReply, seen };
}

describe('error handler helpers', () => {
  it('[S1-09] unmapped database errors are logged with their SQLSTATE, also when wrapped', () => {
    expect(sqlState(Object.assign(new Error('canceling statement'), { code: '57014' }))).toBe('57014');
    expect(sqlState(new Error('Failed query', { cause: Object.assign(new Error('dup'), { code: '23505' }) }))).toBe(
      '23505',
    );
    expect(sqlState(Object.assign(new Error('x'), { code: 'FST_ERR_BAD_URL' }))).toBeUndefined();
    expect(sqlState('nope')).toBeUndefined();
  });

  it('[S12-F25] an error with a finite retryAfterSeconds sets Retry-After; others do not', () => {
    const limited = fakeReply();
    sendError(limited.reply, 'RATE_LIMITED', { retryAfterSeconds: 41.2 });
    expect(limited.seen.status).toBe(429);
    expect(limited.seen.headers['retry-after']).toBe('42');
    expect(limited.seen.body).toMatchObject({ error: { code: 'RATE_LIMITED', details: { retryAfterSeconds: 41.2 } } });
    const others = [
      undefined,
      {},
      { retryAfterSeconds: Number.NaN },
      { retryAfterSeconds: -1 },
      { retryAfterSeconds: '5' },
    ];
    for (const details of others) {
      const other = fakeReply();
      sendError(other.reply, 'RATE_LIMITED', details);
      expect(other.seen.headers['retry-after'], JSON.stringify(details)).toBeUndefined();
    }
  });
});
