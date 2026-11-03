'use client';

import { Button, Label } from '@inmolink/ui';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';

export interface UploadFormProps {
  locale: string;
  accept: string;
  kinds: { value: string; label: string }[];
  /** Labels translated on the server (no catalogs in the client bundle). */
  labels: { kind: string; file: string; submit: string; uploaded: string };
  /** Keyed by the route's error codes; `generic` is the fallback. */
  errors: Record<string, string> & { generic: string };
}

/**
 * The verification upload form (S1-03). With JavaScript it posts in the background, so a refused upload keeps the
 * chosen type and file and the user can retry at once. Without it, the same form posts to the route and comes back
 * through a redirect.
 */
export function UploadForm(props: UploadFormProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ error?: string; uploaded?: boolean }>({});

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    setPending(true);
    setResult({});
    let body: { notice?: string; error?: string; redirect?: string };
    try {
      const res = await fetch(form.action, {
        method: 'POST',
        body: new FormData(form),
        headers: { accept: 'application/json' },
      });
      body = (await res.json()) as typeof body;
    } catch {
      body = { error: 'generic' };
    }
    setPending(false);
    if (body.redirect) {
      window.location.assign(body.redirect);
    } else if (body.notice) {
      form.reset();
      setResult({ uploaded: true });
      router.refresh();
    } else {
      setResult({ error: body.error ?? 'generic' });
    }
  };

  return (
    <>
      {result.uploaded ? (
        <p role="status" className="rounded-md bg-muted p-3 text-sm">
          {props.labels.uploaded}
        </p>
      ) : null}
      {result.error ? (
        <p role="alert" className="text-sm text-destructive">
          {props.errors[result.error] ?? props.errors.generic}
        </p>
      ) : null}
      {/* A route handler, not a server action: only this path accepts 10 MB bodies. */}
      <form
        action="/api/verification/documents"
        method="post"
        encType="multipart/form-data"
        onSubmit={onSubmit}
        className="flex flex-col gap-3 sm:flex-row sm:items-end"
      >
        <input type="hidden" name="locale" value={props.locale} />
        <div className="flex flex-col gap-2">
          <Label htmlFor="doc-kind">{props.labels.kind}</Label>
          <select
            id="doc-kind"
            name="kind"
            defaultValue={props.kinds[0]?.value}
            className="h-9 rounded-md border bg-background px-2 text-sm"
          >
            {props.kinds.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-1 flex-col gap-2">
          <Label htmlFor="doc-file">{props.labels.file}</Label>
          <input id="doc-file" name="file" type="file" required accept={props.accept} className="text-sm" />
        </div>
        <Button type="submit" disabled={pending}>
          {props.labels.submit}
        </Button>
      </form>
    </>
  );
}
