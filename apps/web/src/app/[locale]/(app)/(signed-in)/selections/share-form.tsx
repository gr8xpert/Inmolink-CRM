'use client';

import { Button } from '@inmolink/ui';
import { type ReactNode, useActionState } from 'react';
import { Link } from '@/i18n/navigation';
import type { ShareState } from './errors';
import { type ShareLabels, ShareLinks } from './share-links';

/**
 * A form whose answer is a one-time link (create, rotate): the link comes back in the form state, never in a URL or a
 * cookie. The fields are server-rendered children; works without JavaScript (the action re-renders the page).
 */
export function ShareForm(props: {
  action: (state: ShareState, form: FormData) => Promise<ShareState>;
  submit: string;
  errors: Record<string, string>;
  share: ShareLabels;
  openLabel: string;
  children?: ReactNode;
}) {
  const [state, formAction, pending] = useActionState(props.action, null);
  return (
    <div className="flex flex-col gap-4">
      {state?.share ? (
        <>
          <ShareLinks share={state.share} labels={props.share} />
          {state.selectionId ? (
            <Link
              className="text-sm font-medium underline-offset-4 hover:underline"
              href={`/selections/${state.selectionId}`}
            >
              {props.openLabel}
            </Link>
          ) : null}
        </>
      ) : (
        <form action={formAction} className="flex flex-col gap-3" data-testid="selection-form">
          {props.children}
          {state?.error ? (
            <p role="alert" className="text-sm text-destructive">
              {props.errors[state.error] ?? props.errors.generic}
            </p>
          ) : null}
          <Button type="submit" disabled={pending} className="self-start">
            {props.submit}
          </Button>
        </form>
      )}
    </div>
  );
}
