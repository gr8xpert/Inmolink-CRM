'use client';

import dynamic from 'next/dynamic';
import type { NetworkMapProps } from './network-map';

// MapLibre loads only in the map view (frontend rules: maps via next/dynamic, with a skeleton).
const NetworkMap = dynamic(() => import('./network-map'), {
  ssr: false,
  loading: () => <div className="h-[32rem] w-full animate-pulse rounded-md bg-muted" />,
});

export function MapView(props: NetworkMapProps) {
  return <NetworkMap {...props} />;
}
