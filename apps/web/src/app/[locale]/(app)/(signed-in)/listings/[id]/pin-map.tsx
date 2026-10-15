'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef, useState } from 'react';

export interface PinMapProps {
  /** The exact pin, or null. */
  point: { lat: number; lng: number } | null;
  styleUrl: string;
  disabled: boolean;
  failedText: string;
  onPick: (point: { lat: number; lng: number }) => void;
}

const MALAGA: [number, number] = [-4.5, 36.7];

/** Loaded with `next/dynamic` and `ssr: false` (frontend rules): MapLibre stays out of the editor's first load. */
export default function PinMap({ point, styleUrl, disabled, failedText, onPick }: PinMapProps) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<import('maplibre-gl').Map | null>(null);
  const markerRef = useRef<import('maplibre-gl').Marker | null>(null);
  const libRef = useRef<typeof import('maplibre-gl') | null>(null);
  const pickRef = useRef(onPick);
  pickRef.current = onPick;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const [failed, setFailed] = useState(false);
  // Set once the map exists, so the marker effect runs again and draws the initial pin.
  const [, setReady] = useState(false);
  const initial = useRef(point);

  useEffect(() => {
    let cancelled = false;
    let map: import('maplibre-gl').Map | null = null;
    (async () => {
      try {
        const maplibregl = await import('maplibre-gl');
        if (cancelled || !container.current) return;
        // Copied to public/ by scripts/copy-maplibre-worker.mjs: bundlers cannot resolve the worker (MapLibre v6).
        maplibregl.setWorkerUrl('/maplibre/maplibre-gl-worker.mjs');
        const start = initial.current;
        map = new maplibregl.Map({
          container: container.current,
          style: styleUrl,
          center: start ? [start.lng, start.lat] : MALAGA,
          zoom: start ? 14 : 8,
        });
        map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
        map.on('click', (e) => {
          if (disabledRef.current) return;
          pickRef.current({ lat: Number(e.lngLat.lat.toFixed(6)), lng: Number(e.lngLat.lng.toFixed(6)) });
        });
        libRef.current = maplibregl;
        mapRef.current = map;
        setReady(true);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      markerRef.current = null;
      mapRef.current = null;
      map?.remove();
    };
  }, [styleUrl]);

  // The marker follows the pin, whether it came from a click or the coordinate inputs.
  useEffect(() => {
    const map = mapRef.current;
    const lib = libRef.current;
    if (!map || !lib) return;
    if (!point) {
      markerRef.current?.remove();
      markerRef.current = null;
      return;
    }
    if (!markerRef.current) markerRef.current = new lib.Marker().setLngLat([point.lng, point.lat]).addTo(map);
    else markerRef.current.setLngLat([point.lng, point.lat]);
  });

  return failed ? (
    <p className="text-sm text-muted-foreground">{failedText}</p>
  ) : (
    <div ref={container} className="h-72 w-full overflow-hidden rounded-md border" data-testid="pin-map" />
  );
}
