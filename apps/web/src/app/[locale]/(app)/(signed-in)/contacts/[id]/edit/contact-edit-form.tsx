'use client';

import { CONTACT_LIMITS } from '@inmolink/contracts';
import { useActionState } from 'react';
import { Link } from '@/i18n/navigation';
import { editContactFormAction } from './edit-action';
import { type ContactEditValues, initialEditContactState } from './parse';

export interface ContactEditLabels {
  firstName: string;
  lastName: string;
  emails: string;
  emailsHint: string;
  phones: string;
  phonesHint: string;
  language: string;
  languageHint: string;
  tags: string;
  tagsHint: string;
  types: string;
  consentMarketing: string;
  consentProcessing: string;
  consentHint: string;
  doNotContact: string;
  doNotContactHint: string;
  submit: string;
  cancel: string;
  duplicate: string;
  open: string;
}

const field = 'h-9 rounded-md border bg-background px-2';
const area = 'rounded-md border bg-background p-2';
const hint = 'text-xs text-muted-foreground';

/** The edit form (a small client island like the create form: a refusal comes back as state, nothing typed is lost). */
export function ContactEditForm(props: {
  id: string;
  version: number;
  initial: ContactEditValues;
  labels: ContactEditLabels;
  typeLabels: readonly { value: string; label: string }[];
  errors: Record<string, string>;
}) {
  const [state, action, pending] = useActionState(editContactFormAction, initialEditContactState);
  const { labels: l, errors } = props;
  const values = state.values ?? props.initial;
  return (
    <form action={action} className="flex flex-col gap-4 text-sm">
      <input type="hidden" name="id" value={props.id} />
      <input type="hidden" name="version" value={props.version} />
      <input type="hidden" name="initialEmails" value={props.initial.emails} />
      <input type="hidden" name="initialPhones" value={props.initial.phones} />
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span>{l.firstName}</span>
          <input
            name="firstName"
            maxLength={CONTACT_LIMITS.nameChars}
            defaultValue={values.firstName}
            className={field}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span>{l.lastName}</span>
          <input
            name="lastName"
            maxLength={CONTACT_LIMITS.nameChars}
            defaultValue={values.lastName}
            className={field}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span>{l.emails}</span>
          <textarea name="emails" rows={3} defaultValue={values.emails} className={area} />
          <span className={hint}>{l.emailsHint}</span>
        </label>
        <label className="flex flex-col gap-1">
          <span>{l.phones}</span>
          <textarea name="phones" rows={3} defaultValue={values.phones} className={area} />
          <span className={hint}>{l.phonesHint}</span>
        </label>
        <label className="flex flex-col gap-1">
          <span>{l.tags}</span>
          <textarea name="tags" rows={3} defaultValue={values.tags} className={area} />
          <span className={hint}>{l.tagsHint}</span>
        </label>
        <label className="flex flex-col gap-1">
          <span>{l.language}</span>
          <input name="language" maxLength={5} defaultValue={values.language} className={field} />
          <span className={hint}>{l.languageHint}</span>
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
        <p className={hint}>{l.consentHint}</p>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="doNotContact" defaultChecked={values.doNotContact} />
          {l.doNotContact}
        </label>
        <p className={hint}>{l.doNotContactHint}</p>
      </div>

      {state.error === 'CONTACT_DUPLICATE' ? (
        <div role="alert" className="flex flex-col gap-2 rounded-md border p-3" data-testid="contact-duplicate">
          <p>{l.duplicate}</p>
          <ul className="flex flex-col gap-1">
            {state.duplicates.map((other) => (
              <li key={other}>
                <Link href={`/contacts/${other}`} className="underline-offset-4 hover:underline">
                  {l.open}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : state.error ? (
        <p role="alert" className="text-destructive">
          {errors[state.error] ?? errors.generic}
        </p>
      ) : null}

      <div className="flex items-center gap-4">
        <button type="submit" disabled={pending} className="h-9 rounded-md border px-3 font-medium">
          {l.submit}
        </button>
        <Link href={`/contacts/${props.id}`} className="underline-offset-4 hover:underline">
          {l.cancel}
        </Link>
      </div>
    </form>
  );
}
