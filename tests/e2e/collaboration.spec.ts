import { randomBytes } from 'node:crypto';
import { type APIRequestContext, type Browser, expect, type Page, test } from '@playwright/test';
import { SEED_PASSWORD as password, seedListingAgent, TAXONOMY_IDS } from './seed';
import { testStackEnv } from './stack';

/**
 * S11 exit criterion (PLAN §16): the full collaboration flow. Registrations, viewing requests, chat, notifications and
 * the network board have no UI yet but the "My collaborations" page, so the flow runs on the API with each agency's own
 * browser session (the same 15-minute token the dashboard uses); the page is checked in B's browser.
 *
 * A: the owner of a SHARED, ACTIVE listing with commission and split. B: the introducer, with a listing of its own that
 * a buyer request of A matches. C: a third agency that tries to register B's client.
 */

const env = testStackEnv();
const API_URL = env.API_URL as string;
const WEB_URL = env.WEB_URL as string;

interface Agency {
  email: string;
  page: Page;
  token: string;
}

const NETWORK = { propertyTypeId: TAXONOMY_IDS.type, locationId: TAXONOMY_IDS.location } as const;

/** An agent of a verified agency, signed in in a browser context of its own; its API token comes from the web session. */
async function signIn(browser: Browser): Promise<Agency> {
  const seeded = await seedListingAgent();
  const context = await browser.newContext({ baseURL: WEB_URL, locale: 'en-GB' });
  const page = await context.newPage();
  await page.goto('/login');
  await page.request.get('/en');
  await page.getByLabel('Email').fill(seeded.email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/en$/);
  const minted = await page.request.get('/session/token?aud=api');
  expect(minted.status()).toBe(200);
  const { token } = (await minted.json()) as { token: string };
  return { email: seeded.email, page, token };
}

/** A thin typed client over the API for one agency. */
function client(request: APIRequestContext, who: Agency) {
  const headers = { authorization: `Bearer ${who.token}` };
  return {
    get: (path: string) => request.get(`${API_URL}${path}`, { headers }),
    post: (path: string, data?: unknown, extra: Record<string, string> = {}) =>
      request.post(`${API_URL}${path}`, { headers: { ...headers, ...extra }, ...(data === undefined ? {} : { data }) }),
    patch: (path: string, data: unknown) => request.patch(`${API_URL}${path}`, { headers, data }),
  };
}
type Api = ReturnType<typeof client>;

async function json<T>(res: Awaited<ReturnType<Api['get']>>, status: number | number[]): Promise<T> {
  const ok = Array.isArray(status) ? status : [status];
  expect(ok, `${res.url()} answered ${res.status()}: ${await res.text()}`).toContain(res.status());
  return (await res.json()) as T;
}

interface Listing {
  id: string;
  ref: string;
  version: number;
}

/** An ACTIVE, SHARED sale listing with a commission (3 %) and a 50 % split, in the e2e taxonomy. */
async function shareListing(api: Api): Promise<Listing> {
  const created = await json<Listing>(await api.post('/v1/listings', NETWORK), 201);
  return json<Listing>(
    await api.patch(`/v1/listings/${created.id}`, {
      version: created.version,
      status: 'ACTIVE',
      visibility: 'SHARED',
      priceCents: 50_000_000,
      commission: { type: 'PCT', basisPoints: 300, includesVat: false },
      splitBp: 5_000,
    }),
    200,
  );
}

interface Notification {
  id: string;
  type: string;
  params: Record<string, string | number>;
  link: string | null;
}

/** The caller's notifications of a type, waiting (the worker raises some) until there is one. */
async function notificationOf(api: Api, type: string, timeout = 45_000): Promise<Notification> {
  let found: Notification | undefined;
  await expect
    .poll(
      async () => {
        const page = await json<{ items: Notification[] }>(await api.get('/v1/notifications?limit=100'), 200);
        found = page.items.find((n) => n.type === type);
        return found?.type;
      },
      { timeout, intervals: [500, 1_000, 2_000] },
    )
    .toBe(type);
  return found as Notification;
}

interface Registration {
  id: string;
  contactId: string;
  client: { firstName: string | null; lastName: string | null };
  target: { kind: string; id: string };
  ownerAgencyId: string;
  state: string;
}
interface Viewing {
  id: string;
  side: string;
  status: string;
  awaiting: string | null;
  registrationId: string | null;
  contactId: string | null;
  proposedStartAt: string;
  scheduledAt: string | null;
  terms: { commissionBp: number | null; splitBp: number; accepted: boolean; ownerAcceptedAt: string | null };
}

test('[S11] full collaboration flow: register a client, request a viewing, accept the terms, chat, see it in My collaborations; a buyer request on the network board notifies the matching agency', async ({
  browser,
  request,
}) => {
  const tag = randomBytes(3).toString('hex');
  const [a, b, c] = [await signIn(browser), await signIn(browser), await signIn(browser)];
  const [apiA, apiB, apiC] = [client(request, a), client(request, b), client(request, c)];

  // A shares a listing with commission and split; B has a listing of its own (matched by A's buyer request below).
  const listingA = await shareListing(apiA);
  const listingB = await shareListing(apiB);

  // ---- B registers a client for A's listing ------------------------------------------------------------------------
  const clientEmail = `buyer-${tag}@example.com`;
  const contactOf = async (api: Api) =>
    json<{ id: string }>(
      await api.post(
        '/v1/crm/contacts',
        { firstName: 'Ines', lastName: `Collab${tag}`, emails: [clientEmail], consentProcessing: true },
        { 'idempotency-key': `e2e-contact-${randomBytes(8).toString('hex')}` },
      ),
      201,
    );
  const contactB = await contactOf(apiB);
  const target = { kind: 'LISTING', id: listingA.id };
  const registration = await json<Registration>(
    await apiB.post('/v1/mls/registrations', { contactId: contactB.id, target }),
    201,
  );
  expect(registration).toMatchObject({ contactId: contactB.id, target, state: 'ACTIVE' });
  expect(registration.client.lastName).toBe(`Collab${tag}`);
  // The same agency registering the same client again answers its registration (nothing new).
  const again = await json<Registration>(
    await apiB.post('/v1/mls/registrations', { contactId: contactB.id, target }),
    200,
  );
  expect(again.id).toBe(registration.id);

  // Another agency registering the same client (same e-mail) for the same listing: first valid registration wins.
  const contactC = await contactOf(apiC);
  const conflict = await apiC.post('/v1/mls/registrations', { contactId: contactC.id, target });
  expect(conflict.status()).toBe(409);
  expect(await conflict.json()).toMatchObject({ error: { code: 'REGISTRATION_CONFLICT' } });

  // A sees who registered a client and until when, never the client.
  const received = await json<{ items: Array<Record<string, unknown>> }>(
    await apiA.get('/v1/mls/received-registrations?limit=100'),
    200,
  );
  const receipt = received.items.find((r) => r.id === registration.id);
  expect(receipt).toMatchObject({ target, state: 'ACTIVE' });
  expect(JSON.stringify(receipt)).not.toContain(`Collab${tag}`);
  expect(JSON.stringify(receipt)).not.toContain(clientEmail);

  // ---- B requests a viewing: the target's terms are snapshotted ---------------------------------------------------
  const proposedStartAt = new Date(Date.now() + 3 * 24 * 3_600_000).toISOString();
  const requested = await json<Viewing>(
    await apiB.post(
      '/v1/mls/viewing-requests',
      { registrationId: registration.id, proposedStartAt },
      { 'idempotency-key': `e2e-viewing-${randomBytes(8).toString('hex')}` },
    ),
    201,
  );
  expect(requested).toMatchObject({
    side: 'INTRODUCER',
    status: 'REQUESTED',
    awaiting: 'OWNER',
    registrationId: registration.id,
  });
  expect(requested.terms).toMatchObject({ commissionBp: 300, splitBp: 5_000, accepted: false, ownerAcceptedAt: null });

  // The owner is told, sees the request without the client, and accepts it (and with it the terms).
  const viewingNotice = await notificationOf(apiA, 'VIEWING_REQUESTED');
  expect(JSON.stringify(viewingNotice)).not.toContain(`Collab${tag}`);
  const seenByA = await json<Viewing>(await apiA.get(`/v1/mls/viewing-requests/${requested.id}`), 200);
  expect(seenByA).toMatchObject({ side: 'OWNER', status: 'REQUESTED', registrationId: null, contactId: null });
  expect(JSON.stringify(seenByA)).not.toContain(`Collab${tag}`);
  const accepted = await json<Viewing>(await apiA.post(`/v1/mls/viewing-requests/${requested.id}/accept`), 200);
  expect(accepted).toMatchObject({ side: 'OWNER', status: 'SCHEDULED', awaiting: null });
  expect(accepted.scheduledAt).not.toBeNull();

  // Both sides hold the same accepted terms, and they no longer change with the listing.
  const termsOf = async (api: Api) =>
    json<{ requestId: string; target: unknown; terms: Viewing['terms'] & Record<string, unknown> }>(
      await api.get(`/v1/mls/viewing-requests/${requested.id}/terms`),
      200,
    );
  const [termsA, termsB] = [await termsOf(apiA), await termsOf(apiB)];
  expect(termsA.terms).toMatchObject({ commissionBp: 300, splitBp: 5_000, accepted: true });
  expect(termsA.terms.ownerAcceptedAt).not.toBeNull();
  // Same terms on both sides; each side sees only its own accepting member, never the counterpart's (white label).
  const {
    introducerAcceptedByUserId: introducerSeenByA,
    ownerAcceptedByUserId: ownerSeenByA,
    ...sharedA
  } = termsA.terms;
  const {
    introducerAcceptedByUserId: introducerSeenByB,
    ownerAcceptedByUserId: ownerSeenByB,
    ...sharedB
  } = termsB.terms;
  expect(sharedB).toEqual(sharedA);
  expect(termsB).toMatchObject({ requestId: termsA.requestId, target: termsA.target });
  expect(ownerSeenByA).not.toBeNull();
  expect(introducerSeenByA).toBeNull();
  expect(introducerSeenByB).not.toBeNull();
  expect(ownerSeenByB).toBeNull();
  // The listing as it stands now (its version is the PATCH's answer above unless something wrote it since).
  const current = await json<Listing>(await apiA.get(`/v1/listings/${listingA.id}`), 200);
  const repriced = await json<Listing>(
    await apiA.patch(`/v1/listings/${listingA.id}`, {
      version: current.version,
      commission: { type: 'PCT', basisPoints: 500, includesVat: false },
      splitBp: 4_000,
    }),
    200,
  );
  expect(repriced.version).toBeGreaterThan(current.version);
  expect((await termsOf(apiB)).terms).toMatchObject({ commissionBp: 300, splitBp: 5_000, accepted: true });
  // B sees the scheduled viewing as the introducer.
  const seenByB = await json<Viewing>(await apiB.get(`/v1/mls/viewing-requests/${requested.id}`), 200);
  expect(seenByB).toMatchObject({ side: 'INTRODUCER', status: 'SCHEDULED', registrationId: registration.id });

  // ---- chat in the viewing's thread --------------------------------------------------------------------------------
  const threadB = await json<{ id: string }>(
    await apiB.post('/v1/chat/viewing-threads', { viewingRequestId: requested.id }),
    200,
  );
  // A joins its side (the owner's default member is seated by the worker), then B writes: A is notified.
  const threadA = await json<{ id: string }>(
    await apiA.post('/v1/chat/viewing-threads', { viewingRequestId: requested.id }),
    200,
  );
  expect(threadA.id).toBe(threadB.id);
  const text = `Shall we meet at the gate? ${tag}`;
  const sent = await json<{ message: { body: string; sender: { ownAgency: boolean } }; replayed: boolean }>(
    await apiB.post(`/v1/chat/threads/${threadB.id}/messages`, { body: text, clientKey: crypto.randomUUID() }),
    201,
  );
  expect(sent.message).toMatchObject({ body: text, sender: { ownAgency: true } });
  const messages = await json<{ items: Array<{ body: string; sender: { ownAgency: boolean } }> }>(
    await apiA.get(`/v1/chat/threads/${threadB.id}/messages`),
    200,
  );
  expect(messages.items.find((m) => m.body === text)).toMatchObject({ sender: { ownAgency: false } });
  await notificationOf(apiA, 'CHAT_MESSAGE');

  // ---- My collaborations (B's dashboard) ---------------------------------------------------------------------------
  await b.page.goto('/en/collaborations');
  await expect(b.page.getByRole('heading', { level: 1, name: 'My collaborations' })).toBeVisible();
  const targetCode = `${listingA.id.slice(0, 8)}`;
  const outRegistrations = b.page.getByTestId('section-outRegistrations');
  await expect(outRegistrations).toContainText(`Ines Collab${tag}`);
  await expect(outRegistrations).toContainText(targetCode);
  await expect(outRegistrations).toContainText('Active');
  const outViewings = b.page.getByTestId('section-outViewings');
  await expect(outViewings).toContainText(targetCode);
  await expect(outViewings).toContainText('Scheduled');
  // The owner's side lists the received ones, introducer named, never the client.
  await a.page.goto('/en/collaborations');
  const inViewings = a.page.getByTestId('section-inViewings');
  await expect(inViewings).toContainText(targetCode);
  await expect(inViewings).toContainText('Scheduled');
  await expect(a.page.getByTestId('section-inRegistrations')).not.toContainText(`Collab${tag}`);

  // ---- network board: A's buyer request notifies B, whose listing matches ------------------------------------------
  // The match runs in the worker over the search index, which B's listing reaches through the outbox: a request posted
  // before that finds nothing, so a new one is posted until B is told (each is its own post and notification).
  let match: Notification | undefined;
  for (let attempt = 1; attempt <= 4 && !match; attempt++) {
    const post = await json<{ id: string; kind: string; own: boolean }>(
      await apiA.post(
        '/v1/network/posts',
        {
          kind: 'BUYER_REQUEST',
          title: `Buyer looking for a villa ${tag} #${attempt}`,
          body: 'A client wants a villa in the e2e area.',
          criteria: {
            transactionType: 'SALE',
            propertyTypeIds: [TAXONOMY_IDS.type],
            locationIds: [TAXONOMY_IDS.location],
          },
        },
        { 'idempotency-key': `e2e-post-${tag}-${attempt}-${randomBytes(4).toString('hex')}` },
      ),
      201,
    );
    expect(post).toMatchObject({ kind: 'BUYER_REQUEST', own: true });
    try {
      match = await notificationOf(apiB, 'NETWORK_MATCH', 20_000);
    } catch {
      // not indexed yet: post again
    }
  }
  if (!match) throw new Error('B was not told of the buyer request that matches its listing');
  expect(Number(match.params.count)).toBeGreaterThanOrEqual(1);
  // B's own matching listing is named by its reference (an 8-character ref never reads like a phone number).
  expect(String(match.params.refs)).toContain(listingB.ref);
  // The asker learns nothing of who matched (white label).
  const unreadA = await json<{ items: Notification[] }>(await apiA.get('/v1/notifications?limit=100'), 200);
  expect(unreadA.items.some((n) => n.type === 'NETWORK_MATCH')).toBe(false);
});
