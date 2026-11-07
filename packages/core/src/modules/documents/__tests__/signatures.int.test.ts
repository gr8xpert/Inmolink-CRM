import { createHash } from 'node:crypto';
import { CreateContactBody, CreateFormDocumentBody, CreateListingBody, UpdateListingBody } from '@inmolink/contracts';
import { closeDb, withIntake, withSystem, withTenant } from '@inmolink/db';
import { loadStackEnv, setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { configureEmail, createMemoryMailer, type MemoryMailer } from '@inmolink/platform/email';
import { isAppError } from '@inmolink/platform/errors';
import { configureESign } from '@inmolink/platform/esign';
import { fakeESign } from '@inmolink/platform/esign/testing';
import { invalidateFlags, setFlag, setFlagOverride } from '@inmolink/platform/flags';
import { newId } from '@inmolink/platform/ids';
import { configurePdf } from '@inmolink/platform/pdf';
import { fakePdfRenderer } from '@inmolink/platform/pdf/testing';
import { UnrecoverableError } from '@inmolink/platform/queue';
import { configureStorage, createMemoryStore, type MemoryStore } from '@inmolink/platform/storage';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as crm from '../../crm';
import * as properties from '../../properties';
import * as taxonomy from '../../taxonomy';
import * as documents from '../index';

/**
 * Simple electronic signature (R2-05b): a member asks for signatures on a READY form (behind `documents.forms` and
 * `documents.esign`); the worker invites; each signer, on the public page's core, asks for a code (e-mailed, never
 * stored) and signs with it (typed or drawn, consent, the hash shown) as `app_intake`; the worker applies each
 * signature, seals the signed PDF (original + audit trail: signers, times, IPs, the original's hash) and records its
 * own hash, which verifies against the stored bytes. Codes expire, allow 5 guesses and one a minute. Every query is
 * scoped to this file's agencies.
 */

const RUN = newId().slice(-8).toLowerCase();
const KEY = 'test-hmac-key-signing-0123456789abcdef0123';
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('documents.signatures.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);
const MAX = { maxBytes: 10_000_000 };
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

let a: Founder;
let b: Founder;
let ids: { city: string; villa: string };
let listingId: string;
let buyer: string;
let store: MemoryStore;
let mail: MemoryMailer;
let pdfFake: ReturnType<typeof fakePdfRenderer>;
let esignFake: ReturnType<typeof fakeESign>;

const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (isAppError(err)) return err.code;
    throw err;
  }
  return 'accepted';
}

async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (err) {
    const e = err as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code;
  }
  return 'accepted';
}

/** A READY offer of agency a, rendered by the fake renderer. */
async function readyForm(): Promise<{ id: string; sha256: string }> {
  const { form } = await as(a, (ctx) =>
    documents.createFormDocument(
      ctx,
      CreateFormDocumentBody.parse({
        template: 'OFFER',
        listingId,
        contactId: buyer,
        offer: { amountCents: 40_000_000, currency: 'EUR' },
        validUntil: '2030-01-31',
        locale: 'en',
      }),
    ),
  );
  await documents.renderFormDocument(form.id, a.agencyId);
  const [r] = await rows<{ sha256: string }>(sql`select sha256 from form_documents where id = ${form.id}`);
  return { id: form.id, sha256: r?.sha256 as string };
}

const signers = (n = 2) =>
  [
    { name: `Bruno Buyer ${RUN}`, email: `bruno-${RUN}@example.com`, role: 'buyer' },
    { name: `Ana Agent ${RUN}`, email: `ana-${RUN}@example.com`, role: 'agency', locale: 'es' },
  ].slice(0, n);

const ask = (formId: string, body: Record<string, unknown> = {}, key?: string) =>
  as(a, (ctx) =>
    documents.createSignatureRequest(
      ctx,
      formId,
      { signers: signers(), ...body } as never,
      key ? { idempotencyKey: key } : {},
    ),
  );

/** The signing link's token of a signer (as the invitation carries it). */
const tokenOf = (signerId: string) => documents.signingToken(a.agencyId, signerId);

/** The code e-mailed for the signer's latest code request (the worker's job, run here). */
async function codeFor(signerId: string): Promise<string> {
  const [otp] = await rows<{ id: string }>(
    sql`select id from signature_events where signer_id = ${signerId} and kind = 'OTP_SENT' order by created_at desc limit 1`,
  );
  expect(await documents.sendSigningCode({ agencyId: a.agencyId, signerId, otpId: otp?.id as string })).toBe(true);
  const sent = mail.sent.at(-1);
  // the code is in the body only (security review: never in a subject a lock screen shows)
  const code = /\b(\d{6})\b/.exec(sent?.text ?? '')?.[1];
  expect(code).toMatch(/^\d{6}$/);
  // (the subject names the contact, whose random test name may hold digits: the code itself never appears there)
  expect(sent?.subject).not.toMatch(new RegExp(`\\b${code}\\b`));
  return code as string;
}

/** Runs the worker's apply for the signer's SIGNED page action. */
async function applyFor(signerId: string): Promise<string> {
  const [ev] = await rows<{ id: string }>(
    sql`select id from signature_events where signer_id = ${signerId} and kind = 'SIGNED'`,
  );
  return documents.applySignatureEvent({ agencyId: a.agencyId, signerId, eventId: ev?.id as string });
}

const FACTS = { ip: '203.0.113.7', userAgent: 'Mozilla/5.0 (Signing test)' };

async function signWithCode(signerId: string, hash: string) {
  const token = tokenOf(signerId);
  expect(await documents.requestSigningCode(token, FACTS)).toMatchObject({ outcome: 'SENT' });
  const code = await codeFor(signerId);
  return documents.submitSignature(
    token,
    { code, kind: 'TYPED', name: `Signed ${RUN}`, consent: true, documentSha256: hash },
    FACTS,
  );
}

beforeAll(async () => {
  await setupTestDb('worker');
  loadStackEnv('test');
  store = createMemoryStore();
  configureStorage(store);
  pdfFake = fakePdfRenderer();
  configurePdf(pdfFake);
  esignFake = fakeESign();
  configureESign(esignFake);
  mail = createMemoryMailer();
  await configureEmail(mail);
  documents.configureSigning({ tokenKey: KEY, publicBaseUrl: 'https://sites.test' });
  [a, b] = await Promise.all([createFounder(), createFounder()]);
  for (const m of [a, b]) await setAgencyStatus(m.agencyId, 'VERIFIED');
  await system(async (tx) => {
    await setFlag(tx, documents.FORMS_FLAG, { enabled: false });
    await setFlag(tx, documents.ESIGN_FLAG, { enabled: false });
    await setFlagOverride(tx, documents.FORMS_FLAG, a.agencyId, true);
    await setFlagOverride(tx, documents.ESIGN_FLAG, a.agencyId, true);
    await setFlagOverride(tx, documents.FORMS_FLAG, b.agencyId, true);
  });
  invalidateFlags();
  ids = await system(async (tx) => {
    const name = (n: string) => [{ locale: 'en', name: `${n} ${RUN}`, slug: `${n.toLowerCase()}-${RUN}` }];
    const city = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: `sign-${RUN}`,
      translations: name('Signland'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: `sign-g-${RUN}`,
      sort: 0,
      translations: name('H'),
    });
    const villa = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: `sign-v-${RUN}`,
      sort: 0,
      translations: name('Villa'),
    });
    return { city, villa };
  });
  const { id } = await as(a, (ctx) =>
    properties.createListing(
      ctx,
      CreateListingBody.parse({ propertyTypeId: ids.villa, locationId: ids.city, priceCents: 45_000_000 }),
    ),
  );
  await as(a, async (ctx) =>
    properties.updateListing(
      ctx,
      id,
      UpdateListingBody.parse({ status: 'ACTIVE', version: (await properties.getListing(ctx, id)).version }),
    ),
  );
  listingId = id;
  const { contact } = await as(a, (ctx) =>
    crm.createContact(
      ctx,
      CreateContactBody.parse({ firstName: 'Bruno', lastName: `Sign${RUN}`, emails: [`bruno-${RUN}@example.com`] }),
    ),
  );
  buyer = contact.id;
}, 180_000);

afterAll(async () => {
  await system(async (tx) => {
    await tx.execute(sql`delete from form_documents where agency_id in (${a.agencyId}, ${b.agencyId})`);
    for (const f of [documents.FORMS_FLAG, documents.ESIGN_FLAG]) {
      await setFlagOverride(tx, f, a.agencyId, null);
      await setFlagOverride(tx, f, b.agencyId, null);
    }
  });
  configureESign(undefined);
  await closeDb();
});

describe('[R2-05b] signing requests', () => {
  it('[R2-05b] a member asks for signatures on a READY form over its stored SHA-256; refusals; replay', async () => {
    const form = await readyForm();
    const { request, replayed } = await ask(form.id, { message: 'Please sign' }, `k-${RUN}`);
    expect(replayed).toBe(false);
    expect(request).toMatchObject({
      formId: form.id,
      provider: 'fake',
      status: 'OPEN',
      ordered: false,
      documentSha256: form.sha256,
      signedSha256: null,
      message: 'Please sign',
      createdByUserId: a.userId,
    });
    expect(request.signers.map((s) => [s.position, s.role, s.locale])).toEqual([
      [1, 'buyer', 'en'],
      [2, 'agency', 'es'],
    ]);
    const again = await ask(form.id, { message: 'Please sign' }, `k-${RUN}`);
    expect(again).toMatchObject({ replayed: true, request: { id: request.id } });
    expect(await refusal(ask(form.id, { message: 'Other' }, `k-${RUN}`))).toBe('IDEMPOTENCY_KEY_REUSED');
    const events = await rows<{ n: number }>(
      sql`select count(*)::int as n from outbox_events where agency_id = ${a.agencyId}
          and type = 'documents.signature.requested' and payload->>'requestId' = ${request.id}`,
    );
    expect(events[0]?.n).toBe(1);

    // refusals: a role the template has not, the same address twice, a form not rendered, another agency's form
    expect(await refusal(ask(form.id, { signers: [{ ...signers(1)[0], role: 'seller' }] }))).toBe('SIGNERS_INVALID');
    expect(await refusal(ask(form.id, { signers: [signers(1)[0], { ...signers(1)[0], role: 'agency' }] }))).toBe(
      'SIGNERS_INVALID',
    );
    const { form: pending } = await as(a, (ctx) =>
      documents.createFormDocument(
        ctx,
        CreateFormDocumentBody.parse({
          template: 'OFFER',
          listingId,
          contactId: buyer,
          offer: { amountCents: 1_000_000, currency: 'EUR' },
          validUntil: '2030-01-31',
        }),
      ),
    );
    expect(await refusal(ask(pending.id))).toBe('FORM_NOT_READY');
    expect(
      await refusal(as(b, (ctx) => documents.createSignatureRequest(ctx, form.id, { signers: signers() } as never))),
    ).toBe('ESIGN_NOT_ENABLED');
    await system((tx) => setFlagOverride(tx, documents.ESIGN_FLAG, b.agencyId, true));
    invalidateFlags();
    expect(
      await refusal(as(b, (ctx) => documents.createSignatureRequest(ctx, form.id, { signers: signers() } as never))),
    ).toBe('FORM_DOCUMENT_NOT_FOUND');
    await system((tx) => setFlagOverride(tx, documents.ESIGN_FLAG, b.agencyId, null));
    invalidateFlags();

    // members never advance a request (no UPDATE grant): what was asked and signed stays as recorded
    expect(
      await sqlState(
        withTenant({ agencyId: a.agencyId, userId: a.userId }, (tx) =>
          tx.execute(sql`update signature_requests set status = 'COMPLETED' where id = ${request.id}`),
        ),
      ),
    ).toBe('42501');
    // nor plant a signer already signed (`signature_signers_guard`); the page cannot backdate an event either
    const member = (q: ReturnType<typeof sql>) =>
      sqlState(withTenant({ agencyId: a.agencyId, userId: a.userId }, (tx) => tx.execute(q)));
    expect(
      await member(
        sql`insert into signature_signers (id, agency_id, request_id, position, role, name, email, locale, signed_at)
            values (${newId()}, ${a.agencyId}, ${request.id}, 9, 'buyer', 'Fake', 'fake@example.com', 'en', now())`,
      ),
    ).toBe('23514');
    const signerId = request.signers[0]?.id as string;
    const backdated = newId();
    await withIntake({ agencyId: a.agencyId }, (tx) =>
      tx.execute(
        sql`insert into signature_events (id, agency_id, signer_id, kind, otp_expires_at, created_at)
            values (${backdated}, ${a.agencyId}, ${signerId}, 'OTP_SENT', now() + interval '1 day', now() - interval '2 days')`,
      ),
    );
    const [ev] = await rows<{ fresh: boolean; capped: boolean }>(
      sql`select created_at > now() - interval '1 minute' as fresh,
                 otp_expires_at <= now() + interval '10 minutes' as capped
            from signature_events where id = ${backdated}`,
    );
    expect(ev).toEqual({ fresh: true, capped: true });
    await system((tx) => tx.execute(sql`delete from signature_events where id = ${backdated}`));
  });

  it('[R2-05b] a collaboration agreement needs a signer for each deal party', async () => {
    const form = await readyForm();
    const dealId = newId();
    // the deal's form as R2-05a stores it (made from the deal room): a READY collaboration agreement
    await system((tx) =>
      tx.execute(
        sql`update form_documents set template = 'COLLABORATION_AGREEMENT', deal_id = ${dealId},
              data = jsonb_set(data, '{party}', '"INTRODUCER"') where id = ${form.id}`,
      ),
    );
    const owner = `owner-${RUN}@example.com`;
    const intro = `intro-${RUN}@example.com`;
    const deal = { dealId, allowed: { ownerAgency: [owner], introducerAgency: [intro] } };
    const askDeal = (signers: unknown[], d: documents.DealSigners | null = deal) =>
      as(a, (ctx) => documents.createSignatureRequest(ctx, form.id, { signers } as never, d ? { deal: d } : {}));
    const one = [{ name: 'Owner Rep', email: owner, role: 'ownerAgency' }];
    expect(await refusal(askDeal(one))).toBe('SIGNERS_INVALID');
    const both = [...one, { name: 'Intro Rep', email: intro.toUpperCase(), role: 'introducerAgency' }];
    // R2-05c: only from its deal (mls.createDealSignatureRequest), never the forms endpoint or another deal
    expect(await refusal(askDeal(both, null))).toBe('SIGNERS_INVALID');
    expect(await refusal(askDeal(both, { ...deal, dealId: newId() }))).toBe('SIGNERS_INVALID');
    // R2-05c: the other agency's signer must be one of its deal members or admins
    const stranger = [...one, { name: 'Stranger', email: `stranger-${RUN}@example.com`, role: 'introducerAgency' }];
    expect(await refusal(askDeal(stranger))).toBe('SIGNERS_INVALID');
    const { request } = await askDeal(both);
    expect(request.signers.map((s) => s.role)).toEqual(['ownerAgency', 'introducerAgency']);
    // R2-05c: the requester (the introducer here) never reads the other agency's address back
    expect(request.signers.map((s) => s.email)).toEqual([documents.maskEmail(owner), intro.toUpperCase()]);
    // R2-05c: each re-send supersedes the last and mails the other agency again: 5 a day per deal
    let last = request.id;
    for (let i = 1; i < documents.DEAL_SIGNATURE_REQUESTS_PER_DAY; i++) last = (await askDeal(both)).request.id;
    expect(await refusal(askDeal(both))).toBe('RATE_LIMITED');
    // R2-05c: the sealed PDF's audit page shows the other agency's address masked, with its SHA-256
    const signed = await as(a, (ctx) => documents.getSignatureRequest(ctx, last));
    await documents.inviteSigners({ agencyId: a.agencyId, requestId: last });
    for (const signer of signed.signers) {
      expect(await documents.requestSigningCode(tokenOf(signer.id), FACTS)).toMatchObject({ outcome: 'SENT' });
      const typed = { kind: 'TYPED' as const, name: signer.name, consent: true, documentSha256: form.sha256 };
      const outcome = await documents.submitSignature(
        tokenOf(signer.id),
        { ...typed, code: await codeFor(signer.id) },
        FACTS,
      );
      expect(outcome).toEqual({ outcome: 'SIGNED' });
      expect(await applyFor(signer.id)).toBe('applied');
    }
    expect((await documents.sealSignatureRequest({ agencyId: a.agencyId, requestId: last })).sealed).toBe(true);
    const audit = pdfFake.documents.at(-1) as string;
    expect(audit).not.toContain(owner);
    expect(audit).toContain(documents.maskEmail(owner));
    expect(audit).toContain(createHash('sha256').update(owner).digest('hex'));
    expect(audit).toContain(intro.toUpperCase());
  });
});

describe('[R2-05b] signing', () => {
  it('[R2-05b] signed PDF includes the audit trail (signers, timestamps, IP, document hash) and verifies against the stored hash', async () => {
    const form = await readyForm();
    const { request } = await ask(form.id);
    const [s1, s2] = request.signers;
    if (!s1 || !s2) throw new Error('two signers');
    mail.sent.length = 0;
    expect(await documents.inviteSigners({ agencyId: a.agencyId, requestId: request.id })).toEqual({ invited: 2 });
    expect(mail.sent.map((m) => m.to).sort()).toEqual([s2.email, s1.email].sort());
    const invite = mail.sent.find((m) => m.to === s1.email);
    expect(invite?.text).toContain(`https://sites.test/sign/${tokenOf(s1.id)}?l=en`);
    // invited once
    expect(await documents.inviteSigners({ agencyId: a.agencyId, requestId: request.id })).toEqual({ invited: 0 });

    const page = await documents.signingPage(tokenOf(s1.id));
    expect(page).toMatchObject({
      state: 'OPEN',
      name: s1.name,
      role: 'buyer',
      documentSha256: form.sha256,
      emailHint: `b•••@example.com`,
    });
    expect(page?.agencyName).toBeTruthy();
    expect(await documents.signingPage(tokenOf(s1.id).replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')))).toBeNull();

    // signer 1: a code, a wrong guess, then the right code
    expect(await documents.requestSigningCode(tokenOf(s1.id), FACTS)).toMatchObject({ outcome: 'SENT' });
    const code = await codeFor(s1.id);
    const wrong = code === '000000' ? '111111' : '000000';
    const sign = (c: string, extra: Partial<documents.SignatureInput> = {}) =>
      documents.submitSignature(
        tokenOf(s1.id),
        { code: c, kind: 'TYPED', name: `Bruno B. ${RUN}`, consent: true, documentSha256: form.sha256, ...extra },
        FACTS,
      );
    expect(await sign(wrong)).toEqual({ outcome: 'BAD_CODE', attemptsLeft: 4 });
    expect(await sign(code, { consent: false })).toEqual({ outcome: 'CONSENT_MISSING' });
    expect(await sign(code, { documentSha256: 'f'.repeat(64) })).toEqual({ outcome: 'CHANGED' });
    expect(await sign(`${code.slice(0, 3)} ${code.slice(3)}`)).toEqual({ outcome: 'SIGNED' });
    expect(await sign(code)).toEqual({ outcome: 'STATE', state: 'SIGNED' });
    expect(await applyFor(s1.id)).toBe('applied');
    expect(await applyFor(s1.id)).toBe('already');

    // signer 2 draws
    const png =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    expect(
      await documents.requestSigningCode(tokenOf(s2.id), { ip: '198.51.100.20', userAgent: 'UA two' }),
    ).toMatchObject({
      outcome: 'SENT',
    });
    const code2 = await codeFor(s2.id);
    expect(
      await documents.submitSignature(
        tokenOf(s2.id),
        { code: code2, kind: 'DRAWN', name: `Ana ${RUN}`, drawing: png, consent: true, documentSha256: form.sha256 },
        { ip: '198.51.100.20', userAgent: 'UA two' },
      ),
    ).toEqual({ outcome: 'SIGNED' });
    expect(await applyFor(s2.id)).toBe('applied');
    const [all] = await rows<{ status: string; all_signed_at: string | null }>(
      sql`select status, all_signed_at from signature_requests where id = ${request.id}`,
    );
    expect(all).toMatchObject({ status: 'SIGNED' });
    expect(all?.all_signed_at).not.toBeNull();

    // the seal: original + audit trail, stored once, its hash recorded
    const sealed = await documents.sealSignatureRequest({ agencyId: a.agencyId, requestId: request.id });
    expect(sealed.sealed).toBe(true);
    const audit = pdfFake.documents.at(-1) as string;
    for (const text of [
      s1.email,
      s2.email,
      `Bruno B. ${RUN}`,
      `Ana ${RUN}`,
      '203.0.113.7',
      '198.51.100.20',
      form.sha256,
    ]) {
      expect(audit).toContain(text);
    }
    expect(audit).toContain('data:image/png;base64,');
    expect(audit).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/);
    const seal = esignFake.seals.at(-1);
    const original = await store.get('private', documents.formDocumentKey(a.agencyId, form.id), MAX);
    expect(sha(seal?.original as Uint8Array)).toBe(form.sha256);
    expect(sha(original as Uint8Array)).toBe(form.sha256);
    const signed = await store.get('private', documents.signedFormKey(a.agencyId, form.id, request.id), MAX);
    const dto = await as(a, (ctx) => documents.getSignatureRequest(ctx, request.id));
    expect(dto).toMatchObject({ status: 'COMPLETED', signedSha256: sha(signed as Uint8Array) });
    expect(dto.url).toBeTruthy();
    expect(dto.signers.map((s) => [s.signatureKind, s.signedIp])).toEqual([
      ['TYPED', '203.0.113.7'],
      ['DRAWN', '198.51.100.20'],
    ]);
    // verification against the stored hashes
    const verify = (bytes: Uint8Array) => as(a, (ctx) => documents.verifySignedPdf(ctx, request.id, bytes));
    expect(await verify(signed as Uint8Array)).toMatchObject({ match: 'SIGNED', sha256: dto.signedSha256 });
    expect(await verify(original as Uint8Array)).toMatchObject({ match: 'ORIGINAL' });
    const tampered = Uint8Array.from(signed as Uint8Array);
    tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 1;
    expect(await verify(tampered)).toMatchObject({ match: 'NONE' });
    // sealed once; the completion mails carry the hash and the signer's link to the signed PDF
    expect(await documents.sealSignatureRequest({ agencyId: a.agencyId, requestId: request.id })).toEqual({
      sealed: false,
    });
    mail.sent.length = 0;
    expect(await documents.notifySignatureCompleted({ agencyId: a.agencyId, requestId: request.id })).toBe(3);
    const done = mail.sent.find((m) => m.to === s1.email);
    expect(done?.text).toContain(dto.signedSha256 as string);
    expect(done?.text).toContain(`/sign/${tokenOf(s1.id)}/signed`);
    expect(await documents.signingPage(tokenOf(s1.id))).toMatchObject({
      state: 'COMPLETED',
      signedSha256: dto.signedSha256,
    });
    expect(await documents.signingFileUrl(tokenOf(s1.id), 'signed')).toMatchObject({ url: expect.any(String) });
    expect(await refusal(ask(form.id))).toBe('FORM_ALREADY_SIGNED');

    // the SUBJECT export of the form's contact: the client's signature (name, address, when, how, IP), never the
    // agency's own signer
    const exported = await system((tx) =>
      documents.subjectSignatures(tx, a.agencyId, buyer, documents.AGENCY_SIGNER_ROLES, null, 100),
    );
    const mine = exported.filter((x) => x.requestId === request.id);
    expect(mine).toEqual([
      expect.objectContaining({ id: s1.id, role: 'buyer', email: s1.email, signatureKind: 'TYPED', ip: '203.0.113.7' }),
    ]);
  });

  it('[R2-05b] codes: one a minute, 5 guesses each, they expire; the page appends as app_intake and reads no signature', async () => {
    const form = await readyForm();
    const { request } = await ask(form.id, { signers: signers(1) });
    const s = request.signers[0];
    if (!s) throw new Error('signer');
    const token = tokenOf(s.id);
    expect(await documents.requestSigningCode(token, FACTS)).toMatchObject({ outcome: 'SENT' });
    expect(await documents.requestSigningCode(token, FACTS)).toEqual({ outcome: 'WAIT' });
    const code = await codeFor(s.id);
    const wrong = code === '000000' ? '111111' : '000000';
    const attempt = (c: string) =>
      documents.submitSignature(
        token,
        { code: c, kind: 'TYPED', name: 'X', consent: true, documentSha256: form.sha256 },
        FACTS,
      );
    for (let left = 4; left >= 0; left--)
      expect(await attempt(wrong)).toEqual({ outcome: 'BAD_CODE', attemptsLeft: left });
    // the code is dead after 5 wrong guesses, even the right one
    expect(await attempt(code)).toEqual({ outcome: 'CODE_EXPIRED' });
    // a new code (the minute passed), then it expires
    await system((tx) =>
      tx.execute(
        sql`update signature_events set created_at = created_at - interval '2 minutes' where signer_id = ${s.id}`,
      ),
    );
    expect(await documents.requestSigningCode(token, FACTS)).toMatchObject({ outcome: 'SENT' });
    const fresh = await codeFor(s.id);
    await system((tx) =>
      tx.execute(
        sql`update signature_events set otp_expires_at = now() - interval '1 second'
            where signer_id = ${s.id} and kind = 'OTP_SENT'`,
      ),
    );
    expect(await attempt(fresh)).toEqual({ outcome: 'CODE_EXPIRED' });
    // the code of an expired row is not mailed either
    const [otp] = await rows<{ id: string }>(
      sql`select id from signature_events where signer_id = ${s.id} and kind = 'OTP_SENT' order by created_at desc limit 1`,
    );
    expect(await documents.sendSigningCode({ agencyId: a.agencyId, signerId: s.id, otpId: otp?.id as string })).toBe(
      false,
    );
    // nothing about a code is stored: the rows hold ids and times only
    const stored = await rows<Record<string, unknown>>(
      sql`select * from signature_events where signer_id = ${s.id} and kind = 'OTP_SENT'`,
    );
    expect(JSON.stringify(stored)).not.toContain(fresh);
    // app_intake reads back ids, kinds and times only — never a signature, IP or user agent
    expect(
      await sqlState(
        withIntake({ agencyId: a.agencyId }, (tx) =>
          tx.execute(sql`select ip from signature_events where signer_id = ${s.id}`),
        ),
      ),
    ).toBe('42501');
    expect(
      await sqlState(
        withIntake({ agencyId: a.agencyId }, (tx) =>
          tx.execute(sql`update signature_events set kind = 'SIGNED' where signer_id = ${s.id}`),
        ),
      ),
    ).toBe('42501');
  });

  it('[R2-05b] an ordered request invites the next signer only after the previous one signed', async () => {
    const form = await readyForm();
    const { request } = await ask(form.id, { ordered: true });
    const [s1, s2] = request.signers;
    if (!s1 || !s2) throw new Error('two signers');
    mail.sent.length = 0;
    expect(await documents.inviteSigners({ agencyId: a.agencyId, requestId: request.id })).toEqual({ invited: 1 });
    expect(mail.sent.map((m) => m.to)).toEqual([s1.email]);
    expect(await documents.signingPage(tokenOf(s2.id))).toMatchObject({ state: 'WAITING' });
    expect(await documents.requestSigningCode(tokenOf(s2.id), FACTS)).toEqual({ outcome: 'STATE', state: 'WAITING' });
    expect(await signWithCode(s1.id, form.sha256)).toEqual({ outcome: 'SIGNED' });
    expect(await applyFor(s1.id)).toBe('applied');
    const next = await rows<{ n: number }>(
      sql`select count(*)::int as n from outbox_events where agency_id = ${a.agencyId}
          and type = 'documents.signature.requested' and payload->>'requestId' = ${request.id}`,
    );
    expect(next[0]?.n).toBe(2);
    expect(await documents.inviteSigners({ agencyId: a.agencyId, requestId: request.id })).toEqual({ invited: 1 });
    expect(await documents.signingPage(tokenOf(s2.id))).toMatchObject({ state: 'OPEN' });
  });

  it('[R2-05b] a new request supersedes the open one; a closed link signs nothing; a changed original fails the seal', async () => {
    const form = await readyForm();
    const { request: first } = await ask(form.id, { signers: signers(1) });
    const { request: second } = await ask(form.id, { signers: signers(1) });
    await documents.inviteSigners({ agencyId: a.agencyId, requestId: second.id });
    const [old] = await rows<{ status: string }>(sql`select status from signature_requests where id = ${first.id}`);
    expect(old?.status).toBe('CANCELLED');
    const oldSigner = first.signers[0]?.id as string;
    expect(await documents.signingPage(tokenOf(oldSigner))).toMatchObject({ state: 'CLOSED' });
    expect(await documents.requestSigningCode(tokenOf(oldSigner), FACTS)).toEqual({
      outcome: 'STATE',
      state: 'CLOSED',
    });
    expect(await documents.signingFileUrl(tokenOf(oldSigner), 'original')).toBeNull();

    // the original changed after signing (it never should): the seal refuses for good
    const s = second.signers[0]?.id as string;
    expect(await signWithCode(s, form.sha256)).toEqual({ outcome: 'SIGNED' });
    expect(await applyFor(s)).toBe('applied');
    await store.put('private', documents.formDocumentKey(a.agencyId, form.id), new TextEncoder().encode('%PDF-x'), {
      contentType: 'application/pdf',
    });
    await expect(documents.sealSignatureRequest({ agencyId: a.agencyId, requestId: second.id })).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
  });

  it('[R2-05b] a signature on a request superseded before it was applied never completes it (one signed PDF per form)', async () => {
    const form = await readyForm();
    const { request: first } = await ask(form.id, { signers: signers(1) });
    const old = first.signers[0]?.id as string;
    expect(await signWithCode(old, form.sha256)).toEqual({ outcome: 'SIGNED' });
    // a new request before the worker applied the signature: the old link is closed, not "signed"
    const { request: second } = await ask(form.id, { signers: signers(1) });
    expect(await documents.signingPage(tokenOf(old))).toMatchObject({ state: 'CLOSED' });
    expect(await applyFor(old)).toBe('closed');
    const [r1] = await rows<{ status: string }>(sql`select status from signature_requests where id = ${first.id}`);
    expect(r1?.status).toBe('OPEN');
    // the new request signs and completes; the old one is cancelled by the new one's invitation
    await documents.inviteSigners({ agencyId: a.agencyId, requestId: second.id });
    const s = second.signers[0]?.id as string;
    expect(await signWithCode(s, form.sha256)).toEqual({ outcome: 'SIGNED' });
    expect(await applyFor(s)).toBe('applied');
    const states = await rows<{ id: string; status: string }>(
      sql`select id, status from signature_requests where form_id = ${form.id} order by created_at`,
    );
    expect(states.map((x) => x.status)).toEqual(['CANCELLED', 'SIGNED']);
  });

  it('[R2-05b] contact erasure deletes the signed form: requests, signers, signatures and the signed PDF', async () => {
    const form = await readyForm();
    const { request } = await ask(form.id, { signers: signers(1) });
    const s = request.signers[0]?.id as string;
    expect(await signWithCode(s, form.sha256)).toEqual({ outcome: 'SIGNED' });
    expect(await applyFor(s)).toBe('applied');
    expect((await documents.sealSignatureRequest({ agencyId: a.agencyId, requestId: request.id })).sealed).toBe(true);
    const key = documents.signedFormKey(a.agencyId, form.id, request.id);
    expect(await store.get('private', key, MAX)).not.toBeNull();
    await documents.eraseContactForms({ agencyId: a.agencyId, contactIds: [buyer] });
    expect(await store.get('private', key, MAX)).toBeNull();
    const left = await rows<{ n: number }>(
      sql`select (select count(*) from signature_requests where id = ${request.id})
               + (select count(*) from signature_signers where request_id = ${request.id})
               + (select count(*) from signature_events where signer_id = ${s})::int as n`,
    );
    expect(Number(left[0]?.n)).toBe(0);
  });
});
