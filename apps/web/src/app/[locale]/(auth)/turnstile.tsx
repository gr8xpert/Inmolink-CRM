'use client';

import { useEffect, useRef } from 'react';

/**
 * Cloudflare Turnstile widget (S1-F5), loaded only when the login form asks for it. The widget adds a
 * hidden `cf-turnstile-response` input to the form; the server verifies it with Siteverify. Tokens are
 * single use, so the widget resets whenever `resetKey` changes (each submission's result).
 */
interface TurnstileApi {
  render(el: HTMLElement, options: { sitekey: string; action: string }): string;
  reset(id: string): void;
  remove(id: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let loading: Promise<TurnstileApi> | undefined;

function loadTurnstile(): Promise<TurnstileApi> {
  loading ??= new Promise((resolve, reject) => {
    if (window.turnstile) return resolve(window.turnstile);
    const script = document.createElement('script');
    script.src = SCRIPT;
    script.async = true;
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile missing')));
    script.onerror = () => {
      loading = undefined;
      reject(new Error('turnstile failed to load'));
    };
    document.head.appendChild(script);
  });
  return loading;
}

export function Turnstile({ siteKey, action, resetKey }: { siteKey: string; action: string; resetKey: unknown }) {
  const ref = useRef<HTMLDivElement>(null);
  const widget = useRef<{ api: TurnstileApi; id: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadTurnstile().then(
      (api) => {
        if (cancelled || !ref.current) return;
        widget.current = { api, id: api.render(ref.current, { sitekey: siteKey, action }) };
      },
      () => {}, // the server keeps refusing without a token; the form error explains what to do
    );
    return () => {
      cancelled = true;
      if (widget.current) widget.current.api.remove(widget.current.id);
      widget.current = null;
    };
  }, [siteKey, action]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: resetKey is the trigger, not an input
  useEffect(() => {
    if (widget.current) widget.current.api.reset(widget.current.id);
  }, [resetKey]);

  return <div ref={ref} data-testid="turnstile" className="min-h-[65px]" />;
}
