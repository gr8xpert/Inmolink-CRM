'use client';

import dynamic from 'next/dynamic';

/** The import screen is its own chunk (dashboard budget: first-load JS ≤ 250 KB); a skeleton shows meanwhile. */
const ImportPanel = dynamic(() => import('./import-panel'), {
  ssr: false,
  loading: () => <div className="h-48 animate-pulse rounded-md bg-muted" />,
});

export function ImportEntry(props: { messages: Record<string, unknown>; contactTypes: readonly string[] }) {
  return <ImportPanel {...props} />;
}
