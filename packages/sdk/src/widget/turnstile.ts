/**
 * Cloudflare Turnstile in the browser (S8-F8): the widget's lead form needs a token for publishable keys (S7-05). The
 * API script is loaded once, on the first form shown, with explicit rendering. The host page's CSP must allow
 * `https://challenges.cloudflare.com` (script and frame).
 */
export interface TurnstileApi {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      action: string;
      language: string;
      callback: (token: string) => void;
      'error-callback': () => void;
      'expired-callback': () => void;
    },
  ): string | undefined;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}

export const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

let loading: Promise<TurnstileApi> | undefined;

/**
 * Loads Cloudflare's script once and takes `window.turnstile` only as our own script's `onload` finds it: a
 * `turnstile` object the page (or anything on it) set beforehand is never trusted with the visitor's form.
 */
export function loadTurnstile(): Promise<TurnstileApi> {
  const w = window as { turnstile?: TurnstileApi };
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = TURNSTILE_SCRIPT;
    script.async = true;
    script.onload = () => (w.turnstile ? resolve(w.turnstile) : reject(new Error('turnstile')));
    script.onerror = () => reject(new Error('turnstile'));
    document.head.append(script);
  }).catch((e: unknown) => {
    // A failed load (offline, blocked) may be retried by the next form.
    loading = undefined;
    throw e;
  });
  return loading;
}
