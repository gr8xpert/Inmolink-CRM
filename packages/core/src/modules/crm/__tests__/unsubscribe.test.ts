import { configureHmacRotation } from '@inmolink/platform/crypto';
import { newId } from '@inmolink/platform/ids';
import { defaultSubscribers } from '@inmolink/platform/outbox';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { crmJobs } from '../jobs';
import { registerCrmSubscriptions, unregisterCrmSubscriptions } from '../subscriptions';
import {
  configureUnsubscribeLinks,
  readUnsubscribeToken,
  UNSUBSCRIBE_TOKEN,
  unsubscribeLinksConfigured,
  unsubscribeToken,
  unsubscribeUrl,
} from '../unsubscribe';

/** The unsubscribe link's signed token (R2-02g): no PII, bound to one contact of one agency, unforgeable. */

const KEY = 'test-hmac-key-0123456789abcdef0123456789';
const OTHER = 'other-hmac-key-0123456789abcdef01234567';
const agencyId = newId();
const contactId = newId();

beforeEach(() => configureUnsubscribeLinks({ tokenKey: KEY, publicBaseUrl: 'https://sites.example/' }));
afterEach(() => configureHmacRotation({ current: KEY }));

/** The token with one character changed at `at` (to another base64url character). */
const flip = (token: string, at: number) => token.slice(0, at) + (token[at] === 'A' ? 'B' : 'A') + token.slice(at + 1);

describe('unsubscribe tokens (R2-02g)', () => {
  it('[R2-02g] token round-trip: the same 64-character token for a contact names its agency and contact', () => {
    const token = unsubscribeToken(agencyId, contactId);
    expect(token).toMatch(UNSUBSCRIBE_TOKEN);
    expect(unsubscribeToken(agencyId, contactId)).toBe(token);
    expect(readUnsubscribeToken(token)).toEqual({ agencyId, contactId });
    expect(unsubscribeToken(agencyId, newId())).not.toBe(token);
    // the link: the public origin, the token and the page language — no name, e-mail or phone
    expect(unsubscribeUrl({ agencyId, contactId, locale: 'es' })).toBe(`https://sites.example/u/${token}?l=es`);
    expect(unsubscribeUrl({ agencyId, contactId, locale: 'en-GB' })).toBe(`https://sites.example/u/${token}?l=en`);
    expect(unsubscribeLinksConfigured()).toBe(true);
  });

  it('[R2-02g] a forged or tampered token is refused', () => {
    const token = unsubscribeToken(agencyId, contactId);
    // every position: the version, the agency, the contact and the MAC are all covered
    for (let at = 0; at < token.length; at += 1) expect(readUnsubscribeToken(flip(token, at)), String(at)).toBeNull();
    expect(readUnsubscribeToken(token.slice(0, -1))).toBeNull();
    expect(readUnsubscribeToken(`${token}A`)).toBeNull();
    expect(readUnsubscribeToken('')).toBeNull();
    expect(readUnsubscribeToken('x'.repeat(64))).toBeNull();
    expect(readUnsubscribeToken(`${token.slice(0, 63)}=`)).toBeNull();
    // another contact's ids with this token's MAC
    const payload = Buffer.from(token, 'base64url');
    Buffer.from(newId().replaceAll('-', ''), 'hex').copy(payload, 17);
    expect(readUnsubscribeToken(payload.toString('base64url'))).toBeNull();
    // made under another key
    configureUnsubscribeLinks({ tokenKey: OTHER, publicBaseUrl: 'https://sites.example' });
    const forged = unsubscribeToken(agencyId, contactId);
    configureUnsubscribeLinks({ tokenKey: KEY, publicBaseUrl: 'https://sites.example' });
    expect(readUnsubscribeToken(forged)).toBeNull();
  });

  it('[R2-02g] links in old e-mails keep working through an HMAC_KEY rotation while the previous key verifies', () => {
    const old = unsubscribeToken(agencyId, contactId);
    configureUnsubscribeLinks({ tokenKey: OTHER, publicBaseUrl: 'https://sites.example' });
    configureHmacRotation({ current: OTHER, previous: KEY });
    expect(readUnsubscribeToken(old)).toEqual({ agencyId, contactId });
    configureHmacRotation({ current: OTHER });
    expect(readUnsubscribeToken(old)).toBeNull();
  });

  it('[R2-02g] no link without a public origin', () => {
    configureUnsubscribeLinks({ tokenKey: KEY, publicBaseUrl: null });
    expect(unsubscribeLinksConfigured()).toBe(false);
    expect(unsubscribeUrl({ agencyId, contactId, locale: 'en' })).toBeNull();
    expect(() => configureUnsubscribeLinks({ tokenKey: KEY, publicBaseUrl: 'https://x.example/path' })).toThrow();
  });
});

describe('unsubscribe request → job (R2-02g)', () => {
  it('[R2-02g] each request event queues one crm.applyUnsubscribe (job id = the event id, the request time)', async () => {
    const queued: unknown[] = [];
    const spy = vi.spyOn(crmJobs.applyUnsubscribe, 'enqueue').mockImplementation(async (p) => {
      queued.push(p);
      return { id: 'test' };
    });
    registerCrmSubscriptions();
    const eventId = newId();
    const createdAt = new Date('2026-11-07T10:00:00Z');
    try {
      const subs = defaultSubscribers
        .get('crm.contact.unsubscribeRequested', 1)
        .filter((s) => s.name === 'crm.contact.unsubscribe');
      expect(subs).toHaveLength(1);
      for (const s of subs) {
        await s.handler(
          { agencyId, contactId } as never,
          {
            eventId,
            agencyId,
            type: 'crm.contact.unsubscribeRequested',
            version: 1,
            createdAt,
            attempt: 1,
          } as never,
        );
      }
    } finally {
      unregisterCrmSubscriptions();
      spy.mockRestore();
    }
    expect(queued).toEqual([{ eventId, agencyId, contactId, requestedAt: createdAt.toISOString() }]);
    expect(crmJobs.applyUnsubscribe.spec.jobId?.(queued[0] as never)).toBe(eventId);
    expect(crmJobs.applyUnsubscribe.spec.pool).toBe('email');
  });
});
