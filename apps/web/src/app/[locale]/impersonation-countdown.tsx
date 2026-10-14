'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

/**
 * The impersonation banner's countdown (S1-F9): minutes and seconds until the session expires, ticking
 * every second. The server renders the first value (no hydration mismatch); at zero the page refreshes,
 * so the banner turns into "ended" and the dashboard stops answering as the member. `template` is the
 * translated sentence with a `{time}` placeholder (message formatting stays on the server).
 */
export function ImpersonationCountdown({
  expiresAt,
  initialSeconds,
  template,
}: {
  expiresAt: string;
  initialSeconds: number;
  template: string;
}) {
  const router = useRouter();
  const [seconds, setSeconds] = useState(initialSeconds);
  useEffect(() => {
    const end = Date.parse(expiresAt);
    const tick = () => setSeconds(Math.max(0, Math.ceil((end - Date.now()) / 1_000)));
    tick();
    const id = setInterval(tick, 1_000);
    return () => clearInterval(id);
  }, [expiresAt]);
  // Refresh once, when the countdown reaches zero here — not on a mount that already starts at zero
  // (the server then renders the "ended" banner itself), so a stale page cannot loop on refreshes.
  const refreshed = useRef(initialSeconds === 0);
  useEffect(() => {
    if (seconds === 0 && !refreshed.current) {
      refreshed.current = true;
      router.refresh();
    }
  }, [seconds, router]);
  const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return (
    <span data-testid="impersonation-countdown" className="whitespace-nowrap font-medium tabular-nums">
      {template.replace('{time}', time)}
    </span>
  );
}
