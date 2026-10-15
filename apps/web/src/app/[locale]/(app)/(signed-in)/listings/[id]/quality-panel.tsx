'use client';

import type { ListingQualityDto } from '@inmolink/contracts';
import { useEffect, useRef, useState } from 'react';
import { listingQualityAction } from '../actions';
import { makeT } from '../values';
import { onListingChanged } from './listing-events';
import { hintText } from './quality-hints';

/** Saves often come in bursts (autosave, a batch of photos): ask once they settle. */
const REFRESH_MS = 600;
/** Photos still processing: ask again this often, this many times, until their resolution counts. */
const PENDING_POLL_MS = 15_000;
const PENDING_POLLS = 20;

export interface QualityPanelProps {
  listingId: string;
  /** Null when the API refused it (another agency's listing, Client Mode): the panel is not shown. */
  initial: ListingQualityDto | null;
  /** The `listings` catalog, translated on the server. */
  messages: Record<string, unknown>;
}

/**
 * The listing quality score with fix-it hints (S3-08). Each hint links to the editor section that fixes it. The
 * score is computed live by the API and asked for again after every saved change in the editor or the media
 * manager (`listing-events`), so adding photos moves it without a reload.
 */
export function QualityPanel(props: QualityPanelProps) {
  const t = makeT(props.messages);
  const id = props.listingId;
  const [quality, setQuality] = useState(props.initial);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Only the latest request's answer is shown (an earlier, slower one never overwrites it). */
  const asked = useRef(0);
  const polls = useRef(0);

  useEffect(() => {
    const refresh = (delay: number) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(async () => {
        const n = ++asked.current;
        const r = await listingQualityAction(id);
        if (!r.ok || n !== asked.current) return;
        setQuality(r.data);
        if (r.data.pendingPhotos > 0 && polls.current < PENDING_POLLS) {
          polls.current++;
          refresh(PENDING_POLL_MS);
        }
      }, delay);
    };
    const off = onListingChanged(id, () => {
      polls.current = 0;
      refresh(REFRESH_MS);
    });
    if ((props.initial?.pendingPhotos ?? 0) > 0) refresh(PENDING_POLL_MS);
    return () => {
      off();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [id, props.initial]);

  if (!quality) return null;
  return (
    <section
      aria-labelledby="quality-title"
      data-testid="quality-panel"
      className="flex flex-col gap-3 rounded-md border p-4"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id="quality-title" className="text-sm font-semibold">
          {t('quality.title')}
        </h2>
        <span aria-live="polite" data-testid="quality-score" className="text-lg font-semibold tabular-nums">
          {t('quality.score', { score: String(quality.score) })}
        </span>
      </div>
      <meter
        min={0}
        max={100}
        low={50}
        high={80}
        optimum={100}
        value={quality.score}
        aria-label={t('quality.title')}
        className="h-2 w-full"
      />
      {quality.pendingPhotos > 0 ? (
        <p className="text-xs text-muted-foreground">
          {t('quality.pendingPhotos', { count: String(quality.pendingPhotos) })}
        </p>
      ) : null}
      {quality.hints.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('quality.complete')}</p>
      ) : (
        <ul className="flex flex-col gap-1.5 text-sm" data-testid="quality-hints">
          {quality.hints.map((h) => (
            <li key={h.code} className="flex items-baseline justify-between gap-3">
              <a href={`#section-${h.section}`} className="underline-offset-4 hover:underline">
                {hintText(t, h)}
              </a>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {t('quality.gain', { points: String(h.gain) })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
