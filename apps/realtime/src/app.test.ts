import type { AddressInfo } from 'node:net';
import { createLogger } from '@inmolink/platform/logger';
import { io as connect } from 'socket.io-client';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app';

describe('realtime app', () => {
  it('[S0-08] realtime boots; sockets are refused until auth lands (S0-09)', async () => {
    const realtime = await buildApp({
      logger: createLogger({ level: 'silent' }),
      trustProxy: false,
      checks: { redis: async () => {} },
    });
    await realtime.app.listen({ host: '127.0.0.1', port: 0 });
    const port = (realtime.app.server.address() as AddressInfo).port;
    try {
      expect((await realtime.app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
      const socket = connect(`http://127.0.0.1:${port}`, { transports: ['websocket'], reconnection: false });
      const error = await new Promise<Error>((resolve) => socket.on('connect_error', resolve));
      socket.close();
      expect(error.message).toBe('NOT_AUTHENTICATED');
    } finally {
      await realtime.drain();
    }
    expect(realtime.app.server.listening).toBe(false);
  });
});
