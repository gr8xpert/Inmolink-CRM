import { notFound, redirect } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { auth } from '@/auth';
import { ClientModeUnavailable } from '@/components/shell/client-mode-unavailable';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { sessionRef } from '@/server/api';
import { fetchRegisterTarget } from '@/server/collaborations-api';
import { fetchContacts } from '@/server/contacts-api';
import { inClientMode } from '@/server/nav';
import { loadShell } from '@/server/shell';
import { contactName } from '../../contacts/lookup';
import { ActionButton } from '../action-button';
import { registerClientAction } from '../actions';
import { BlockNotice } from '../block-notice';
import { loadCollaborationBlock } from '../load-rights';
import { parseRefusal } from '../refusals';
import { termsText } from '../terms-text';
import { ContactPicker } from './contact-picker';
import { developmentTarget, listingTarget, parseTargetParams } from './target';

const FORM_ID = 'register-client';

/**
 * Register a client for another agency's listing or development (S17-F56, `POST /v1/mls/registrations`): the target with
 * the terms the API shows, the contact, and the refusal when there is one. Closed in Client Mode. The API decides who was
 * first and says so without naming the other agency.
 */
export default async function RegisterClientPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const shell = await loadShell();
  if (shell && inClientMode(shell.identity)) return <ClientModeUnavailable />;
  const params = await searchParams;
  const wanted = parseTargetParams(params);
  if (!wanted) notFound();
  const ref = sessionRef(session.user);
  const t = await getTranslations('network.collaborations');
  const shared = { title: t('register.title'), back: t('register.back') };

  const block = await loadCollaborationBlock(ref);
  if (block) {
    return (
      <Frame {...shared}>
        <BlockNotice block={block} />
      </Frame>
    );
  }

  const [res, contacts] = await Promise.all([fetchRegisterTarget(ref, wanted), fetchContacts(ref, { owner: 'me' })]);
  if (res === 'revoked' || contacts === 'revoked') redirect('/session/expired');
  if (!res.ok && res.status === 404) notFound();
  if (!res.ok) {
    return (
      <Frame {...shared}>
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${res.status === 403 ? 'FORBIDDEN' : 'generic'}`)}
        </p>
      </Frame>
    );
  }
  const target =
    res.data.kind === 'LISTING'
      ? listingTarget(res.data.listing, res.data.content, locale)
      : developmentTarget(res.data.development);
  if (target.own) {
    return (
      <Frame {...shared}>
        <p role="status" className="rounded-md bg-muted p-3 text-sm">
          {t('register.own')}
        </p>
      </Frame>
    );
  }

  const format = await getFormatter();
  const commission = await getTranslations('network.commission');
  const terms = termsText(target.terms, {
    t: (key, values) => commission(key, values),
    money: (m) =>
      format.number(m.amountCents / 100, { style: 'currency', currency: m.currency, maximumFractionDigits: 0 }),
    percent: (bp) => format.number(bp / 10_000, { style: 'percent', maximumFractionDigits: 2 }),
  });
  const refusal = parseRefusal(params.error);
  // A contact with neither an e-mail nor a phone cannot be registered (no fingerprint): the API refuses, so it is not offered.
  const recent = contacts.ok
    ? contacts.data.items
        .filter((c) => c.primaryEmail || c.primaryPhone)
        .map((c) => ({
          id: c.id,
          name: contactName(c),
          detail: [c.primaryEmail, c.primaryPhone].filter(Boolean).join(' · '),
        }))
    : [];

  return (
    <Frame {...shared}>
      <section aria-labelledby="register-target" className="flex flex-col gap-1 rounded-md border p-4 text-sm">
        <h2 id="register-target" className="break-words font-medium">
          {t(`kinds.${target.kind}`)} {target.reference ?? target.id.slice(0, 8)}
          {target.title ? ` · ${target.title}` : ''}
        </h2>
        <p>{terms}</p>
        {target.terms ? null : <p className="text-muted-foreground">{t('register.noTerms')}</p>}
      </section>
      <p className="text-sm text-muted-foreground">{t('register.explain')}</p>
      {refusal ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${refusal}`)}
        </p>
      ) : null}
      <ContactPicker
        formId={FORM_ID}
        recent={recent}
        labels={{
          find: t('register.find'),
          findPlaceholder: t('register.findPlaceholder'),
          findSubmit: t('register.findSubmit'),
          none: t('register.findNone'),
          invalid: t('register.findInvalid'),
          error: t('register.findError'),
          noName: t('row.noClient'),
          choose: t('register.choose'),
          found: t('register.found'),
          recent: t('register.recent'),
          noRecent: t('register.noRecent'),
        }}
      />
      <form id={FORM_ID} action={registerClientAction} className="flex flex-wrap items-center gap-3 text-sm">
        <input type="hidden" name="kind" value={target.kind} />
        <input type="hidden" name="id" value={target.id} />
        <ActionButton label={t('register.submit')} variant="default" />
        <Link href="/contacts/new" className="font-medium underline-offset-4 hover:underline">
          {t('register.newContact')}
        </Link>
      </form>
    </Frame>
  );
}

function Frame(props: { title: string; back: string; children: ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{props.title}</h1>
        <Link href="/collaborations" className="text-sm underline-offset-4 hover:underline">
          {props.back}
        </Link>
      </div>
      {props.children}
    </div>
  );
}
