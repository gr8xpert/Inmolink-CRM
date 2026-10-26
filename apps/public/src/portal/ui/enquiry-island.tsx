'use client';

import { useEffect } from 'react';

/**
 * The enquiry form's behaviour (S15-02), a tiny island: the markup is the server's (`EnquiryForm`, the same HTML for
 * every visitor and CDN-cached), so this only
 * - gives the form its idempotency key (made here, in the browser);
 * - loads Cloudflare Turnstile on first use of the form (no third-party script on page load); the widget renders into
 *   the form's `.cf-turnstile` and adds `cf-turnstile-response`;
 * - posts the form with `fetch` (`Accept: application/json`) and shows the answer in place;
 * - shows the answer of a plain (no-JavaScript) post, which comes back as `?enquiry=<result>`.
 * Messages come from the form's `data-messages` (the page's language).
 */
export function EnquiryIsland(props: { formId: string }) {
  useEffect(() => {
    const form = document.getElementById(props.formId) as HTMLFormElement | null;
    if (!form) return;
    const status = form.querySelector<HTMLElement>('[data-enquiry-status]');
    const fields = form.querySelector<HTMLElement>('[data-enquiry-fields]');
    const button = form.querySelector<HTMLButtonElement>('button[type=submit]');
    const key = form.querySelector<HTMLInputElement>('input[name=idempotencyKey]');
    const newKey = () => {
      if (key) key.value = `portal-${crypto.randomUUID()}`;
    };
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
      if (code === 'sent' && fields) fields.hidden = true;
    };
    newKey();
    const notice = new URLSearchParams(window.location.search).get('enquiry');
    if (notice) show(notice);

    let loaded = false;
    const loadTurnstile = () => {
      if (loaded || !form.dataset.turnstileScript) return;
      loaded = true;
      const script = document.createElement('script');
      script.src = form.dataset.turnstileScript;
      script.async = true;
      document.head.appendChild(script);
    };
    const onSubmit = (event: SubmitEvent) => {
      event.preventDefault();
      if (button) button.disabled = true;
      fetch(form.action, {
        method: 'POST',
        headers: { accept: 'application/json' },
        body: new URLSearchParams(new FormData(form) as unknown as Record<string, string>),
      })
        .then((res) => res.json() as Promise<{ status: string; error?: string }>)
        .then((answer) => {
          show(answer.status === 'sent' ? 'sent' : (answer.error ?? 'generic'));
          // A refused post may be sent again: a new key, and a new challenge (a token is single-use).
          if (answer.status !== 'sent') {
            newKey();
            (window as unknown as { turnstile?: { reset: () => void } }).turnstile?.reset();
          }
        })
        .catch(() => show('generic'))
        .finally(() => {
          if (button) button.disabled = false;
        });
    };
    form.addEventListener('focusin', loadTurnstile);
    form.addEventListener('pointerenter', loadTurnstile);
    form.addEventListener('submit', onSubmit);
    return () => {
      form.removeEventListener('focusin', loadTurnstile);
      form.removeEventListener('pointerenter', loadTurnstile);
      form.removeEventListener('submit', onSubmit);
    };
  }, [props.formId]);
  return null;
}
