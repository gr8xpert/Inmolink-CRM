import { loadMessages } from '@inmolink/i18n/server';
import { createTranslator } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RetentionNotice, type RetentionNoticeLabels, retentionView } from './retention-view';

const NOW = new Date('2026-11-01T10:00:00.000Z');

function labelsFor(locale: 'en' | 'es'): RetentionNoticeLabels {
  const t = createTranslator({ locale, messages: loadMessages(locale), namespace: 'agency.retention' });
  return {
    inForce: (months) => t('inForce', { months }),
    inForceOff: t('inForceOff'),
    pending: (months, date) => (months === null ? t('pendingOff', { date }) : t('pending', { months, date })),
    graceHint: t('graceHint'),
  };
}

const render = (dto: Parameters<typeof retentionView>[0], locale: 'en' | 'es' = 'en') =>
  renderToStaticMarkup(
    <RetentionNotice
      view={retentionView(dto, NOW)}
      labels={labelsFor(locale)}
      formatDate={(d) => d.toISOString().slice(0, 10)}
    />,
  );

describe('retention settings page', () => {
  it('[S16-F5] retention UI shows the effective date of a shortened period', () => {
    // 24 → 12 months, saved now: 12 applies after the 14-day grace window, 24 stays in force until then
    const dto = { inactiveContactMonths: 12, effectiveAt: '2026-11-15T10:00:00.000Z', previousMonths: 24 };
    expect(retentionView(dto, NOW)).toEqual({
      inForce: 24,
      pending: { months: 12, effectiveAt: new Date('2026-11-15T10:00:00.000Z') },
    });
    const html = render(dto);
    expect(html).toContain('contacts inactive for 24 months are anonymized');
    expect(html).toContain('The new period of 12 months applies on 2026-11-15');
    expect(html).toContain('data-testid="retention-pending"');
    expect(render(dto, 'es')).toContain('El nuevo periodo de 12 meses se aplica a partir del 2026-11-15');
  });

  it('[S16-F5] turning retention on waits out the grace window; a period in force shows no pending date', () => {
    const on = { inactiveContactMonths: 36, effectiveAt: '2026-11-15T10:00:00.000Z', previousMonths: null };
    const html = render(on);
    expect(html).toContain('In force now: off');
    expect(html).toContain('The new period of 36 months applies on 2026-11-15');
    // grace window over (or a longer period, applied at once): only the period in force
    const applied = { inactiveContactMonths: 36, effectiveAt: '2026-10-01T00:00:00.000Z', previousMonths: null };
    expect(retentionView(applied, NOW)).toEqual({ inForce: 36, pending: null });
    expect(render(applied)).not.toContain('retention-pending');
    expect(render({ inactiveContactMonths: null, effectiveAt: NOW.toISOString(), previousMonths: null })).toContain(
      'In force now: off',
    );
  });
});
