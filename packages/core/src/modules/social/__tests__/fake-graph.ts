import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { allowLoopbackOriginsForTests } from '@inmolink/platform/safe-fetch';
import type { MetaAppConfig } from '../config';

/**
 * A fake Meta Graph API (S12-07 tests; the real one waits on H3): OAuth code and token exchanges, the user's Pages
 * with their Instagram accounts, and the publishing endpoints of Pages and Instagram. Every call is recorded (method,
 * path, form or query fields); `failWith` answers a matching call with an error or drops its connection.
 */

export interface GraphCall {
  method: string;
  path: string;
  fields: Record<string, string>;
}

export type GraphFailure = { status: number; body: unknown } | 'drop';

export interface FakeGraph {
  origin: string;
  app: MetaAppConfig;
  calls: GraphCall[];
  /** The Meta user `GET /me` answers with (S13-F5). */
  userId: string;
  pages: {
    id: string;
    name: string;
    access_token: string;
    instagram_business_account?: { id: string; username: string };
  }[];
  failWith(match: (call: GraphCall) => boolean, failure: GraphFailure, times?: number): void;
  publishes(): GraphCall[];
  close(): Promise<void>;
}

const VERSION = 'v21.0';

export async function startFakeGraph(): Promise<FakeGraph> {
  const calls: GraphCall[] = [];
  const failures: { match: (c: GraphCall) => boolean; failure: GraphFailure; left: number }[] = [];
  let seq = 1_000;
  const fake: Partial<FakeGraph> = { calls, userId: '7000000001', pages: [] };

  const answer = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://fake');
      const fields: Record<string, string> = Object.fromEntries(url.searchParams);
      if (req.method === 'POST')
        Object.assign(fields, Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString())));
      const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
      if (bearer) fields.access_token = bearer;
      // Secrets never travel in a URL (S12-07 review): recorded so tests can check.
      if (url.searchParams.has('access_token') || url.searchParams.has('client_secret')) fields.__secretInUrl = 'yes';
      const path = url.pathname.replace(`/${VERSION}`, '');
      const call: GraphCall = { method: req.method ?? 'GET', path, fields };
      calls.push(call);
      const failure = failures.find((f) => f.left > 0 && f.match(call));
      if (failure) {
        failure.left -= 1;
        if (failure.failure === 'drop') {
          req.socket.destroy();
          return;
        }
        answer(res, failure.failure.status, failure.failure.body);
        return;
      }
      if (path === '/oauth/access_token') {
        if (fields.code) return answer(res, 200, { access_token: `short-${fields.code}`, token_type: 'bearer' });
        if (fields.fb_exchange_token) {
          return answer(res, 200, { access_token: `long-${seq++}`, token_type: 'bearer', expires_in: 5_184_000 });
        }
      }
      if (path === '/me' && req.method === 'GET') return answer(res, 200, { id: fake.userId });
      if (path === '/me/accounts') return answer(res, 200, { data: fake.pages });
      if (path === '/me/permissions' && req.method === 'DELETE') return answer(res, 200, { success: true });
      const m = /^\/(\d+)\/(photos|feed|media|media_publish)$/.exec(path);
      if (m && req.method === 'POST') {
        const id = String(seq++);
        if (m[2] === 'photos')
          return answer(res, 200, { id, ...(fields.published === 'false' ? {} : { post_id: `${m[1]}_${id}` }) });
        if (m[2] === 'feed') return answer(res, 200, { id: `${m[1]}_${id}` });
        return answer(res, 200, { id });
      }
      answer(res, 404, { error: { message: 'Unknown path', type: 'GraphMethodException', code: 100 } });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const undo = allowLoopbackOriginsForTests([origin]);
  return Object.assign(fake, {
    origin,
    app: {
      appId: '123456789',
      appSecret: 'fake-app-secret-0123456789',
      graphUrl: origin,
      dialogUrl: origin,
      graphVersion: VERSION,
      redirectUri: 'http://web.test/social/callback',
    },
    failWith(match: (call: GraphCall) => boolean, failure: GraphFailure, times = 1) {
      failures.push({ match, failure, left: times });
    },
    publishes: () =>
      calls.filter(
        (c) =>
          c.path.endsWith('/media_publish') ||
          c.path.endsWith('/feed') ||
          (c.path.endsWith('/photos') && c.fields.published !== 'false'),
      ),
    async close() {
      undo();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  }) as FakeGraph;
}

/** Meta's answer to an expired or revoked token. */
export const EXPIRED_TOKEN = {
  status: 400,
  body: { error: { message: 'Error validating access token: Session has expired', type: 'OAuthException', code: 190 } },
};
