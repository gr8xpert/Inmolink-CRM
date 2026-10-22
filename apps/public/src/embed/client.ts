import { createHash } from 'node:crypto';

/**
 * The embed pages' only script (S7-F8, perf review): no framework, no hydration. Served from 'self' as a static,
 * content-hashed, immutable file (`EMBED_SCRIPT_PATH`). It
 * - gives the enquiry form its `Idempotency-Key` (made here, in the browser — the HTML is the same for every visitor
 *   and CDN-cached);
 * - loads Cloudflare Turnstile on first use of the form (no third-party script on page load); the widget renders into
 *   the form's `.cf-turnstile` and adds `cf-turnstile-response`;
 * - posts the form with `fetch` (`Accept: application/json`) and shows the answer in place; without JavaScript the form
 *   is a plain POST that redirects back with a notice.
 *
 * Self-contained: only browser globals, so `embedClient.toString()` is the shipped source.
 */
export function embedClient(): void {
  const form = document.querySelector<HTMLFormElement>('form[data-embed-lead]');
  if (!form) return;
  const status = form.querySelector<HTMLElement>('[data-embed-status]');
  const button = form.querySelector<HTMLButtonElement>('button[type=submit]');
  const key = form.querySelector<HTMLInputElement>('input[name=idempotencyKey]');
  const newKey = () => {
    if (key) key.value = `embed-${crypto.randomUUID()}`;
  };
  newKey();
  let loaded = false;
  const loadTurnstile = () => {
    if (loaded) return;
    loaded = true;
    const script = document.createElement('script');
    script.src = form.dataset.turnstileScript ?? '';
    script.async = true;
    document.head.appendChild(script);
  };
  form.addEventListener('focusin', loadTurnstile);
  form.addEventListener('pointerenter', loadTurnstile);
  // Messages by answer (`sent`, error codes, `generic`), in the page's language: `data-messages` (JSON).
  let messages: Record<string, string> = {};
  try {
    messages = JSON.parse(form.dataset.messages ?? '{}') as Record<string, string>;
  } catch {
    messages = {};
  }
  const show = (code: string) => {
    if (!status) return;
    status.textContent = messages[code] ?? messages.generic ?? '';
    status.hidden = false;
  };
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (button) button.disabled = true;
    fetch(form.action, {
      method: 'POST',
      headers: { accept: 'application/json' },
      body: new URLSearchParams(new FormData(form) as unknown as Record<string, string>),
    })
      .then((res) => res.json() as Promise<{ status: string; error?: string }>)
      .then((answer) => {
        if (answer.status === 'sent') {
          show('sent');
          for (const el of Array.from(form.querySelectorAll('input,textarea,button,.cf-turnstile'))) {
            (el as HTMLElement).hidden = true;
          }
          return;
        }
        show(answer.error ?? 'generic');
        // A refused body keeps its key (same submission); a spent Turnstile token needs a new challenge.
        (window as unknown as { turnstile?: { reset: () => void } }).turnstile?.reset();
        if (button) button.disabled = false;
      })
      .catch(() => {
        show('generic');
        if (button) button.disabled = false;
      });
  });
}

/** The shipped script. */
export const EMBED_SCRIPT = `(${embedClient.toString()})();\n`;
/** Its content-hashed path: a new script is a new URL, so it is cached for a year (`immutable`). */
export const EMBED_SCRIPT_PATH = `/embed-assets/embed.${createHash('sha256').update(EMBED_SCRIPT).digest('hex').slice(0, 12)}.js`;
