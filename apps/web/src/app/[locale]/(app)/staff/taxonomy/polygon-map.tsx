'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
import { Button } from '@inmolink/ui';
import { useEffect, useRef, useState } from 'react';

type MultiPolygon = { type: 'MultiPolygon'; coordinates: number[][][][] };
type Position = [number, number];

export interface PolygonMapProps {
  polygon: MultiPolygon | null;
  centroid: { type: 'Point'; coordinates: Position } | null;
  styleUrl: string;
  disabled: boolean;
  busy: boolean;
  t: (key: string, vars?: Record<string, string>) => string;
  onSave: (polygon: MultiPolygon | null) => void;
}

/** Loaded with `next/dynamic` and `ssr: false` (frontend rules): MapLibre and Terra Draw stay out of the route's first load. */
export default function PolygonMap({ polygon, centroid, styleUrl, disabled, busy, t, onSave }: PolygonMapProps) {
  const container = useRef<HTMLDivElement>(null);
  const drawRef = useRef<import('terra-draw').TerraDraw | null>(null);
  const [failed, setFailed] = useState(false);
  const [count, setCount] = useState(polygon?.coordinates.length ?? 0);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let cleanup = () => {};
    (async () => {
      try {
        const [maplibregl, terra, adapterLib] = await Promise.all([
          import('maplibre-gl'),
          import('terra-draw'),
          import('terra-draw-maplibre-gl-adapter'),
        ]);
        if (cancelled || !container.current) return;
        // Copied to public/ by scripts/copy-maplibre-worker.mjs: bundlers cannot resolve the worker (MapLibre v6).
        maplibregl.setWorkerUrl('/maplibre/maplibre-gl-worker.mjs');
        const first = polygon?.coordinates[0]?.[0] as Position | undefined;
        const center = (centroid?.coordinates ?? first ?? [-4.5, 36.7]) as Position;
        const map = new maplibregl.Map({
          container: container.current,
          style: styleUrl,
          center,
          zoom: polygon || centroid ? 12 : 8,
        });
        map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
        await new Promise<void>((resolve) => map.once('load', () => resolve()));
        if (cancelled) return map.remove();

        const draw = new terra.TerraDraw({
          adapter: new adapterLib.TerraDrawMapLibreGLAdapter({ map }),
          modes: [
            new terra.TerraDrawPolygonMode(),
            new terra.TerraDrawSelectMode({
              flags: {
                polygon: {
                  feature: { draggable: true, coordinates: { midpoints: true, draggable: true, deletable: true } },
                },
              },
            }),
          ],
        });
        draw.start();
        if (polygon) {
          draw.addFeatures(
            polygon.coordinates.map((rings) => ({
              id: crypto.randomUUID(),
              type: 'Feature' as const,
              geometry: { type: 'Polygon' as const, coordinates: rings },
              properties: { mode: 'polygon' },
            })),
          );
          const bounds = new maplibregl.LngLatBounds();
          for (const ring of polygon.coordinates[0] ?? []) bounds.extend(ring as unknown as Position);
          map.fitBounds(bounds, { padding: 40, animate: false });
        }
        draw.setMode('select');
        draw.on('finish', () => {
          draw.setMode('select');
        });
        draw.on('change', (_ids, type) => {
          setDirty(true);
          if (type !== 'styling') {
            setCount(draw.getSnapshot().filter((f) => f.geometry.type === 'Polygon').length);
          }
        });
        drawRef.current = draw;
        cleanup = () => {
          drawRef.current = null;
          draw.stop();
          map.remove();
        };
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      cleanup();
    };
  }, [polygon, centroid, styleUrl]);

  const collect = (): MultiPolygon | null => {
    const polygons = (drawRef.current?.getSnapshot() ?? [])
      .filter((f) => f.geometry.type === 'Polygon')
      .map((f) => (f.geometry as { coordinates: number[][][] }).coordinates);
    return polygons.length > 0 ? { type: 'MultiPolygon', coordinates: polygons } : null;
  };

  if (failed) return <p className="text-sm text-destructive">{t('polygon.unavailable')}</p>;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">{t('polygon.hint')}</p>
      <div ref={container} className="h-80 w-full overflow-hidden rounded-md border" data-testid="polygon-map" />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => drawRef.current?.setMode('polygon')}
        >
          {t('polygon.draw')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || count === 0}
          onClick={() => {
            drawRef.current?.clear();
            setCount(0);
            setDirty(true);
          }}
        >
          {t('polygon.clear')}
        </Button>
        <Button type="button" size="sm" disabled={disabled || busy || !dirty} onClick={() => onSave(collect())}>
          {t('polygon.save')}
        </Button>
        {count === 0 ? <span className="text-xs text-muted-foreground">{t('polygon.none')}</span> : null}
      </div>
    </div>
  );
}
