import { LEGAL_DOCS, LEGAL_DRAFT, LEGAL_TEXT_VERSION, type LegalDoc, SUB_PROCESSORS } from '@inmolink/contracts';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { LEGAL_NAV_KEYS, LEGAL_SECTIONS } from '../docs';

const isDoc = (v: string): v is LegalDoc => (LEGAL_DOCS as readonly string[]).includes(v);

export async function generateMetadata({ params }: { params: Promise<{ doc: string }> }): Promise<Metadata> {
  const { doc } = await params;
  if (!isDoc(doc)) return {};
  const t = await getTranslations('legal');
  return { title: t('meta.title', { doc: t(`nav.${LEGAL_NAV_KEYS[doc]}`) }) };
}

/**
 * Privacy notice, cookie policy, terms of service and the sub-processor list (S16-04, PLAN §13). Placeholder texts
 * until the lawyer's review (H7): every page says it is a draft and names the text version (`LEGAL_TEXT_VERSION`).
 */
export default async function LegalPage({ params }: { params: Promise<{ doc: string }> }) {
  const { doc } = await params;
  if (!isDoc(doc)) notFound();
  const t = await getTranslations('legal');
  const draft = LEGAL_DRAFT ? (
    <p role="note" className="rounded-md border border-amber-500 bg-amber-50 p-3 text-sm text-amber-900">
      {t('draftNotice', { version: LEGAL_TEXT_VERSION })}
    </p>
  ) : null;

  if (doc === 'sub-processors') {
    return (
      <>
        <h1 className="text-xl font-semibold">{t('subProcessors.title')}</h1>
        {draft}
        <p className="text-sm">{t('subProcessors.intro')}</p>
        <table className="w-full text-left text-sm">
          <thead>
            <tr>
              <th scope="col">{t('subProcessors.columns.name')}</th>
              <th scope="col">{t('subProcessors.columns.purpose')}</th>
              <th scope="col">{t('subProcessors.columns.location')}</th>
            </tr>
          </thead>
          <tbody>
            {SUB_PROCESSORS.map((s) => (
              <tr key={s.key} className="border-t align-top">
                <td className="py-2 pr-2">
                  {s.name}
                  {s.confirmed ? null : (
                    <span className="ml-1 text-xs text-muted-foreground">({t('subProcessors.unconfirmed')})</span>
                  )}
                </td>
                <td className="py-2 pr-2">{s.purposes.map((p) => t(`subProcessors.purposes.${p}`)).join(', ')}</td>
                <td className="py-2">{s.location}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-xs text-muted-foreground">{t('updated', { version: LEGAL_TEXT_VERSION })}</p>
      </>
    );
  }

  const sections: readonly string[] = LEGAL_SECTIONS[doc];
  return (
    <>
      <h1 className="text-xl font-semibold">{t(`${doc}.title`)}</h1>
      {draft}
      <p className="text-sm">{t(`${doc}.intro`)}</p>
      {sections.map((key) => (
        <section key={key} className="flex flex-col gap-1">
          {/* the section keys are the typed lists in ../docs.ts (one test holds them equal to the catalog) */}
          <h2 className="text-base font-semibold">
            {t(`${doc}.sections.${key}.title` as 'privacy.sections.controller.title')}
          </h2>
          <p className="text-sm">{t(`${doc}.sections.${key}.body` as 'privacy.sections.controller.body')}</p>
        </section>
      ))}
      <p className="text-xs text-muted-foreground">{t('updated', { version: LEGAL_TEXT_VERSION })}</p>
    </>
  );
}
