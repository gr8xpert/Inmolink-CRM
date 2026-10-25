'use client';

import { Button } from '@inmolink/ui';
import dynamic from 'next/dynamic';
import { useCallback, useEffect, useState } from 'react';
import type { TourLabels, TourStep } from './tour';

// The tour loads as its own chunk, only when it opens (dashboard first-load budget, frontend rules).
const Tour = dynamic(() => import('./tour').then((m) => m.Tour), { ssr: false });

/**
 * Starts a product tour (S13-04). With `autoStart`, it opens by itself once per browser until finished or closed
 * (remembered in `localStorage`, a per-viewer convenience: without storage it simply does not auto-start).
 */
export function TourLauncher({
  tourId,
  steps,
  labels,
  startLabel,
  autoStart = false,
}: {
  tourId: string;
  steps: TourStep[];
  labels: TourLabels;
  startLabel: string;
  autoStart?: boolean;
}) {
  const key = `inmolink.tour.${tourId}.seen`;
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!autoStart) return;
    try {
      if (!window.localStorage.getItem(key)) setOpen(true);
    } catch {
      // storage blocked: no auto-start
    }
  }, [autoStart, key]);

  const close = useCallback(() => {
    setOpen(false);
    try {
      window.localStorage.setItem(key, '1');
    } catch {
      // storage blocked: the tour may auto-start again next time
    }
  }, [key]);

  if (steps.length === 0) return null;
  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)} data-testid="tour-start">
        {startLabel}
      </Button>
      {open ? <Tour steps={steps} labels={labels} onClose={close} /> : null}
    </>
  );
}
