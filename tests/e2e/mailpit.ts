import { MAILPIT_URL } from './stack';

interface Summary {
  ID: string;
  Subject: string;
  Created: string;
}

/**
 * Waits for the newest email to `to` whose subject matches, via the Mailpit API (test profile), and
 * returns the first link in its text body.
 */
export async function waitForLink(to: string, subject: RegExp, timeoutMs = 60_000): Promise<URL> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
    if (res.ok) {
      const { messages } = (await res.json()) as { messages: Summary[] };
      const hit = messages.filter((m) => subject.test(m.Subject)).sort((a, b) => b.Created.localeCompare(a.Created))[0];
      if (hit) {
        const message = (await (await fetch(`${MAILPIT_URL}/api/v1/message/${hit.ID}`)).json()) as { Text: string };
        const href = /https?:\/\/\S+/.exec(message.Text)?.[0];
        if (href) return new URL(href);
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no email to ${to} matching ${subject} within ${timeoutMs} ms`);
}

/** Number of emails Mailpit holds for `to` with a matching subject. */
export async function countEmails(to: string, subject: RegExp): Promise<number> {
  const res = await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
  const { messages } = (await res.json()) as { messages: Summary[] };
  return messages.filter((m) => subject.test(m.Subject)).length;
}
