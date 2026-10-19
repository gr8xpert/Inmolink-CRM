'use client';

import dynamic from 'next/dynamic';

/** The mapper is its own chunk (dashboard budget: first-load JS ≤ 250 KB); the page shows a skeleton meanwhile. */
const MapperPanel = dynamic(() => import('./mapper-panel'), {
  ssr: false,
  loading: () => <div className="h-48 animate-pulse rounded-md bg-muted" />,
});

export function MapperEntry(props: { messages: Record<string, unknown>; locales: string[]; defaultLocale: string }) {
  return <MapperPanel {...props} />;
}
