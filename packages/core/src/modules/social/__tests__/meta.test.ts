import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MetaError, MetaGraphClient } from '../meta';
import { EXPIRED_TOKEN, type FakeGraph, startFakeGraph } from './fake-graph';

/** The Meta Graph client against a fake Graph server (S12-07; the real Meta app waits on H3). */

let graph: FakeGraph;
let client: MetaGraphClient;
const IMG = (n: number) => `https://media.example/og/${n}.jpg`;

beforeAll(async () => {
  graph = await startFakeGraph();
  client = new MetaGraphClient(graph.app);
});

beforeEach(() => {
  graph.calls.length = 0;
  graph.pages = [
    {
      id: '111',
      name: 'Costa Homes',
      access_token: 'page-token-111',
      instagram_business_account: { id: '222', username: 'costahomes' },
    },
    { id: '333', name: 'Second Page', access_token: 'page-token-333' },
  ];
});

afterAll(async () => {
  await graph.close();
});

async function metaError(promise: Promise<unknown>): Promise<MetaError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof MetaError) return err;
    throw err;
  }
  throw new Error('no error');
}

describe('Meta Graph client (S12-07)', () => {
  it('[S12-07] connect: the dialog URL, code → long-lived user token → Pages with their Instagram accounts', async () => {
    const dialog = new URL(client.dialogUrl('signed-state'));
    expect(dialog.pathname).toBe('/v21.0/dialog/oauth');
    expect(dialog.searchParams.get('state')).toBe('signed-state');
    expect(dialog.searchParams.get('redirect_uri')).toBe(graph.app.redirectUri);
    expect(dialog.searchParams.get('scope')).toContain('instagram_content_publish');
    const user = await client.userTokenFromCode('the-code');
    expect(user.accessToken).toMatch(/^long-/);
    expect(user.expiresIn).toBe(5_184_000);
    const pages = await client.pages(user.accessToken);
    expect(pages).toEqual([
      {
        id: '111',
        name: 'Costa Homes',
        accessToken: 'page-token-111',
        instagram: { id: '222', username: 'costahomes' },
      },
      { id: '333', name: 'Second Page', accessToken: 'page-token-333', instagram: null },
    ]);
    // The short-lived token was exchanged for a long-lived one; Pages are read with appsecret_proof.
    const exchange = graph.calls.find((c) => c.fields.fb_exchange_token);
    expect(exchange?.fields.fb_exchange_token).toBe('short-the-code');
    const accounts = graph.calls.find((c) => c.path === '/me/accounts');
    expect(accounts?.fields.appsecret_proof).toBe(
      createHmac('sha256', graph.app.appSecret).update(user.accessToken).digest('hex'),
    );
    // S12-07 review: no secret or token in any URL — exchanges are form POSTs, reads carry a bearer header.
    for (const c of graph.calls) expect(c.fields.__secretInUrl, c.path).toBeUndefined();
    expect(graph.calls.filter((c) => c.path === '/oauth/access_token').map((c) => c.method)).toEqual(['POST', 'POST']);
    expect(accounts?.fields.access_token).toBe(user.accessToken);
    // Revoking the app's permissions for that login.
    await client.revokePermissions(user.accessToken);
    expect(graph.calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/me/permissions' });
    expect(graph.calls.at(-1)?.fields.__secretInUrl).toBeUndefined();
  });

  it('[S12-07] Facebook: one image is a photo post; several are unpublished photos attached to one feed post', async () => {
    const one = await client.publishFacebook('111', 'page-token-111', { caption: 'Hello', imageUrls: [IMG(1)] });
    expect(one.externalId).toMatch(/^111_\d+$/);
    const many = await client.publishFacebook('111', 'page-token-111', {
      caption: 'Carousel',
      imageUrls: [IMG(1), IMG(2), IMG(3)],
    });
    expect(many.externalId).toMatch(/^111_\d+$/);
    const feed = graph.calls.find((c) => c.path === '/111/feed');
    expect(feed?.fields.message).toBe('Carousel');
    expect(Object.keys(feed?.fields ?? {}).filter((k) => k.startsWith('attached_media'))).toHaveLength(3);
    expect(graph.publishes()).toHaveLength(2);
    // Tokens travel in the POST body, never in the URL.
    for (const c of graph.calls) expect(c.path).not.toContain('page-token');
  });

  it('[S12-07] Instagram: one container, or a carousel of item containers, then media_publish once', async () => {
    const one = await client.publishInstagram('222', 'page-token-111', { caption: 'Hi', imageUrls: [IMG(1)] });
    expect(one.externalId).toMatch(/^\d+$/);
    await client.publishInstagram('222', 'page-token-111', { caption: 'Carousel', imageUrls: [IMG(1), IMG(2)] });
    const carousel = graph.calls.find((c) => c.fields.media_type === 'CAROUSEL');
    expect(carousel?.fields.children?.split(',')).toHaveLength(2);
    expect(carousel?.fields.caption).toBe('Carousel');
    expect(graph.calls.filter((c) => c.path === '/222/media_publish')).toHaveLength(2);
  });

  it('[S12-07] errors: expired token, rate limit, refusal; a dropped publishing call is ambiguous', async () => {
    graph.failWith((c) => c.path === '/111/photos', EXPIRED_TOKEN);
    const expired = await metaError(client.publishFacebook('111', 't', { caption: 'x', imageUrls: [IMG(1)] }));
    expect(expired).toMatchObject({ kind: 'TOKEN_EXPIRED', retryable: false, ambiguous: false });
    graph.failWith((c) => c.path === '/222/media', {
      status: 400,
      body: { error: { code: 613, message: 'slow down' } },
    });
    expect(await metaError(client.publishInstagram('222', 't', { caption: 'x', imageUrls: [IMG(1)] }))).toMatchObject({
      kind: 'RATE_LIMITED',
      retryable: true,
      ambiguous: false,
    });
    graph.failWith((c) => c.path === '/222/media', { status: 400, body: { error: { code: 36003, message: 'ratio' } } });
    expect(await metaError(client.publishInstagram('222', 't', { caption: 'x', imageUrls: [IMG(1)] }))).toMatchObject({
      kind: 'REJECTED',
      message: 'ratio',
    });
    // The container is made, the publishing call's connection drops: the post may be live.
    graph.failWith((c) => c.path === '/222/media_publish', 'drop');
    expect(await metaError(client.publishInstagram('222', 't', { caption: 'x', imageUrls: [IMG(1)] }))).toMatchObject({
      kind: 'NETWORK',
      ambiguous: true,
    });
    // A dropped call before the publishing one is not.
    graph.failWith((c) => c.path === '/222/media', 'drop');
    expect(await metaError(client.publishInstagram('222', 't', { caption: 'x', imageUrls: [IMG(1)] }))).toMatchObject({
      kind: 'NETWORK',
      ambiguous: false,
    });
  });
});
