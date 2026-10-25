'use client';

import { Button } from '@inmolink/ui';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * A minimal product tour (S13-04): a popover that walks through steps, each pointing at an element carrying
 * `data-tour-target="<target>"` (the shell's nav items carry their path). A step whose target is missing or hidden (the
 * mobile menu is closed) shows centred. Esc closes; focus moves to the popover on every step. No dependency — and only
 * ever loaded on demand (`TourLauncher` imports it with `next/dynamic`), so it costs the dashboard's first load nothing.
 */
export interface TourStep {
  /** `data-tour-target` value to point at; null: a centred step (intro, outro). */
  target: string | null;
  title: string;
  body: string;
}

export interface TourLabels {
  next: string;
  back: string;
  done: string;
  close: string;
}

const HIGHLIGHT = ['ring-2', 'ring-primary', 'ring-offset-2'];
const WIDTH = 320;
const GAP = 12;

function targetOf(target: string | null): HTMLElement | null {
  if (!target) return null;
  const el = document.querySelector<HTMLElement>(`[data-tour-target="${CSS.escape(target)}"]`);
  return el && el.getClientRects().length > 0 ? el : null;
}

export function Tour({ steps, labels, onClose }: { steps: TourStep[]; labels: TourLabels; onClose: () => void }) {
  const [index, setIndex] = useState(0);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const step = steps[index];

  useLayoutEffect(() => {
    const el = targetOf(step?.target ?? null);
    if (!el) {
      setPlace(null);
      return;
    }
    el.scrollIntoView({ block: 'nearest' });
    el.classList.add(...HIGHLIGHT);
    const r = el.getBoundingClientRect();
    const right = r.right + GAP + WIDTH <= window.innerWidth;
    setPlace({
      top: Math.max(GAP, right ? r.top : r.bottom + GAP),
      left: right ? r.right + GAP : Math.max(GAP, Math.min(r.left, window.innerWidth - WIDTH - GAP)),
    });
    return () => el.classList.remove(...HIGHLIGHT);
  }, [step]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: focus the popover whenever the step changes
  useEffect(() => panel.current?.focus(), [index]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!step) return null;
  const last = index === steps.length - 1;
  return (
    <div
      ref={panel}
      role="dialog"
      aria-labelledby="tour-title"
      aria-describedby="tour-body"
      tabIndex={-1}
      data-testid="product-tour"
      className="fixed z-50 flex flex-col gap-3 rounded-md border bg-background p-4 text-sm shadow-lg focus:outline-none"
      style={
        place
          ? { top: place.top, left: place.left, width: WIDTH, maxWidth: `calc(100vw - ${2 * GAP}px)` }
          : {
              top: '50%',
              left: '50%',
              width: WIDTH,
              maxWidth: `calc(100vw - ${2 * GAP}px)`,
              transform: 'translate(-50%, -50%)',
            }
      }
    >
      <div className="flex items-start justify-between gap-2">
        <h2 id="tour-title" className="font-medium">
          {step.title}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={labels.close}
          className="rounded-sm px-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          ×
        </button>
      </div>
      <p id="tour-body" className="text-muted-foreground">
        {step.body}
      </p>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground" aria-hidden="true">
          {index + 1} / {steps.length}
        </span>
        <div className="flex gap-2">
          {index > 0 ? (
            <Button type="button" variant="outline" size="sm" onClick={() => setIndex(index - 1)}>
              {labels.back}
            </Button>
          ) : null}
          <Button type="button" size="sm" onClick={() => (last ? onClose() : setIndex(index + 1))}>
            {last ? labels.done : labels.next}
          </Button>
        </div>
      </div>
    </div>
  );
}
