import type { ConsentRecordDto } from '@inmolink/contracts';
import { loadMessages } from '@inmolink/i18n/server';
import { createTranslator } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConsentHistory, type ConsentHistoryLabels } from './consent-history';

function labelsFor(locale: 'en' | 'es'): ConsentHistoryLabels {
  const t = createTranslator({ locale, messages: loadMessages(locale), namespace: 'contacts.consents' });
  return {
    title: t('title'),
    empty: t('empty'),
    load: t('load'),
    purpose: { MARKETING: t('purposes.MARKETING'), PROCESSING: t('purposes.PROCESSING') },
    granted: t('granted'),
    withdrawn: t('withdrawn'),
    source: {
      DASHBOARD: t('sources.DASHBOARD'),
      WEBSITE: t('sources.WEBSITE'),
      PORTAL: t('sources.PORTAL'),
      IMPORT: t('sources.IMPORT'),
      MERGE: t('sources.MERGE'),
      UNSUBSCRIBE_LINK: t('sources.UNSUBSCRIBE_LINK'),
    },
    byMember: t('byMember'),
    impersonated: t('impersonated'),
    policy: (version) => t('policy', { version }),
  };
}

const uuid = (n: number) => `01900000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const RECORDS: ConsentRecordDto[] = [
  {
    id: uuid(1),
    purpose: 'MARKETING',
    granted: false,
    source: 'DASHBOARD',
    policyVersion: null,
    actorUserId: uuid(9),
    impersonated: true,
    recordedAt: '2026-10-30T09:00:00.000Z',
  },
  {
    id: uuid(2),
    purpose: 'MARKETING',
    granted: true,
    source: 'IMPORT',
    policyVersion: null,
    actorUserId: null,
    impersonated: false,
    recordedAt: '2026-10-20T09:00:00.000Z',
  },
  {
    id: uuid(3),
    purpose: 'PROCESSING',
    granted: true,
    source: 'WEBSITE',
    policyVersion: 'draft-2026-11',
    actorUserId: null,
    impersonated: false,
    recordedAt: '2026-10-10T09:00:00.000Z',
  },
];

const render = (items: readonly ConsentRecordDto[] | null, locale: 'en' | 'es' = 'en') =>
  renderToStaticMarkup(
    <ConsentHistory items={items} labels={labelsFor(locale)} formatDate={(d) => d.toISOString().slice(0, 10)} />,
  );

describe('contact consent history', () => {
  it("[S16-F5] a contact's consent history lists every record with purpose, choice, source and policy version", () => {
    const html = render(RECORDS);
    expect(html.match(/<li /g)).toHaveLength(3);
    expect(html).toContain('Marketing: withdrawn');
    expect(html).toContain('In the dashboard · by support on a team member&#x27;s behalf');
    expect(html).toContain('Marketing: given');
    expect(html).toContain('Contact import');
    expect(html).toContain('Data processing: given');
    expect(html).toContain('Website form · privacy text draft-2026-11');
    expect(html).toContain('dateTime="2026-10-30T09:00:00.000Z"');
    // newest first, as the API answers
    expect(html.indexOf('2026-10-30')).toBeLessThan(html.indexOf('2026-10-10'));
    expect(render(RECORDS, 'es')).toContain('Importación de contactos');
  });

  it('[S16-F5] an empty or unavailable history says so', () => {
    expect(render([])).toContain('No consent recorded yet.');
    expect(render(null)).toContain('role="alert"');
  });
});
