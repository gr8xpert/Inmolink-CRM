'use client';

import { useActionState } from 'react';
import { Link } from '@/i18n/navigation';
import { createContactFormAction } from './create-action';
import { initialCreateContactState } from './parse';

export interface ContactCreateLabels {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  phoneHint: string;
  types: string;
  consentMarketing: string;
  consentProcessing: string;
  submit: string;
  duplicateTitle: string;
  /** One existing contact, and several (functions cannot cross into a client component). */
  duplicateBody: string;
  duplicateBodyMany: string;
  duplicateMerge: string;
  duplicateOpen: string;
}

const field = 'h-9 rounded-md border bg-background px-2';

/** The new contact form (a small client island: a refusal comes back as state, so nothing typed is lost). */
export function ContactCreateForm(props: {
  labels: ContactCreateLabels;
  typeLabels: readonly { value: string; label: string }[];
  errors: Record<string, string>;
  idempotencyKey: string;
}) {
  const [state, action, pending] = useActionState(createContactFormAction, initialCreateContactState);
  const { labels: l, errors } = props;
  const { values, error, duplicates } = state;
  return (
    <form action={action} className="flex flex-col gap-4 text-sm">
      <input type="hidden" name="idempotencyKey" value={props.idempotencyKey} />
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span>{l.firstName}</span>
          <input name="firstName" maxLength={100} defaultValue={values.firstName} className={field} />
        </label>
        <label className="flex flex-col gap-1">
          <span>{l.lastName}</span>
          <input name="lastName" maxLength={100} defaultValue={values.lastName} className={field} />
        </label>
        <label className="flex flex-col gap-1">
          <span>{l.email}</span>
          <input name="email" type="email" maxLength={254} defaultValue={values.email} className={field} />
        </label>
        <label className="flex flex-col gap-1">
          <span>{l.phone}</span>
          <input name="phone" type="tel" maxLength={40} defaultValue={values.phone} className={field} />
          <span className="text-xs text-muted-foreground">{l.phoneHint}</span>
        </label>
      </div>

      <fieldset className="flex flex-wrap gap-4">
        <legend className="mb-1">{l.types}</legend>
        {props.typeLabels.map((o) => (
          <label key={o.value} className="flex items-center gap-2">
            <input type="checkbox" name="types" value={o.value} defaultChecked={values.types.includes(o.value)} />
            {o.label}
          </label>
        ))}
      </fieldset>

      <div className="flex flex-col gap-2">
        <label className="flex items-center gap-2">
          <input type="checkbox" name="consentMarketing" defaultChecked={values.consentMarketing} />
          {l.consentMarketing}
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="consentProcessing" defaultChecked={values.consentProcessing} />
          {l.consentProcessing}
        </label>
      </div>

      {error === 'CONTACT_DUPLICATE' && duplicates.length > 0 ? (
        <div role="alert" className="flex flex-col gap-2 rounded-md border p-3" data-testid="contact-duplicate">
          <p className="font-medium">{l.duplicateTitle}</p>
          <p>{duplicates.length === 1 ? l.duplicateBody : l.duplicateBodyMany}</p>
          <ul className="flex flex-col gap-2">
            {duplicates.map((id) => (
              <li key={id} className="flex flex-wrap items-center gap-3">
                <button
                  type="submit"
                  name="mergeInto"
                  value={id}
                  disabled={pending}
                  className="h-9 rounded-md border px-3 font-medium"
                >
                  {l.duplicateMerge}
                </button>
                <Link href={`/contacts/${id}`} className="underline-offset-4 hover:underline">
                  {l.duplicateOpen}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : error ? (
        <p role="alert" className="text-destructive">
          {errors[error] ?? errors.generic}
        </p>
      ) : null}

      <button type="submit" disabled={pending} className="h-9 self-start rounded-md border px-3 font-medium">
        {l.submit}
      </button>
    </form>
  );
}
