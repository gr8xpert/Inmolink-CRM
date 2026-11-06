import type { ClientProfileMatchDto } from '@inmolink/contracts';
import { loadMessages } from '@inmolink/i18n/server';
import { createTranslator } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { MatchList } from './match-list';
import { backQuery, doneStatus, parseMove, parseQueueState, viewQuery } from './query';

vi.mock('@/i18n/navigation', () => ({
  Link: (p: { href: unknown; children: unknown }) => <a href={JSON.stringify(p.href)}>{p.children as string}</a>,
}));

const uuid = (n: number) => `01900000-0000-7000-8000-${String(n).padStart(12, '0')}`;

const match = (patch: Partial<ClientProfileMatchDto> = {}): ClientProfileMatchDto => ({
  id: uuid(1),
  profileId: uuid(2),
  contact: { id: uuid(3), firstName: 'Ana', lastName: 'García' },
  status: 'PENDING_REVIEW',
  score: 0.87,
  network: true,
  card: {
    kind: 'LISTING',
    id: uuid(4),
    ref: 'MB-1',
    status: 'ACTIVE',
    transactionType: 'SALE',
    price: { amountCents: 95_000_000, currency: 'EUR', onRequest: false },
    propertyType: { id: uuid(5), name: 'Villa' },
    place: { country: null, region: null, city: { id: uuid(6), name: 'Marbella' }, area: null },
    bedrooms: 4,
    bathrooms: 3,
    builtM2: 250,
    plotM2: null,
    geo: null,
    cover: null,
    imageCount: 0,
    developmentId: null,
    title: 'Villa with sea view',
    slug: 'villa',
    textLocale: null,
  } as never,
  explanation: {
    summary: '6/7 criteria met',
    reasons: [
      { key: 'location', ok: true, text: 'In a wanted area' },
      { key: 'price', ok: false, text: '6% over budget' },
    ],
  },
  selectionId: null,
  createdAt: '2026-11-07T10:00:00.000Z',
  updatedAt: '2026-11-07T10:00:00.000Z',
  ...patch,
});

function render(
  locale: 'en' | 'es',
  items: ClientProfileMatchDto[],
  status: 'PENDING_REVIEW' | 'DISMISSED' = 'PENDING_REVIEW',
) {
  const t = createTranslator({ locale, messages: loadMessages(locale), namespace: 'contacts.matchQueue' });
  return renderToStaticMarkup(
    <MatchList
      items={items}
      status={status}
      t={(key, values) => t(key as never, values as never)}
      money={(c, cur) => `${cur} ${c / 100}`}
      number={(n) => String(n)}
      percent={(f) => `${Math.round(f * 100)}%`}
      back={{ contact: uuid(3) }}
      move="/move"
    />,
  );
}

describe('review queue page (R2-02d)', () => {
  it('[R2-02d] a match shows its card, client, score and met / not-met chips (text, not colour only), in EN and ES', () => {
    const en = render('en', [match()]);
    expect(en).toContain('Villa with sea view');
    expect(en).toContain('MB-1 · Network listing');
    expect(en).toContain('EUR 950000');
    expect(en).toContain('Marbella · Villa · 4 bedrooms · 250 m²');
    expect(en).toContain('For Ana García');
    expect(en).toContain('Match 87%');
    expect(en).toContain('<span class="sr-only">Met: </span>In a wanted area');
    expect(en).toContain('<span class="sr-only">Not met: </span>6% over budget');
    const es = render('es', [match()]);
    expect(es).toContain('Inmueble de la red');
    expect(es).toContain('Coincidencia 87%');
    expect(es).toContain('<span class="sr-only">No cumple: </span>');
  });

  it('[R2-02d] pending matches offer approve and dismiss, dismissed ones restore; each form keeps the view', () => {
    const pending = render('en', [match()]);
    expect(pending).toContain('aria-label="Approve Villa with sea view for Ana García"');
    expect(pending).toContain('aria-label="Dismiss Villa with sea view for Ana García"');
    expect(pending).not.toContain('Restore');
    expect(pending).toContain(`name="back.contact" value="${uuid(3)}"`);
    const dismissed = render('en', [match({ status: 'DISMISSED' })], 'DISMISSED');
    expect(dismissed).toContain('aria-label="Restore Villa with sea view for Ana García"');
    expect(dismissed).not.toContain('>Approve<');
    expect(render('en', [])).toContain('Nothing to review.');
    expect(render('es', [], 'DISMISSED')).toContain('No hay coincidencias descartadas.');
  });

  it('[R2-02d] URL state: one filter, known values only; moves and outcomes parsed strictly', () => {
    expect(parseQueueState({ status: 'DISMISSED', contact: uuid(3), cursor: 'abc_-1' })).toEqual({
      status: 'DISMISSED',
      contact: uuid(3),
      cursor: 'abc_-1',
    });
    // a profile wins over a contact; junk is dropped
    expect(parseQueueState({ status: 'SENT', contact: uuid(3), profile: uuid(2), cursor: 'a b' })).toEqual({
      status: 'PENDING_REVIEW',
      profile: uuid(2),
    });
    expect(viewQuery({ status: 'PENDING_REVIEW', contact: uuid(3), cursor: 'x' })).toEqual({ contact: uuid(3) });
    const f = new FormData();
    f.set('id', uuid(1));
    f.set('move', 'approve');
    f.set('back.status', 'DISMISSED');
    f.set('back.contact', 'not-an-id');
    expect(parseMove(f)).toEqual({ id: uuid(1), move: 'approve' });
    expect(backQuery(f)).toEqual({ status: 'DISMISSED' });
    f.set('move', 'send');
    expect(parseMove(f)).toBeNull();
    expect(doneStatus('APPROVED')).toBe('APPROVED');
    expect(doneStatus('<script>')).toBeNull();
  });
});
