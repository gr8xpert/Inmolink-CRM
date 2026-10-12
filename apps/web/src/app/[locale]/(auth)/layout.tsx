import type { ReactNode } from 'react';

/** Centered card for the signed-out pages. */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main
      id="main"
      tabIndex={-1}
      className="flex min-h-screen items-center justify-center bg-muted/40 p-4 focus:outline-none"
    >
      <div className="w-full max-w-sm rounded-lg border bg-background p-6 shadow-sm">{children}</div>
    </main>
  );
}
