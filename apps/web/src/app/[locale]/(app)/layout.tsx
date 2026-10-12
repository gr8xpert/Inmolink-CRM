import type { ReactNode } from 'react';
import { DashboardShell } from '@/components/shell/dashboard-shell';
import { loadShell } from '@/server/shell';

/**
 * Dashboard shell for every signed-in page (S1-10): member pages under `(signed-in)` and the staff
 * console. Signed out, no shell: the page decides (member pages redirect to login; staff pages are a
 * plain 404, so the console does not reveal itself, S1-09).
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const shell = await loadShell();
  if (!shell) return children;
  return <DashboardShell shell={shell}>{children}</DashboardShell>;
}
