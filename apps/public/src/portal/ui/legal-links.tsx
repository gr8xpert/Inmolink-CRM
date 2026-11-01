import { LEGAL_DOCS, type LegalDoc } from '@inmolink/contracts';

/**
 * The portal footer's legal links (S16-F5, PLAN §13): the privacy notice, cookie policy, terms and sub-processor list,
 * which the dashboard publishes (`<WEB_URL>/<locale>/legal/<doc>`, every locale prefixed). Plain links in a server
 * component: no client JS on public pages. No base (`WEB_URL` unset): nothing is rendered.
 */
export function legalHref(base: string, locale: string, doc: LegalDoc): string {
  return `${base}/${encodeURIComponent(locale)}/legal/${doc}`;
}

export function LegalLinks(props: {
  base: string | null | undefined;
  locale: string;
  label: string;
  names: Readonly<Record<LegalDoc, string>>;
}) {
  if (!props.base) return null;
  const base = props.base;
  return (
    <nav aria-label={props.label} className="mt-4">
      <ul className="flex flex-wrap gap-x-5 gap-y-2">
        {LEGAL_DOCS.map((doc) => (
          <li key={doc}>
            <a href={legalHref(base, props.locale, doc)} className="text-stone underline-offset-4 hover:underline">
              {props.names[doc]}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
