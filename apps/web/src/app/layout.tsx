import type { ReactNode } from 'react';
import './globals.css';

// `lang` becomes the route locale with next-intl in S0-11.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
