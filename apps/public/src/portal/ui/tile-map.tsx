'use client';

import { useState } from 'react';

/**
 * A small static tile map (S15-01): the configured raster tiles (`{z}/{x}/{y}`, Web Mercator) around the pins, with
 * zoom buttons — no map library (a few KB, loaded only when a visitor opens the map). Pins link to their listings.
 */

export interface MapPin {
  lat: number;
  lng: number;
  label: string;
  href?: string;
}

export interface MapText {
  show: string;
  hide: string;
  label: string;
  zoomIn: string;
  zoomOut: string;
  note?: string;
}

const TILE = 256;
/** The map's frame in tile pixels (16:9); the frame scales to the container's width. */
const W = 768;
const H = 432;
const MAX_ZOOM = 15;

const worldX = (lng: number, z: number) => ((lng + 180) / 360) * TILE * 2 ** z;
function worldY(lat: number, z: number) {
  const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE * 2 ** z;
}

/** The deepest zoom at which every pin fits in the frame (with a margin). */
export function fitZoom(pins: readonly MapPin[]): number {
  for (let z = MAX_ZOOM; z > 1; z--) {
    const xs = pins.map((p) => worldX(p.lng, z));
    const ys = pins.map((p) => worldY(p.lat, z));
    if (Math.max(...xs) - Math.min(...xs) <= W * 0.8 && Math.max(...ys) - Math.min(...ys) <= H * 0.8) {
      return pins.length === 1 ? Math.min(z, 13) : z;
    }
  }
  return 1;
}

function tileHref(template: string, z: number, x: number, y: number): string {
  const n = 2 ** z;
  return template
    .replace('{z}', String(z))
    .replace('{x}', String(((x % n) + n) % n))
    .replace('{y}', String(y));
}

export default function TileMap(props: { pins: MapPin[]; tileUrl: string; attribution: string; text: MapText }) {
  const [zoom, setZoom] = useState(() => fitZoom(props.pins));
  const lats = props.pins.map((p) => p.lat);
  const lngs = props.pins.map((p) => p.lng);
  const centerLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const centerLng = (Math.min(...lngs) + Math.max(...lngs)) / 2;
  const left = worldX(centerLng, zoom) - W / 2;
  const top = worldY(centerLat, zoom) - H / 2;
  const tiles: { x: number; y: number }[] = [];
  const max = 2 ** zoom;
  for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + H) / TILE); ty++) {
    if (ty < 0 || ty >= max) continue;
    for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + W) / TILE); tx++) tiles.push({ x: tx, y: ty });
  }
  const pct = (v: number, of: number) => `${(v / of) * 100}%`;
  return (
    <figure className="m-0" aria-label={props.text.label}>
      <div className="relative aspect-[16/9] w-full overflow-hidden rounded-md bg-shore">
        {tiles.map((t) => (
          // biome-ignore lint/performance/noImgElement: map tiles from the configured tile server, not listing media.
          <img
            key={`${zoom}-${t.x}-${t.y}`}
            src={tileHref(props.tileUrl, zoom, t.x, t.y)}
            alt=""
            width={TILE}
            height={TILE}
            className="absolute max-w-none"
            style={{
              left: pct(t.x * TILE - left, W),
              top: pct(t.y * TILE - top, H),
              width: pct(TILE, W),
              height: pct(TILE, H),
            }}
          />
        ))}
        {props.pins.map((p) => {
          const style = {
            left: pct(worldX(p.lng, zoom) - left, W),
            top: pct(worldY(p.lat, zoom) - top, H),
          };
          const dot =
            'absolute block size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-sea';
          return p.href ? (
            <a key={`${p.href}`} href={p.href} title={p.label} className={dot} style={style}>
              <span className="sr-only">{p.label}</span>
            </a>
          ) : (
            <span key={`${p.lat},${p.lng},${p.label}`} title={p.label} className={dot} style={style}>
              <span className="sr-only">{p.label}</span>
            </span>
          );
        })}
        <div className="absolute right-2 top-2 flex flex-col overflow-hidden rounded-md border border-shore bg-white">
          <button
            type="button"
            onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z + 1))}
            aria-label={props.text.zoomIn}
            className="size-9 text-lg font-bold text-ink hover:bg-shore"
          >
            +
          </button>
          <button
            type="button"
            onClick={() => setZoom((z) => Math.max(2, z - 1))}
            aria-label={props.text.zoomOut}
            className="size-9 border-t border-shore text-lg font-bold text-ink hover:bg-shore"
          >
            −
          </button>
        </div>
      </div>
      <figcaption className="mt-1 flex flex-wrap justify-between gap-2 text-xs text-stone">
        <span>{props.text.note ?? ''}</span>
        <span>{props.attribution}</span>
      </figcaption>
    </figure>
  );
}
