import { randomBytes } from 'node:crypto';
import { type Browser, expect, type Page, test } from '@playwright/test';
import { SEED_PASSWORD as password, seedListingAgent } from './seed';
import { testStackEnv } from './stack';

/**
 * S12-F1: the network board, chat and notification pages in the browser. Agency A posts a buyer request on the board;
 * agency B replies (which opens a chat thread), A is notified and answers in the thread; then B switches the chat
 * notification type off on the preferences page and a further message raises nothing — until it is switched on again.
 * Realtime is not part of the e2e stack: the pages work from the server render alone (the sockets only add live updates).
 */

const WEB_URL = testStackEnv().WEB_URL as string;

interface Agency {
  page: Page;
}

/** An agent of a verified agency, signed in in a browser context of its own. */
async function signIn(browser: Browser): Promise<Agency> {
  const seeded = await seedListingAgent();
  const context = await browser.newContext({ baseURL: WEB_URL, locale: 'en-GB' });
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByLabel('Email').fill(seeded.email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/en$/);
  return { page };
}

const chatNotifications = (page: Page) => page.getByTestId('notification').filter({ hasText: 'New message from' });

/** Sends a message in the open thread and waits for it to appear (the form posts and the page reloads). */
async function say(page: Page, text: string): Promise<void> {
  await page.getByPlaceholder('Write a message…').fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByTestId('chat-message').filter({ hasText: text })).toBeVisible();
}

test('[S12-F1] board post → reply → chat thread → message → notification; the preferences page switches a type off', async ({
  browser,
}) => {
  const a = await signIn(browser);
  const b = await signIn(browser);
  const tag = randomBytes(3).toString('hex');
  const title = `Looking for a villa ${tag}`;

  // A posts a buyer request with structured criteria.
  await a.page.goto('/en/network/board');
  await expect(a.page.getByRole('heading', { level: 1, name: 'Network board' })).toBeVisible();
  await a.page.getByLabel('Kind').selectOption('BUYER_REQUEST');
  await a.page.getByLabel('Title').fill(title);
  await a.page.getByLabel('Details').fill('Client wants three bedrooms near the sea.');
  await a.page.getByLabel('Price up to (EUR)').first().fill('650000');
  await a.page.getByLabel('Bedrooms from').fill('3');
  await a.page.getByRole('button', { name: 'Post', exact: true }).click();
  await expect(a.page.getByRole('status')).toHaveText('Your post is on the board.');
  await expect(a.page.getByTestId('board-post').filter({ hasText: title })).toContainText('3+ bedrooms');

  // B sees it, with the poster, and replies: the reply opens a chat thread with the first message in it.
  await b.page.goto('/en/network/board');
  const post = b.page.getByTestId('board-post').filter({ hasText: title });
  await expect(post).toBeVisible();
  await post.getByLabel('Reply to the poster').fill(`Hello, we have a match ${tag}`);
  await post.getByRole('button', { name: 'Reply' }).click();
  await expect(b.page).toHaveURL(/\/en\/chat\/[0-9a-f-]{36}$/);
  const threadUrl = b.page.url();
  await expect(b.page.getByTestId('chat-message').filter({ hasText: `we have a match ${tag}` })).toBeVisible();
  // A board thread is not a viewing thread: no "never share the client" warning there, but the handoff links are.
  await expect(b.page.getByTestId('viewing-warning')).toHaveCount(0);
  await expect(b.page.getByRole('link', { name: 'Continue on WhatsApp' })).toBeVisible();
  await expect(b.page.getByRole('link', { name: 'Continue by e-mail' })).toBeVisible();

  // A is told (the worker raises the notification), opens the thread from it, reads the reply and answers.
  await a.page.goto('/en/notifications');
  await expect
    .poll(async () => (await a.page.reload(), chatNotifications(a.page).count()), { timeout: 45_000 })
    .toBe(1);
  await chatNotifications(a.page).first().getByRole('link').click();
  await expect(a.page).toHaveURL(threadUrl);
  await expect(a.page.getByTestId('chat-message').filter({ hasText: `we have a match ${tag}` })).toBeVisible();
  await say(a.page, `Thanks, send details ${tag}`);

  // B sees the answer in the inbox and the thread, and is notified once.
  await b.page.goto('/en/chat');
  await expect(b.page.getByTestId('chat-thread')).toHaveCount(1);
  await b.page.goto(threadUrl);
  await expect(b.page.getByTestId('chat-message').filter({ hasText: `send details ${tag}` })).toBeVisible();
  await b.page.goto('/en/notifications');
  await expect
    .poll(async () => (await b.page.reload(), chatNotifications(b.page).count()), { timeout: 45_000 })
    .toBe(1);

  // B switches chat notifications off: A's next message raises none for B.
  const pref = b.page.getByTestId('pref-CHAT_MESSAGE');
  await pref.getByLabel('On', { exact: true }).uncheck();
  await pref.getByRole('button', { name: 'Save' }).click();
  await expect(b.page.getByRole('status')).toHaveText('Settings saved.');
  await expect(b.page.getByTestId('pref-CHAT_MESSAGE').getByLabel('On', { exact: true })).not.toBeChecked();
  await a.page.goto(threadUrl);
  await say(a.page, `Second message ${tag}`);
  // A positive signal first: B answers, and A (notifications on) is told. The worker handles events in order, so by
  // then it has handled A's second message too, the one that must not notify B.
  await b.page.goto(threadUrl);
  await say(b.page, `Reply while off ${tag}`);
  await a.page.goto('/en/notifications');
  await expect
    .poll(async () => (await a.page.reload(), chatNotifications(a.page).count()), { timeout: 45_000 })
    .toBe(2);
  // B still has the one notification, over a stable window.
  await b.page.goto('/en/notifications');
  for (let i = 0; i < 4; i++) {
    await expect(chatNotifications(b.page)).toHaveCount(1);
    await b.page.waitForTimeout(1_000);
    await b.page.reload();
  }

  // Back on: the next message reaches B again.
  const prefAgain = b.page.getByTestId('pref-CHAT_MESSAGE');
  await prefAgain.getByLabel('On', { exact: true }).check();
  await prefAgain.getByRole('button', { name: 'Save' }).click();
  await expect(b.page.getByRole('status')).toHaveText('Settings saved.');
  // Opening the thread reads it: a message after a read notifies again (earlier unread ones share one notification).
  await b.page.goto(threadUrl);
  await a.page.goto(threadUrl);
  await say(a.page, `Third message ${tag}`);
  await expect
    .poll(async () => (await b.page.reload(), chatNotifications(b.page).count()), { timeout: 45_000 })
    .toBe(2);
});
