import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { collaborationQuery, parseCollaborationParams } from './filters';
import { DONE_NOTICES, parseDone, parseRefusal, REFUSALS, refusalOf } from './refusals';
import { developmentTarget, listingTarget, parseTargetParams } from './register/target';
import { collaborationBlock } from './rights';
import { termsText } from './terms-text';
import { mayBind, viewingControls } from './viewing-controls';

const NOW = new Date('2026-11-10T12:00:00.000Z');
const FUTURE = '2026-11-20T12:00:00.000Z';
const PAST = '2026-11-01T12:00:00.000Z';
const FAR = '2027-05-01T12:00:00.000Z';
const ID = '01900000-0000-7000-8000-000000000001';

const row = (patch: Partial<Parameters<typeof viewingControls>[0]> = {}): Parameters<typeof viewingControls>[0] => ({
  side: 'OWNER',
  status: 'REQUESTED',
  awaiting: 'OWNER',
  expiresAt: FUTURE,
  scheduledAt: null,
  target: { kind: 'LISTING', id: ID },
  terms: { validUntil: FAR },
  ...patch,
});
const controls = (
  patch: Partial<Parameters<typeof viewingControls>[0]> = {},
  o: { blocked?: boolean; bind?: boolean } = {},
) => viewingControls(row(patch), { now: NOW, blocked: o.blocked ?? false, mayBind: o.bind ?? true });

describe('[S17-F56] which actions for which state and side', () => {
  it('[S17-F56] the side awaited may accept, decline, propose another time and cancel', () => {
    expect(controls().actions).toEqual(['ACCEPT', 'DECLINE', 'RESCHEDULE', 'CANCEL']);
    expect(controls({ side: 'INTRODUCER', awaiting: 'INTRODUCER' }).actions).toEqual([
      'ACCEPT',
      'DECLINE',
      'RESCHEDULE',
      'CANCEL',
    ]);
  });

  it('[S17-F56] the side not awaited may only propose another time or cancel', () => {
    expect(controls({ side: 'INTRODUCER', awaiting: 'OWNER' }).actions).toEqual(['RESCHEDULE', 'CANCEL']);
    expect(controls({ side: 'OWNER', awaiting: 'INTRODUCER' }).actions).toEqual(['RESCHEDULE', 'CANCEL']);
  });

  it('[S17-F56] an owner member who may not bind the agency gets decline and cancel, and the reason', () => {
    const listing = controls({}, { bind: false });
    expect(listing.actions).toEqual(['DECLINE', 'CANCEL']);
    expect(listing.hints).toEqual(['BIND_LISTING']);
    const development = controls({ target: { kind: 'DEVELOPMENT', id: ID } }, { bind: false });
    expect(development.hints).toEqual(['BIND_DEVELOPMENT']);
  });

  it('[S17-F56] a scheduled viewing before its time can be moved or cancelled; the outcome comes later', () => {
    const c = controls({ status: 'SCHEDULED', awaiting: null, scheduledAt: FUTURE, expiresAt: null });
    expect(c.actions).toEqual(['RESCHEDULE', 'CANCEL']);
    expect(c.hints).toEqual(['OUTCOME_LATER']);
  });

  it('[S17-F56] after its time a scheduled viewing takes the outcome and can no longer be moved', () => {
    const c = controls({ status: 'SCHEDULED', awaiting: null, scheduledAt: PAST, expiresAt: null });
    expect(c.actions).toEqual(['OUTCOME', 'CANCEL']);
    expect(c.hints).toEqual([]);
  });

  it('[S17-F56] no new time is offered once the terms ended, since the API refuses any', () => {
    expect(controls({ terms: { validUntil: PAST } }).actions).toEqual(['ACCEPT', 'DECLINE', 'CANCEL']);
  });

  it('[S17-F56] a proposal past its expiry offers nothing and says so', () => {
    expect(controls({ expiresAt: PAST })).toEqual({ actions: [], hints: ['LAPSED'] });
  });

  for (const status of ['COMPLETED', 'DECLINED', 'CANCELLED', 'EXPIRED'] as const) {
    it(`[S17-F56] a ${status} viewing offers nothing`, () => {
      expect(controls({ status, awaiting: null })).toEqual({ actions: [], hints: [] });
    });
  }

  it('[S17-F56] a blocked member is offered nothing, in any open state', () => {
    expect(controls({}, { blocked: true }).actions).toEqual([]);
    expect(
      controls({ status: 'SCHEDULED', awaiting: null, scheduledAt: PAST, expiresAt: null }, { blocked: true }).actions,
    ).toEqual([]);
  });
});

describe('[S17-F56] who may bind the agency', () => {
  const owners = new Map([[ID, 'agent-1']]);
  const listing = { side: 'OWNER', target: { kind: 'LISTING', id: ID } } as const;
  it('[S17-F56] the introducer accepted by requesting', () => {
    expect(mayBind({ ...listing, side: 'INTRODUCER' }, { isAdmin: false, userId: 'x' }, new Map())).toBe(true);
  });
  it('[S17-F56] on the owner side: admins and the listing agent, nobody else', () => {
    expect(mayBind(listing, { isAdmin: true, userId: 'x' }, new Map())).toBe(true);
    expect(mayBind(listing, { isAdmin: false, userId: 'agent-1' }, owners)).toBe(true);
    expect(mayBind(listing, { isAdmin: false, userId: 'agent-2' }, owners)).toBe(false);
  });
  it('[S17-F56] an unknown listing agent or a development binds admins only', () => {
    expect(mayBind(listing, { isAdmin: false, userId: 'agent-1' }, new Map())).toBe(false);
    expect(
      mayBind(
        { side: 'OWNER', target: { kind: 'DEVELOPMENT', id: ID } },
        { isAdmin: false, userId: 'agent-1' },
        owners,
      ),
    ).toBe(false);
  });
});

describe('[S17-F56] refusals by error code', () => {
  it('[S17-F56] registration refusals keep their code', () => {
    for (const code of [
      'REGISTRATION_CONFLICT',
      'RATE_LIMITED',
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
  it('[S17-F56] every refusal and notice has its sentence in EN and ES', () => {
    for (const locale of ['en', 'es']) {
      const path = new URL(`../../../../../../../../packages/i18n/messages/${locale}/network.json`, import.meta.url);
      const { collaborations: c } = JSON.parse(readFileSync(path, 'utf8'));
      for (const key of REFUSALS) expect(c.errors[key], `${locale} errors.${key}`).toEqual(expect.any(String));
      for (const key of DONE_NOTICES) expect(c.done[key], `${locale} done.${key}`).toEqual(expect.any(String));
    }
  });
});

describe('[S17-F56] who is offered the controls', () => {
  const member = (patch: Partial<{ role: string; clientMode: boolean; impersonating: boolean }> = {}) =>
    ({
      kind: 'member',
      caps: { role: 'AGENT', clientMode: false, impersonating: false, sections: [], ...patch },
    }) as Parameters<typeof collaborationBlock>[0];
  it('[S17-F56] a member of a verified agency is not blocked', () => {
    expect(collaborationBlock(member(), 'VERIFIED')).toBeNull();
    expect(collaborationBlock(member({ role: 'DEVELOPER_ADMIN' }), 'VERIFIED')).toBeNull();
  });
  it('[S17-F56] an unverified or suspended agency is told so', () => {
    expect(collaborationBlock(member(), 'PENDING')).toBe('UNVERIFIED');
    expect(collaborationBlock(member(), 'SUSPENDED')).toBe('UNVERIFIED');
  });
  it('[S17-F56] Client Mode, support acting as a member and other roles are refused, whatever the agency', () => {
    expect(collaborationBlock(member({ clientMode: true }), 'VERIFIED')).toBe('CLIENT_MODE');
    expect(collaborationBlock(member({ impersonating: true }), 'VERIFIED')).toBe('IMPERSONATING');
    expect(collaborationBlock(member({ role: 'PARTNER' }), 'VERIFIED')).toBe('ROLE');
    expect(collaborationBlock({ kind: 'unknown' })).toBe('ROLE');
  });
  it('[S17-F56] an unread agency status blocks nothing: the API decides', () => {
    expect(collaborationBlock(member(), null)).toBeNull();
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
    });
    expect(listingTarget({ id: ID, ref: 'R', private: {}, commission: null } as never, null, 'en')).toMatchObject({
      own: true,
      terms: null,
      title: null,
    });
    const development = {
      id: ID,
      ref: 'D-1',
      name: 'Marina',
      access: null,
      commission: { type: 'FIXED', amount: { amountCents: 500_000, currency: 'EUR' }, includesVat: false },
      commissionSplitBp: 6000,
    } as never;
    expect(developmentTarget(development)).toMatchObject({
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
});
