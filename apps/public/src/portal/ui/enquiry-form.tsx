import { TURNSTILE_ORIGIN } from '@/embed/csp';
import { ENQUIRY_NOTICES } from '../enquiry';
import { EnquiryIsland } from './enquiry-island';

type T = (key: string, values?: Record<string, string>) => string;

const FORM_ID = 'enquiry';
const TURNSTILE_SCRIPT = `${TURNSTILE_ORIGIN}/turnstile/v0/api.js`;

/**
 * The enquiry form on a listing page (S15-02): a plain form POST to `/api/portal/enquiry` (works without the island;
 * answered by a redirect back with `?enquiry=`), with the consent text, the visitor's marketing opt-in and the Turnstile
 * widget; `EnquiryIsland` adds the idempotency key, Turnstile on first use and the in-place answer. The same HTML for
 * every visitor (the page is cached). The enquiry goes to the listing's agency (marketplace: the listing owner).
 */
export function EnquiryForm(props: {
  locale: string;
  /** The listing's public code. */
  code: string;
  /** The listing page's path (the no-JavaScript answer comes back here). */
  back: string;
  agency: string;
  reference: string;
  /** Null: Turnstile is not configured — no form (it could only be refused). */
  turnstileSiteKey: string | null;
  turnstileAction: string;
  t: T;
}) {
  const { t } = props;
  if (!props.turnstileSiteKey) {
    return <p className="mt-4 text-sm text-stone">{t('enquiry.unavailable')}</p>;
  }
  const messages: Record<string, string> = {};
  for (const c of ENQUIRY_NOTICES) messages[c] = t(`enquiry.notices.${c}`, { agency: props.agency });
  return (
    <form
      id={FORM_ID}
      method="post"
      action="/api/portal/enquiry"
      aria-labelledby="enquiry-title"
      className="mt-5 grid gap-3 border-t border-shore pt-5 text-sm"
      data-turnstile-script={TURNSTILE_SCRIPT}
      data-messages={JSON.stringify(messages)}
      data-testid="portal-enquiry"
    >
      <h2 id="enquiry-title" className="text-base font-semibold">
        {t('enquiry.title')}
      </h2>
      <p role="status" aria-live="polite" className="rounded-md bg-shore p-3" data-enquiry-status="" hidden />
      <div className="grid gap-3" data-enquiry-fields="">
        {/* The challenge needs JavaScript: without it the form is still posted but refused, so say so first. */}
        <noscript>
          <p className="text-stone">{t('enquiry.needsJavaScript')}</p>
        </noscript>
        <input type="hidden" name="locale" value={props.locale} />
        <input type="hidden" name="code" value={props.code} />
        <input type="hidden" name="back" value={props.back} />
        <input type="hidden" name="idempotencyKey" defaultValue="" />
        <label className="grid gap-1">
          <span>{t('enquiry.name')}</span>
          <input
            name="name"
            required
            maxLength={120}
            autoComplete="name"
            className="rounded-md border border-shore px-3 py-2"
          />
        </label>
        <label className="grid gap-1">
          <span>{t('enquiry.email')}</span>
          <input
            name="email"
            type="email"
            required
            maxLength={254}
            autoComplete="email"
            className="rounded-md border border-shore px-3 py-2"
          />
        </label>
        <label className="grid gap-1">
          <span>{t('enquiry.phone')}</span>
          <input
            name="phone"
            type="tel"
            maxLength={24}
            autoComplete="tel"
            className="rounded-md border border-shore px-3 py-2"
          />
        </label>
        <label className="grid gap-1">
          <span>{t('enquiry.message')}</span>
          <textarea
            name="message"
            required
            maxLength={4000}
            rows={4}
            defaultValue={t('enquiry.messageDefault', { ref: props.reference })}
            className="rounded-md border border-shore px-3 py-2"
          />
        </label>
        <label className="flex gap-2 text-xs text-stone">
          <input type="checkbox" name="privacyAccepted" required className="mt-0.5" />
          <span>{t('enquiry.privacy', { agency: props.agency })}</span>
        </label>
        <label className="flex gap-2 text-xs text-stone">
          <input type="checkbox" name="marketingConsent" className="mt-0.5" />
          <span>{t('enquiry.marketing', { agency: props.agency })}</span>
        </label>
        <div className="cf-turnstile" data-sitekey={props.turnstileSiteKey} data-action={props.turnstileAction} />
        <button
          type="submit"
          className="rounded-md bg-sea px-4 py-2 font-semibold text-white hover:bg-sea-deep disabled:opacity-60"
        >
          {t('enquiry.submit')}
        </button>
      </div>
      <EnquiryIsland formId={FORM_ID} />
    </form>
  );
}
