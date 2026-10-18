'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef, useState } from 'react';

export interface NetworkMapPin {
  id: string;
  lat: number;
  lng: number;
  /** Shown on hover / focus: title and price, already formatted. */
  label: string;
  href: string;
}

export interface NetworkMapProps {
  pins: NetworkMapPin[];
  styleUrl: string;
  failedText: string;
}

const MALAGA: [number, number] = [-4.5, 36.7];

/**
 * The network results of one page as pins (S5-05). Loaded with `next/dynamic` and `ssr: false` (frontend rules):
 * MapLibre stays out of the page's first load, and only for the map view.
 */
export default function NetworkMap({ pins, styleUrl, failedText }: NetworkMapProps) {
  const container = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let map: import('maplibre-gl').Map | null = null;
    (async () => {
      try {
        const maplibregl = await import('maplibre-gl');
        if (cancelled || !container.current) return;
        // Copied to public/ by scripts/copy-maplibre-worker.mjs: bundlers cannot resolve the worker (MapLibre v6).
        maplibregl.setWorkerUrl('/maplibre/maplibre-gl-worker.mjs');
        map = new maplibregl.Map({ container: container.current, style: styleUrl, center: MALAGA, zoom: 8 });
        map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
        const bounds = new maplibregl.LngLatBounds();
        for (const p of pins) {
          const link = document.createElement('a');
          link.href = p.href;
          link.textContent = p.label;
          link.className = 'text-sm underline-offset-4 hover:underline';
          new maplibregl.Marker()
            .setLngLat([p.lng, p.lat])
            .setPopup(new maplibregl.Popup({ closeButton: false }).setDOMContent(link))
            .addTo(map);
          bounds.extend([p.lng, p.lat]);
        }
        if (pins.length > 0) map.fitBounds(bounds, { padding: 48, maxZoom: 14, animate: false });
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      map?.remove();
    };
  }, [pins, styleUrl]);

  if (failed) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {failedText}
      </p>
    );
  }
  return <div ref={container} className="h-[32rem] w-full rounded-md border" />;
}
