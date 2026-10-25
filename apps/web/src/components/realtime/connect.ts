import type { Socket } from 'socket.io-client';

/** After this many failed token fetches in a row the socket gives up (no endless retry loop against /session/token). */
const MAX_TOKEN_FAILURES = 3;

/**
 * Opens a Socket.io connection to one realtime namespace (S12-F1), loading socket.io-client on demand so it stays out
 * of the first-load JS. Each (re)connect fetches a fresh 15-minute `realtime` token from the signed-in session; after
 * `MAX_TOKEN_FAILURES` failures in a row the socket is closed and the page keeps working from the server's render.
 * Returns null when the client library could not load. Callers disconnect the socket on cleanup.
 */
export async function connectRealtime(baseUrl: string, namespace: string): Promise<Socket | null> {
  try {
    const { io } = await import('socket.io-client');
    let failures = 0;
    const socket: Socket = io(`${baseUrl}${namespace}`, {
      transports: ['websocket'],
      auth: (cb) => {
        fetch('/session/token?aud=realtime', { cache: 'no-store' })
          .then((r) => (r.ok ? (r.json() as Promise<{ token?: unknown }>) : Promise.reject(new Error('token'))))
          .then((d) => {
            if (typeof d.token !== 'string') throw new Error('token');
            failures = 0;
            cb({ token: d.token });
          })
          .catch(() => {
            failures += 1;
            // No token to offer: stop here instead of knocking on the realtime service with an empty one.
            if (failures >= MAX_TOKEN_FAILURES) socket.disconnect();
            else cb({ token: '' });
          });
      },
    });
    return socket;
  } catch {
    return null;
  }
}
