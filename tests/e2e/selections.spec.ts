import { randomBytes } from 'node:crypto';
import { type APIRequestContext, type Browser, expect, type Page, test } from '@playwright/test';
import { SEED_PASSWORD as password, seedListingAgent, TAXONOMY_IDS } from './seed';
import { PUBLIC_URL, testStackEnv } from './stack';

/**
 * S12 exit criterion (PLAN §16): "Selection shows new price within 5 min of owner edit" — on the real stack: the api
 * writes, the worker's outbox rebuilds the read models, apps/public renders `/s/<token>` from them. Selections have no
 * dashboard UI yet (S12-04 shipped the API), so the agent creates one with its own session token. Plus the S12-06
 * Client Mode flow in the dashboard.
 */

const env = testStackEnv();
const API_URL = env.API_URL as string;
const WEB_URL = env.WEB_URL as string;
const NETWORK = { propertyTypeId: TAXONOMY_IDS.type, locationId: TAXONOMY_IDS.location } as const;

interface Agent {
  email: string;
  company: string;
  agencyId: string;
  page: Page;
  token: string;
}

/** An agent of a verified agency, signed in in its own browser context; its API token comes from the web session. */
async function signIn(browser: Browser): Promise<Agent> {
  const seeded = await seedListingAgent();
  const context = await browser.newContext({ baseURL: WEB_URL, locale: 'en-GB' });
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByLabel('Email').fill(seeded.email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/en$/);
  const minted = await page.request.get('/session/token?aud=api');
  expect(minted.status()).toBe(200);
  const { token } = (await minted.json()) as { token: string };
  return { email: seeded.email, company: seeded.company, agencyId: seeded.agencyId, page, token };
}

function client(request: APIRequestContext, who: Agent) {
  const headers = { authorization: `Bearer ${who.token}` };
  return {
    get: (path: string) => request.get(`${API_URL}${path}`, { headers }),
    post: (path: string, data: unknown, extra: Record<string, string> = {}) =>
      request.post(`${API_URL}${path}`, { headers: { ...headers, ...extra }, data }),
    patch: (path: string, data: unknown) => request.patch(`${API_URL}${path}`, { headers, data }),
    put: (path: string, data: unknown) => request.put(`${API_URL}${path}`, { headers, data }),
  };
}
type Api = ReturnType<typeof client>;

async function json<T>(res: Awaited<ReturnType<Api['get']>>, status: number): Promise<T> {
  expect(res.status(), `${res.url()} answered ${res.status()}: ${await res.text()}`).toBe(status);
  return (await res.json()) as T;
}

interface Listing {
  id: string;
  ref: string;
  version: number;
}

/** An ACTIVE listing on the agency's site and the network (PUBLIC, shared with all), titled in English. */
async function publishListing(
  api: Api,
  input: { title: string; priceCents: number; internalNotes?: string },
): Promise<Listing> {
  const created = await json<Listing>(await api.post('/v1/listings', NETWORK), 201);
  await json(
    await api.put(`/v1/listings/${created.id}/translations/en`, { version: created.version, title: input.title }),
    200,
  );
  const current = await json<Listing>(await api.get(`/v1/listings/${created.id}`), 200);
  return json<Listing>(
    await api.patch(`/v1/listings/${created.id}`, {
      version: current.version,
      status: 'ACTIVE',
      visibility: 'PUBLIC',
      shareScope: 'ALL',
      // A PUBLIC listing needs its energy certificate rating.
      energyRating: 'B',
      priceCents: input.priceCents,
      commission: { type: 'PCT', basisPoints: 300, includesVat: false },
      splitBp: 5_000,
      ...(input.internalNotes ? { internalNotes: input.internalNotes } : {}),
    }),
    200,
  );
}

test('[S12-04] a selection with an own and a network listing shows both prices white-labelled; the owner’s new price shows within 5 minutes', async ({
  browser,
  request,
}) => {
  test.setTimeout(8 * 60_000);
  const tag = randomBytes(3).toString('hex');
  const [a, b] = [await signIn(browser), await signIn(browser)];
  const [apiA, apiB] = [client(request, a), client(request, b)];

  const own = await publishListing(apiA, { title: `Own villa ${tag}`, priceCents: 61_000_000 });
  const network = await publishListing(apiB, { title: `Network villa ${tag}`, priceCents: 45_000_000 });
  const contact = await json<{ id: string }>(
    await apiA.post(
      '/v1/crm/contacts',
      { firstName: 'Ana', lastName: `Sel${tag}`, emails: [`ana-${tag}@example.com`], consentProcessing: true },
      { 'idempotency-key': `e2e-contact-${randomBytes(8).toString('hex')}` },
    ),
    201,
  );

  // The read models are built by the worker (outbox): until then the network item cannot be picked or shows nothing.
  let created: { selection: { id: string }; share: { token: string; path: string; url: string | null } } | undefined;
  await expect
    .poll(
      async () => {
        const res = await apiA.post('/v1/selections', {
          title: `Villas for Ana ${tag}`,
          message: 'My picks',
          locale: 'en',
          contactId: contact.id,
          items: [{ targetId: own.id }, { targetId: network.id }],
        });
        if (res.status() === 201) created = await res.json();
        return res.status();
      },
      { timeout: 60_000, intervals: [1_000, 2_000] },
    )
    .toBe(201);
  if (!created) throw new Error('no selection');
  const shareUrl = created.share.url as string;
  expect(shareUrl).toBe(`${PUBLIC_URL}${created.share.path}`);

  // The client's view: a fresh browser, no dashboard session.
  const visitor = await (await browser.newContext({ locale: 'en-GB' })).newPage();
  const priceOf = (id: string) => visitor.locator(`#item-${id} .embed-price`);
  await expect
    .poll(
      async () => {
        await visitor.goto(shareUrl);
        return [await priceOf(own.id).textContent(), await priceOf(network.id).textContent()];
      },
      { timeout: 60_000, intervals: [1_000, 2_000] },
    )
    .toEqual(['€610,000', '€450,000']);
  await expect(visitor.getByRole('heading', { level: 1, name: `Villas for Ana ${tag}` })).toBeVisible();
  // White label: the client never learns the network listing's agency, its agent or its reference.
  const html = await visitor.content();
  expect(html).not.toContain(b.company);
  expect(html).not.toContain(b.email);
  expect(html).not.toContain(b.agencyId);
  expect(html).not.toContain(network.ref);

  // The owner edits the price; the page (never cached) shows it once the worker rebuilt the read model.
  const current = await json<Listing>(await apiB.get(`/v1/listings/${network.id}`), 200);
  await json(await apiB.patch(`/v1/listings/${network.id}`, { version: current.version, priceCents: 39_900_000 }), 200);
  const edited = Date.now();
  await expect
    .poll(
      async () => {
        await visitor.reload();
        return priceOf(network.id).textContent();
      },
      { timeout: 5 * 60_000, intervals: [1_000, 2_000, 5_000] },
    )
    .toBe('€399,000');
  test.info().annotations.push({ type: 'price-latency-ms', description: String(Date.now() - edited) });
  await expect(priceOf(own.id)).toHaveText('€610,000');
  expect(await visitor.content()).not.toContain(b.company);
});

test('[S12-06] Client Mode: started with a PIN, a listing shows no commission or internal fields, no logout; the PIN ends it', async ({
  browser,
  request,
}) => {
  const tag = randomBytes(3).toString('hex');
  const a = await signIn(browser);
  const notes = `Keys at the neighbour ${tag}`;
  const listing = await publishListing(client(request, a), {
    title: `Client villa ${tag}`,
    priceCents: 72_000_000,
    internalNotes: notes,
  });
  const { page } = a;
  const commission = () => page.getByLabel('Commission (%)', { exact: true });

  // Before: the agent sees the commission and the internal notes.
  await page.goto(`/en/listings/${listing.id}`);
  await expect(commission()).toHaveValue('3');
  await expect(page.getByLabel('Internal notes', { exact: true })).toHaveValue(notes);

  const pin = '482916';
  await page.getByRole('button', { name: 'Show to a client' }).click();
  await page.getByLabel('PIN (digits)').fill(pin);
  await page.getByLabel('Repeat the PIN').fill(pin);
  await page.getByRole('button', { name: 'Start Client Mode' }).click();
  await expect(page).toHaveURL(/\/en\/listings$/);
  const banner = page.getByTestId('client-mode-banner');
  await expect(banner).toBeVisible();
  await expect(page.getByRole('button', { name: 'Log out' })).toHaveCount(0);

  await page.goto(`/en/listings/${listing.id}`);
  await expect(page.getByLabel('Price', { exact: true })).toHaveValue('720000');
  await expect(commission()).toHaveCount(0);
  await expect(page.getByLabel('Split to the collaborating agent (%)', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Internal notes', { exact: true })).toHaveCount(0);
  expect(await page.content()).not.toContain(notes);
  await expect(banner).toBeVisible();
  await expect(page.getByRole('button', { name: 'Log out' })).toHaveCount(0);

  // A wrong PIN keeps it on; the right one ends it.
  await banner.getByPlaceholder('PIN to leave').fill('000000');
  await banner.getByRole('button', { name: 'Leave Client Mode' }).click();
  await expect(banner.getByRole('alert')).toBeVisible();
  await banner.getByPlaceholder('PIN to leave').fill(pin);
  await banner.getByRole('button', { name: 'Leave Client Mode' }).click();
  await expect(page.getByTestId('client-mode-banner')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();
  await page.goto(`/en/listings/${listing.id}`);
  await expect(commission()).toHaveValue('3');
});
