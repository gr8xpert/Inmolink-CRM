'use client';

import type { FormEvent, ReactNode } from 'react';
import { useTransition } from 'react';

/**
 * Opens a file through a server action that mints a short-lived link. The action returns the link rather than
 * redirecting to it: a redirect to another host from a server action leaves Next's router pointing at that host, so
 * the next action on the page (Approve, say) is posted to the file store and fails with no message. A refusal still
 * redirects back to the page with its error.
 */
export function OpenFileForm({
  action,
  children,
}: {
  action: (form: FormData) => Promise<{ url: string }>;
  children: ReactNode;
}) {
  const [, startTransition] = useTransition();
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    startTransition(async () => {
      const { url } = await action(form);
      window.open(url, '_blank', 'noopener');
    });
  };
  return <form onSubmit={onSubmit}>{children}</form>;
}
