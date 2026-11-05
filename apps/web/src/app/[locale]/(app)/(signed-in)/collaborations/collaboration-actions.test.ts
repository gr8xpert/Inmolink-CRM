import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { collaborationQuery, parseCollaborationParams } from './filters';
import { DONE_NOTICES, parseDone, parseRefusal, REFUSALS, refusalOf } from './refusals';
import { developmentTarget, listingTarget, parseTargetParams } from './register/target';
import { collaborationBlock } from './rights';
import { formatMoney, termsText, termsTools } from './terms-text';
import { viewingHints } from './viewing-controls';

const NOW = new Date('2026-11-10T12:00:00.000Z');
const FUTURE = '2026-11-20T12:00:00.000Z';
const PAST = '2026-11-01T12:00:00.000Z';
const ID = '01900000-0000-7000-8000-000000000001';

type HintRow = Parameters<typeof viewingHints>[0];
const row = (patch: Partial<HintRow> = {}): HintRow => ({
  status: 'REQUESTED',
  expiresAt: FUTURE,
  target: { kind: 'LISTING', id: ID },
  mayBind: true,
  allowedActions: ['ACCEPT', 'DECLINE', 'RESCHEDULE', 'CANCEL'],
  ...patch,
});

describe('[S17-F56] why a viewing row offers less (the actions are the API’s)', () => {
  it('[S17-F56] a member who may not bind is told who can, by target kind', () => {
    expect(viewingHints(row({ mayBind: false, allowedActions: ['DECLINE', 'CANCEL'] }), NOW)).toEqual(['BIND_LISTING']);
    expect(
      viewingHints(
        row({ mayBind: false, allowedActions: ['DECLINE', 'CANCEL'], target: { kind: 'DEVELOPMENT', id: ID } }),
        NOW,
      ),
    ).toEqual(['BIND_DEVELOPMENT']);
  });
  it('[S17-F56] a scheduled viewing before its time says the outcome comes later; after it, nothing', () => {
    expect(viewingHints(row({ status: 'SCHEDULED', allowedActions: ['RESCHEDULE', 'CANCEL'] }), NOW)).toEqual([
      'OUTCOME_LATER',
    ]);
    expect(viewingHints(row({ status: 'SCHEDULED', allowedActions: ['OUTCOME', 'CANCEL'] }), NOW)).toEqual([]);
  });
  it('[S17-F56] a lapsed proposal says so', () => {
    expect(viewingHints(row({ expiresAt: PAST, allowedActions: [] }), NOW)).toEqual(['LAPSED']);
  });
  it('[S17-F56] closed rows, and members who may not answer at all, get no row sentence', () => {
    expect(viewingHints(row({ status: 'DECLINED', allowedActions: [] }), NOW)).toEqual([]);
    expect(viewingHints(row({ mayBind: false, allowedActions: [] }), NOW)).toEqual([]);
  });
});

describe('[S17-F56] refusals by error code', () => {
  it('[S17-F56] registration, gate and viewing refusals keep their code', () => {
    for (const code of [
      'REGISTRATION_CONFLICT',
      'RATE_LIMITED',
      'NETWORK_GIVE_TO_GET_LOCKED',
      'REGISTRATION_TARGET_NOT_FOUND',
      'FORBIDDEN',
      'CONTACT_NOT_FOUND',
      'VIEWING_TERMS_INCOMPLETE',
      'VIEWING_REQUEST_OPEN',
      'IDEMPOTENCY_KEY_REUSED',
    ]) {
      expect(refusalOf({ code })).toBe(code);
    }
  });
  it('[S17-F56] a validation refusal says which reason', () => {
    expect(refusalOf({ code: 'VALIDATION_FAILED', details: { reason: 'past' } })).toBe('PAST');
    expect(refusalOf({ code: 'VALIDATION_FAILED', details: { reason: 'after_registration' } })).toBe(
      'AFTER_REGISTRATION',
    );
    expect(refusalOf({ code: 'VALIDATION_FAILED', details: { reason: 'no_email_or_phone' } })).toBe(
      'NO_EMAIL_OR_PHONE',
    );
    expect(refusalOf({ code: 'VALIDATION_FAILED' })).toBe('VALIDATION_FAILED');
  });
  it('[S17-F56] a state refusal says which reason, and an unknown one that the viewing changed', () => {
    for (const [reason, key] of [
      ['closed', 'STATE_CLOSED'],
      ['expired', 'STATE_EXPIRED'],
      ['not_awaiting', 'STATE_NOT_AWAITING'],
      ['too_late', 'STATE_TOO_LATE'],
      ['not_scheduled', 'STATE_NOT_SCHEDULED'],
      ['too_early', 'STATE_TOO_EARLY'],
      ['changed', 'STATE_CHANGED'],
      ['something_new', 'STATE_CHANGED'],
    ]) {
      expect(refusalOf({ code: 'VIEWING_REQUEST_STATE', details: { reason } })).toBe(key);
    }
  });
  it('[S17-F56] no error or an unexpected code is the neutral sentence', () => {
    expect(refusalOf(null)).toBe('generic');
    expect(refusalOf({ code: 'SOMETHING_ELSE' })).toBe('generic');
  });
  it('[S17-F56] the query parameters take only known keys', () => {
    expect(parseRefusal(undefined)).toBeNull();
    expect(parseRefusal('REGISTRATION_CONFLICT')).toBe('REGISTRATION_CONFLICT');
    expect(parseRefusal('<script>')).toBe('generic');
    expect(parseDone('alreadyRegistered')).toBe('alreadyRegistered');
    expect(parseDone('nope')).toBeNull();
    expect(parseDone(undefined)).toBeNull();
  });
  it('[S17-F56] every refusal, notice and block has its sentence in EN and ES', () => {
    for (const locale of ['en', 'es']) {
      const path = new URL(`../../../../../../../../packages/i18n/messages/${locale}/network.json`, import.meta.url);
      const { collaborations: c } = JSON.parse(readFileSync(path, 'utf8'));
      for (const key of REFUSALS) expect(c.errors[key], `${locale} errors.${key}`).toEqual(expect.any(String));
      for (const key of DONE_NOTICES) expect(c.done[key], `${locale} done.${key}`).toEqual(expect.any(String));
      for (const key of ['CLIENT_MODE', 'IMPERSONATING', 'ROLE', 'UNVERIFIED', 'LOCKED']) {
        expect(c.blocked[key], `${locale} blocked.${key}`).toEqual(expect.any(String));
      }
    }
  });
});

describe('[S17-F56] who is offered a new collaboration', () => {
  const member = (patch: Partial<{ role: string; clientMode: boolean; impersonating: boolean }> = {}) =>
    ({
      kind: 'member',
      caps: { role: 'AGENT', clientMode: false, impersonating: false, sections: [], ...patch },
    }) as Parameters<typeof collaborationBlock>[0];
  it('[S17-F56] a member of a verified agency with an open gate is not blocked', () => {
    expect(collaborationBlock(member(), { status: 'VERIFIED', gate: 'OPEN' })).toBeNull();
    expect(collaborationBlock(member({ role: 'DEVELOPER_ADMIN' }), { status: 'VERIFIED', gate: 'GRACE' })).toBeNull();
    expect(collaborationBlock(member(), { status: 'VERIFIED', gate: 'EXEMPT' })).toBeNull();
  });
  it('[S17-F56] an unverified or suspended agency is told so', () => {
    expect(collaborationBlock(member(), { status: 'PENDING' })).toBe('UNVERIFIED');
    expect(collaborationBlock(member(), { status: 'SUSPENDED', gate: 'LOCKED' })).toBe('UNVERIFIED');
  });
  it('[S17-F56] a give-to-get locked agency starts nothing new', () => {
    expect(collaborationBlock(member(), { status: 'VERIFIED', gate: 'LOCKED' })).toBe('LOCKED');
  });
  it('[S17-F56] Client Mode, support acting as a member and other roles are refused, whatever the agency', () => {
    const fine = { status: 'VERIFIED', gate: 'OPEN' } as const;
    expect(collaborationBlock(member({ clientMode: true }), fine)).toBe('CLIENT_MODE');
    expect(collaborationBlock(member({ impersonating: true }), fine)).toBe('IMPERSONATING');
    expect(collaborationBlock(member({ role: 'PARTNER' }), fine)).toBe('ROLE');
    expect(collaborationBlock({ kind: 'unknown' })).toBe('ROLE');
  });
  it('[S17-F56] an unread agency status or gate blocks nothing: the API decides', () => {
    expect(collaborationBlock(member(), { status: null, gate: null })).toBeNull();
  });
});

describe('[S17-F56] filters and targets', () => {
  it('[S17-F56] the filters come back as the same query, without notices or unknown values', () => {
    const q = collaborationQuery(
      parseCollaborationParams({
        direction: 'IN',
        type: 'VIEWING',
        state: 'SCHEDULED',
        kind: 'LISTING',
        from: '2026-11-01',
        to: '2026-11-30',
        cursor: 'abc_1',
        error: 'REGISTRATION_CONFLICT',
        done: 'accepted',
        evil: 'x',
      }),
    );
    expect(q).toEqual({
      direction: 'IN',
      type: 'VIEWING',
      state: 'SCHEDULED',
      kind: 'LISTING',
      from: '2026-11-01',
      to: '2026-11-30',
      cursor: 'abc_1',
    });
    expect(collaborationQuery(parseCollaborationParams({ direction: 'SIDEWAYS' }))).toEqual({});
  });
  it('[S17-F56] the register page takes a target kind and a uuid, nothing else', () => {
    expect(parseTargetParams({ kind: 'LISTING', id: ID })).toEqual({ kind: 'LISTING', id: ID });
    expect(parseTargetParams({ kind: 'UNIT', id: ID })).toBeNull();
    expect(parseTargetParams({ kind: 'LISTING', id: 'x' })).toBeNull();
    expect(parseTargetParams({})).toBeNull();
  });
  it('[S17-F56] the target tells another agency from the own one and reads the terms', () => {
    const listing = {
      id: ID,
      ref: 'INM-1',
      private: null,
      commission: { total: { type: 'PCT', basisPoints: 300, includesVat: true }, splitBp: 5000 },
    } as never;
    const content = {
      translations: [
        { locale: 'en', title: 'Villa' },
        { locale: 'es', title: 'Chalet' },
      ],
    } as never;
    expect(listingTarget(listing, content, 'es')).toEqual({
      kind: 'LISTING',
      id: ID,
      reference: 'INM-1',
      title: 'Chalet',
      own: false,
      terms: { commissionBp: 300, commissionFixed: null, splitBp: 5000, includesVat: true },
      viewingTermsComplete: true,
    });
    expect(listingTarget({ id: ID, ref: 'R', private: {}, commission: null } as never, null, 'en')).toMatchObject({
      own: true,
      terms: null,
      title: null,
    });
  });
  it('[S17-F56] the no-terms notice: a listing without commission or split, a development without commission', () => {
    const listing = (total: unknown, splitBp: number | null) =>
      listingTarget({ id: ID, ref: 'R', private: null, commission: { total, splitBp } } as never, null, 'en');
    const pct = { type: 'PCT', basisPoints: 300, includesVat: false };
    expect(listing(pct, 5000).viewingTermsComplete).toBe(true);
    expect(listing(pct, null).viewingTermsComplete).toBe(false);
    expect(listing(null, 5000).viewingTermsComplete).toBe(false);
    const development = (commission: unknown, commissionSplitBp: number | null) =>
      developmentTarget({ id: ID, ref: 'D', name: 'Marina', access: null, commission, commissionSplitBp } as never);
    // a development's split always has a value (5000 unless the owner set another)
    expect(development(pct, 5000).viewingTermsComplete).toBe(true);
    expect(development(null, 5000).viewingTermsComplete).toBe(false);
    expect(
      development({ type: 'FIXED', amount: { amountCents: 500_000, currency: 'EUR' }, includesVat: false }, 6000),
    ).toMatchObject({
      own: false,
      terms: { commissionBp: null, commissionFixed: { amountCents: 500_000, currency: 'EUR' }, splitBp: 6000 },
    });
  });
});

describe('[S17-F56] terms as one line', () => {
  const tools = {
    t: (key: string, values?: Record<string, string>) => `${key}${values ? JSON.stringify(values) : ''}`,
    money: (m: { amountCents: number; currency: string }) => `${m.amountCents / 100} ${m.currency}`,
    percent: (bp: number) => `${bp / 100}%`,
  };
  const base = { commissionBp: null, commissionFixed: null, splitBp: 5000, includesVat: false };
  it('[S17-F56] a percentage, a fixed amount, VAT, an unknown split, and none at all', () => {
    expect(termsText({ ...base, commissionBp: 300 }, tools)).toBe('pct{"total":"3%","split":"50%"}');
    expect(termsText({ ...base, commissionFixed: { amountCents: 500_000, currency: 'EUR' } }, tools)).toBe(
      'fixed{"amount":"5000 EUR","split":"50%"}',
    );
    expect(termsText({ ...base, commissionBp: 300, includesVat: true }, tools)).toBe(
      'pct{"total":"3%","split":"50%"} (vat)',
    );
    expect(termsText({ ...base, commissionBp: 300, splitBp: null }, tools)).toBe(
      'pct{"total":"3%","split":"splitUnknown"}',
    );
    expect(termsText(null, tools)).toBe('none');
  });

  // The page's formatter is Intl underneath: the same options give the same text.
  const intl = {
    number: (value: number, options: Intl.NumberFormatOptions) => new Intl.NumberFormat('en', options).format(value),
  } as unknown as Parameters<typeof formatMoney>[0];
  it('[S17-F56] money keeps its cents when it has some, and whole amounts stay whole', () => {
    expect(formatMoney(intl, { amountCents: 500_000, currency: 'EUR' })).toBe('€5,000');
    expect(formatMoney(intl, { amountCents: 500_050, currency: 'EUR' })).toBe('€5,000.50');
    expect(formatMoney(intl, { amountCents: 99, currency: 'EUR' })).toBe('€0.99');
  });
  it('[S17-F56] the shared tools format a fixed commission and a percentage the same on every screen', () => {
    const t = (key: string, values?: Record<string, string>) => `${key}:${values?.amount ?? values?.total}`;
    const shared = termsTools(intl, t as never);
    expect(termsText({ ...base, commissionFixed: { amountCents: 1_234_567, currency: 'EUR' } }, shared)).toBe(
      'fixed:€12,345.67',
    );
    expect(termsText({ ...base, commissionBp: 275 }, shared)).toBe('pct:2.75%');
  });
});
