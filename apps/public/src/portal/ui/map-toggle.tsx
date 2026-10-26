'use client';

import dynamic from 'next/dynamic';
import { useState } from 'react';
import type { MapPin, MapText } from './tile-map';

/**
 * "Show on map" (S15-01): the only client code on portal pages. The map itself is a separate chunk loaded on the
 * first click (`next/dynamic`, frontend rules), so the pages' first-load JS stays the framework's.
 */
const TileMap = dynamic(() => import('./tile-map'), {
  ssr: false,
  loading: () => <div className="aspect-[16/9] w-full motion-safe:animate-pulse rounded-md bg-shore" />,
});

export function MapToggle(props: { pins: MapPin[]; tileUrl: string; attribution: string; text: MapText }) {
  const [open, setOpen] = useState(false);
  if (props.pins.length === 0) return null;
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="rounded-md border border-sea px-3 py-1.5 text-sm font-semibold text-sea hover:bg-shore"
      >
        {open ? props.text.hide : props.text.show}
      </button>
      {open ? (
        <div className="mt-3">
          <TileMap pins={props.pins} tileUrl={props.tileUrl} attribution={props.attribution} text={props.text} />
        </div>
      ) : null}
    </div>
  );
}
