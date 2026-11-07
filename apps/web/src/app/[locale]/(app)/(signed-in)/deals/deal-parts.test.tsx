import type { DealDto } from '@inmolink/contracts';
import { loadMessages } from '@inmolink/i18n/server';
import { createTranslator } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { dealEligible } from '../collaborations/viewing-controls';
import { CommissionBreakdown, type Formatters, Handshake, StageTimeline, targetText } from './deal-parts';
import {
  advanceTargets,
  handshake,
  noticeOf,
  parseDealsState,
  parsePrice,
  reasonOf,
  seenPriceOf,
  timelineSteps,
} from './query';

const uuid = (n: number) => `01900000-0000-7000-8000-${String(n).padStart(12, '0')}`;

const deal = (patch: Partial<DealDto> = {}): DealDto => ({
  id: uuid(1),
  viewingRequestId: uuid(2),
  target: { kind: 'LISTING', id: uuid(3) },
  stage: 'RESERVATION',
  stageAt: '2026-11-07T10:00:00.000Z',
  price: { amountCents: 58_000_001, currency: 'EUR' },
  terms: {
    commissionBp: 350,
    commissionFixed: null,
    splitBp: 6000,
    includesVat: true,
    snapshotAt: '2026-11-01T10:00:00.000Z',
  },
  commission: {
    totalCents: 2_030_000,
    introducerShareCents: 1_218_000,
    ownerShareCents: 812_000,
    currency: 'EUR',
    includesVat: true,
  },
  ownerConfirmedAt: null,
  introducerConfirmedAt: '2026-11-07T11:00:00.000Z',
  completedAt: null,
  fellThroughAt: null,
  fellThroughReason: null,
  closedBy: null,
  mediatedAt: null,
  mediationReason: null,
  createdAt: '2026-11-06T10:00:00.000Z',
  updatedAt: '2026-11-07T11:00:00.000Z',
  party: 'INTRODUCER',
  counterpartAgencyId: uuid(4),
  counterpartName: 'Costa Homes',
  targetLabel: { reference: 'CH-12', title: 'Sea view villa' },
  allowedActions: ['ADVANCE', 'SET_PRICE', 'WITHDRAW', 'FALL_THROUGH', 'DISPUTE'],
  ...patch,
});

const f = (locale: 'en' | 'es'): Formatters => {
  const t = createTranslator({ locale, messages: loadMessages(locale), namespace: 'network.deals' });
  return {
    t: (key, values) => t(key as never, values as never),
    money: (c, cur) => `${cur} ${(c / 100).toFixed(2)}`,
    percent: (bp) => `${bp / 100}%`,
    date: (iso) => iso.slice(0, 10),
  };
};

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

describe('deal room (R2-04c)', () => {
  it('[R2-04c] the commission breakdown shows the snapshot’s amounts to the cent and names the caller’s share', () => {
    const en = renderToStaticMarkup(<CommissionBreakdown deal={deal()} {...f('en')} />);
    expect(en).toContain('EUR 580000.01');
    expect(en).toContain('EUR 20300.00');
    expect(en).toContain('EUR 12180.00');
    expect(en).toContain('EUR 8120.00');
    expect(en).toMatch(/Introducing agency’s share \(yours\)/);
    expect(en).toContain('3.5% of the price');
    expect(en).toContain('60% to the introducer');
    expect(en).toContain('VAT included');
    const owner = renderToStaticMarkup(
      <CommissionBreakdown
        deal={deal({
          party: 'OWNER',
          terms: {
            commissionBp: null,
            commissionFixed: { amountCents: 1_500_000, currency: 'EUR' },
            splitBp: 4000,
            includesVat: false,
            snapshotAt: '2026-11-01T10:00:00.000Z',
          },
        })}
        {...f('es')}
      />,
    );
    expect(owner).toMatch(/Parte de la agencia propietaria \(la tuya\)/);
    expect(owner).toContain('EUR 15000.00 fijos');
    expect(owner).toContain('IVA no incluido');
  });

  it('[R2-04c] the stage timeline marks done, current and later stages; a fallen-through deal shows why', () => {
    expect(timelineSteps(deal()).map((s) => s.state)).toEqual(['done', 'current', 'next', 'next']);
    expect(
      timelineSteps(deal({ stage: 'COMPLETION', completedAt: '2026-11-08T00:00:00.000Z' })).map((s) => s.state),
    ).toEqual(['done', 'done', 'done', 'done']);
    expect(timelineSteps(deal({ stage: 'FELL_THROUGH' })).every((s) => s.state === 'skipped')).toBe(true);
    const html = renderToStaticMarkup(
      <StageTimeline
        deal={deal({
          stage: 'FELL_THROUGH',
          fellThroughAt: '2026-11-08T00:00:00.000Z',
          fellThroughReason: 'Buyer withdrew',
          closedBy: 'OWNER',
          mediatedAt: '2026-11-09T00:00:00.000Z',
          mediationReason: 'Checked with both',
        })}
        {...f('en')}
      />,
    );
    expect(html).toContain('Fell through (closed by the owner): Buyer withdrew');
    expect(html).toContain('Inmolink mediated on 2026-11-09: Checked with both');
    expect(renderToStaticMarkup(<StageTimeline deal={deal()} {...f('en')} />)).toContain('aria-current="step"');
  });

  it('[R2-04c] the handshake shows each side’s half from the caller’s side', () => {
    expect(handshake(deal())).toEqual({ mine: '2026-11-07T11:00:00.000Z', theirs: null });
    expect(handshake(deal({ party: 'OWNER' }))).toEqual({ mine: null, theirs: '2026-11-07T11:00:00.000Z' });
    const html = renderToStaticMarkup(<Handshake deal={deal()} {...f('en')} />);
    expect(html).toContain('Your agency: confirmed 2026-11-07');
    expect(html).toContain('The other agency: not confirmed yet');
  });

  it('[R2-04c] forms parse prices, the seen price and reasons; the URL state drops anything unknown', () => {
    expect(parsePrice('580000', 'EUR')).toEqual({ amountCents: 58_000_000, currency: 'EUR' });
    expect(parsePrice('580.000,01', 'EUR')).toEqual({ amountCents: 58_000_001, currency: 'EUR' });
    expect(parsePrice('1,250,000', 'EUR')).toEqual({ amountCents: 125_000_000, currency: 'EUR' });
    expect(parsePrice('250000.5', 'GBP')).toEqual({ amountCents: 25_000_050, currency: 'GBP' });
    for (const bad of ['', '0', '-5', 'abc', '1.2.3,456']) expect(parsePrice(bad, 'EUR')).toBeNull();
    expect(parsePrice('100', 'eur')).toBeNull();
    expect(seenPriceOf(form({ seenCents: '58000001', currency: 'EUR' }))).toEqual({
      amountCents: 58_000_001,
      currency: 'EUR',
    });
    expect(seenPriceOf(form({ seenCents: '1e5', currency: 'EUR' }))).toBeNull();
    expect(reasonOf(form({ reason: '  late payment ' }))).toBe('late payment');
    expect(reasonOf(form({ reason: '   ' }))).toBeNull();
    expect(reasonOf(form({ reason: 'x'.repeat(2001) }))).toBeNull();
    expect(parseDealsState({ stage: 'ARRAS', cursor: 'abc_1' })).toEqual({ stage: 'ARRAS', cursor: 'abc_1' });
    expect(parseDealsState({ stage: 'NOPE', cursor: '<script>' })).toEqual({});
    expect(noticeOf('disputed')).toBe('disputed');
    expect(noticeOf('evil')).toBeNull();
    expect(advanceTargets('OFFER')).toEqual(['RESERVATION', 'ARRAS']);
    expect(advanceTargets('ARRAS')).toEqual([]);
    expect(targetText(f('en').t, deal())).toBe('Listing CH-12 · Sea view villa');
  });

  it('[R2-04c] an accepted viewing offers to open its deal to members who bind the agency', () => {
    const v = {
      status: 'SCHEDULED',
      outcome: null,
      mayBind: true,
      terms: { accepted: true },
    } as unknown as Parameters<typeof dealEligible>[0];
    expect(dealEligible(v)).toBe(true);
    expect(dealEligible({ ...v, mayBind: false })).toBe(false);
    expect(dealEligible({ ...v, terms: { ...v.terms, accepted: false } })).toBe(false);
    expect(dealEligible({ ...v, status: 'COMPLETED', outcome: 'ATTENDED' })).toBe(true);
    expect(dealEligible({ ...v, status: 'COMPLETED', outcome: 'NO_SHOW' })).toBe(false);
    expect(dealEligible({ ...v, status: 'REQUESTED' })).toBe(false);
  });
});
