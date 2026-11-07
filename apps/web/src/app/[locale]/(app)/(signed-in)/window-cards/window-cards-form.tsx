'use client';

import { WINDOW_CARD_TEMPLATES, type WindowCardFormat } from '@inmolink/contracts';
import { Button, Label } from '@inmolink/ui';
import { useEffect, useRef, useState } from 'react';
import { createWindowCardsAction, windowCardsStateAction } from './actions';

export interface WindowCardsLabels {
  template: string;
  format: string;
  locale: string;
  submit: string;
  working: string;
  ready: string;
  download: string;
  failed: string;
  layouts: Record<string, string>;
  orientations: Record<string, string>;
  formats: Record<string, string>;
  errors: Record<string, string>;
}

/** Polls a batch every 1.5 s for up to two minutes (a batch of 50 renders in seconds; a busy pool takes longer). */
const POLL_MS = 1_500;
const POLL_MAX = 80;

/**
 * Template picker, format and language for the chosen listings (R2-06): asks for the batch, polls it and offers the
 * download. Presentation only — the API checks the listings, the plan and who may.
 */
export function WindowCardsForm(props: {
  listingIds: string[];
  locales: string[];
  defaultLocale: string;
  labels: WindowCardsLabels;
}) {
  const { labels } = props;
  const [template, setTemplate] = useState(WINDOW_CARD_TEMPLATES[0]?.id ?? '');
  const [format, setFormat] = useState<WindowCardFormat>('PDF');
  const [locale, setLocale] = useState(props.defaultLocale);
  const [state, setState] = useState<'idle' | 'working' | 'ready' | 'failed'>('idle');
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const fail = (code: string) => {
    setError(labels.errors[code] ?? labels.errors.generic ?? '');
    setState('idle');
  };

  const start = async () => {
    setError(null);
    setUrl(null);
    setState('working');
    const asked = await createWindowCardsAction({ listingIds: props.listingIds, template, format, locale });
    if (!asked.ok) return asked.revoked ? window.location.reload() : fail(asked.code);
    let doc = asked.data;
    for (let i = 0; i < POLL_MAX && doc.status === 'PENDING' && alive.current; i++) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const res = await windowCardsStateAction(doc.id);
      if (!res.ok) return res.revoked ? window.location.reload() : fail(res.code);
      doc = res.data;
    }
    if (!alive.current) return;
    if (doc.status === 'READY' && doc.url) {
      setUrl(doc.url);
      setState('ready');
    } else setState(doc.status === 'FAILED' ? 'failed' : 'idle');
  };

  return (
    <div className="flex flex-col gap-4" data-testid="window-cards-form">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">{labels.template}</legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {WINDOW_CARD_TEMPLATES.map((t) => (
            <label
              key={t.id}
              className="flex cursor-pointer items-center gap-2 rounded-md border p-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-muted"
            >
              <input
                type="radio"
                name="template"
                value={t.id}
                checked={template === t.id}
                onChange={() => setTemplate(t.id)}
              />
              <span>
                {labels.layouts[t.layout]} · {t.size} · {labels.orientations[t.orientation]}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap gap-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor="wc-format">{labels.format}</Label>
          <select
            id="wc-format"
            value={format}
            onChange={(e) => setFormat(e.target.value === 'HTML' ? 'HTML' : 'PDF')}
            className="h-9 rounded-md border bg-background px-2 text-sm"
          >
            {(['PDF', 'HTML'] as const).map((f) => (
              <option key={f} value={f}>
                {labels.formats[f]}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="wc-locale">{labels.locale}</Label>
          <select
            id="wc-locale"
            value={locale}
            onChange={(e) => setLocale(e.target.value)}
            className="h-9 rounded-md border bg-background px-2 text-sm"
          >
            {props.locales.map((l) => (
              <option key={l} value={l}>
                {l.toUpperCase()}
              </option>
            ))}
          </select>
        </div>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-3">
        <Button type="button" onClick={() => void start()} disabled={state === 'working'}>
          {state === 'working' ? labels.working : labels.submit}
        </Button>
        {state === 'ready' && url ? (
          <span role="status" className="flex items-center gap-3 text-sm" data-testid="window-cards-ready">
            {labels.ready}
            <a href={url} className="font-medium underline underline-offset-4" rel="noopener">
              {labels.download}
            </a>
          </span>
        ) : null}
        {state === 'failed' ? (
          <p role="alert" className="text-sm text-destructive">
            {labels.failed}
          </p>
        ) : null}
      </div>
    </div>
  );
}
