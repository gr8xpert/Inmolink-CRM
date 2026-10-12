import { DecideVerificationBody, UpdateAgencyDetailsBody, VERIFICATION_DOCUMENT_MAX_BYTES } from '@inmolink/contracts';
import { closeDb, getPgClient } from '@inmolink/db';
import { createStaffUser, loadStackEnv, setupTestDb } from '@inmolink/db/testing';
import { loadConfig, storageEnv } from '@inmolink/platform/config';
import { closeEmail, configureEmail, createMemoryMailer, type MemoryMailer } from '@inmolink/platform/email';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { configureStorage, createS3Store, storageConfigFromEnv } from '@inmolink/platform/storage';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx, CtxRunner } from '../../../context';
import { withMemberCtx } from '../../../member';
import { withStaffCtx } from '../../../staff';
import { createFounder, type Founder } from '../../../testing/factories';
import * as identity from '../../identity';
import * as agencies from '../index';

/** Agency verification end to end on the test database and MinIO (S1-03). */

const PDF = new TextEncoder().encode('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n');
const log = createLogger({ service: 'test', level: 'silent' });
let admin: Awaited<ReturnType<typeof getPgClient>>;
let mail: MemoryMailer;
let support: { userId: string };

beforeAll(async () => {
  await setupTestDb('worker');
  loadStackEnv('test');
  configureStorage(createS3Store(storageConfigFromEnv(loadConfig(storageEnv))));
  admin = await getPgClient('app_system');
  mail = createMemoryMailer();
  await configureEmail(mail);
  identity.configureIdentity({ hmacKey: 'test-hmac-key-0123456789abcdef0123456789', webUrl: 'http://web.test' });
  support = await createStaffUser('STAFF_SUPPORT');
}, 120_000);

afterAll(async () => {
  admin?.release();
  await closeEmail();
  await closeDb();
});

const member = (f: Founder) => ({ userId: f.userId, agencyId: f.agencyId, requestId: newId() });
const as = <T>(f: Founder, fn: (ctx: Ctx) => Promise<T>) => withMemberCtx(member(f), fn);
const runner =
  (f: Founder): CtxRunner =>
  (fn) =>
    as(f, fn);
const asStaff = <T>(userId: string, fn: Parameters<typeof withStaffCtx<T>>[1]) =>
  withStaffCtx({ userId, requestId: newId(), reason: 'test' }, fn);

const details = (version: number, over: Record<string, unknown> = {}) =>
  UpdateAgencyDetailsBody.parse({
    version,
    name: 'Costa Homes S.L.',
    taxId: 'B12345674',
    addressLine: 'Calle Mayor 1',
    city: 'Marbella',
    postalCode: '29601',
    region: 'ES-AN',
    languages: ['es', 'en'],
    ...over,
  });

/** A founder whose agency finished onboarding. */
async function onboarded(): Promise<Founder> {
  const f = await createFounder({ companyName: `Costa ${newId().slice(-6)} S.L.` });
  const { version } = await as(f, (c) => agencies.getMyAgency(c));
  await as(f, (c) => agencies.updateAgencyDetails(c, details(version, { name: `Costa ${f.agencyId.slice(-6)} S.L.` })));
  return f;
}

const upload = (f: Founder, body = PDF, fileName = 'cif') =>
  agencies.uploadVerificationDocument(runner(f), { kind: 'TAX_ID', fileName, body });

/** Onboarded, one document, submitted. Returns the request id and the version submitted. */
async function submitted(): Promise<{ f: Founder; requestId: string; version: number }> {
  const f = await onboarded();
  await upload(f);
  const { agencyVersion } = await as(f, (c) => agencies.getAgencyVerification(c));
  const after = await as(f, (c) => agencies.submitVerification(c, { version: agencyVersion }));
  if (!after.latestRequest) throw new Error('no request');
  return { f, requestId: after.latestRequest.id, version: agencyVersion };
}

const decide = (requestId: string, body: Partial<DecideVerificationBody> & { agencyVersion: number }) =>
  asStaff(support.userId, (c) =>
    agencies.decideVerification(c, {
      id: requestId,
      ...DecideVerificationBody.parse({ decision: 'APPROVE', reason: 'CIF checked against AEAT', ...body }),
    }),
  );

describe('agency verification', () => {
  it('[S1-03] approve → VERIFIED unlocks SHARED/PUBLIC/API keys immediately', async () => {
    const { f, requestId, version } = await submitted();
    for (const action of ['listing.share', 'listing.publish', 'apiKey.create'] as const) {
      await expect(as(f, async (c) => agencies.assertVerified(c, action))).rejects.toMatchObject({
        code: 'VERIFICATION_REQUIRED',
      });
    }

    const decided = await decide(requestId, { agencyVersion: version });
    expect(decided).toMatchObject({ status: 'APPROVED', agency: { status: 'VERIFIED' } });

    // The very next request sees it: the tenant status is read per request, nothing to wait for.
    await as(f, async (c) => {
      expect(c.tenant.verified).toBe(true);
      for (const action of ['listing.share', 'listing.publish', 'apiKey.create'] as const) {
        expect(() => agencies.assertVerified(c, action)).not.toThrow();
      }
    });
    const events = await admin.query<{ type: string; payload: Record<string, unknown> }>(
      `select type, payload from outbox_events where agency_id = $1 and type like 'agencies.%' order by created_at, id`,
      [f.agencyId],
    );
    expect(events.rows.map((e) => e.type)).toEqual(
      expect.arrayContaining([
        'agencies.verification.submitted',
        'agencies.status.changed',
        'agencies.verification.decided',
      ]),
    );
    expect(events.rows.find((e) => e.type === 'agencies.status.changed')?.payload).toMatchObject({
      from: 'PENDING',
      to: 'VERIFIED',
      version: version + 1,
    });
  });

  it('[S1-03] approval records the details version staff reviewed and is refused if the agency changed since', async () => {
    const { f, requestId, version } = await submitted();
    const reviewed = await asStaff(support.userId, (c) => agencies.getVerificationRequest(c, { id: requestId }));
    expect(reviewed).toMatchObject({ detailsVersion: version, agency: { version } });

    // The agency edits its details while staff review (still PENDING, so allowed).
    await as(f, (c) =>
      agencies.updateAgencyDetails(c, details(version, { name: `Other ${f.agencyId.slice(-6)} S.L.` })),
    );
    await expect(decide(requestId, { agencyVersion: version })).rejects.toMatchObject({
      code: 'VERIFICATION_STALE',
      details: { reviewedVersion: version, currentVersion: version + 1 },
    });
    await expect(as(f, (c) => agencies.getMyAgency(c))).resolves.toMatchObject({ status: 'PENDING' });

    const again = await asStaff(support.userId, (c) => agencies.getVerificationRequest(c, { id: requestId }));
    expect(again).toMatchObject({ detailsVersion: version, agency: { version: version + 1 } });
    const decided = await decide(requestId, { agencyVersion: version + 1 });
    expect(decided).toMatchObject({ status: 'APPROVED', reviewedVersion: version + 1 });
  });

  it('[S1-03] every decision is recorded with reviewer and reason, and cannot be changed afterwards', async () => {
    const { f, requestId, version } = await submitted();
    const rejected = await decide(requestId, {
      decision: 'REJECT',
      agencyVersion: version,
      reason: 'The CIF certificate is unreadable; please upload a clearer scan.',
    });
    expect(rejected).toMatchObject({
      status: 'REJECTED',
      reviewerUserId: support.userId,
      reviewedVersion: version,
      decisionReason: 'The CIF certificate is unreadable; please upload a clearer scan.',
      agency: { status: 'PENDING' },
    });
    expect(rejected.decidedAt).not.toBeNull();

    // Staff cannot decide twice; the decided row cannot be rewritten by staff or the tenant.
    await expect(decide(requestId, { agencyVersion: version })).rejects.toMatchObject({
      code: 'VERIFICATION_NOT_OPEN',
    });
    await expect(
      as(f, (c) =>
        c.tx.execute(`update agency_verification_requests set status = 'APPROVED' where id = '${requestId}'`),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(
      asStaff(support.userId, (c) =>
        c.tx.execute(`update agency_verification_requests set decision_reason = 'edited' where id = '${requestId}'`),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    // Nor deleted.
    await expect(
      as(f, (c) => c.tx.execute(`delete from agency_verification_requests where id = '${requestId}'`)),
    ).rejects.toMatchObject({ cause: { code: '42501' } });

    // The agency sees the reason and may submit again with new documents.
    const view = await as(f, (c) => agencies.getAgencyVerification(c));
    expect(view.latestRequest).toMatchObject({
      status: 'REJECTED',
      decisionReason: expect.stringContaining('unreadable'),
    });
    await upload(f, PDF, 'cif-clear.pdf');
    const resubmitted = await as(f, (c) => agencies.submitVerification(c, { version: view.agencyVersion }));
    expect(resubmitted.latestRequest).toMatchObject({ status: 'SUBMITTED' });
    expect(resubmitted.documents.map((d) => d.fileName)).toEqual(['cif-clear.pdf']);
  });

  it('[S1-08] a staff decision is audited under the agency, naming the staff member; a refused one leaves no row', async () => {
    const { f, requestId, version } = await submitted();
    await as(f, (c) => agencies.updateAgencyDetails(c, details(version, { city: 'Estepona' })));
    await expect(decide(requestId, { agencyVersion: version })).rejects.toMatchObject({ code: 'VERIFICATION_STALE' });
    const current = await as(f, (c) => agencies.getMyAgency(c));
    await decide(requestId, { decision: 'REJECT', agencyVersion: current.version, reason: 'Please resubmit the CIF.' });

    // Staff read every agency's audit rows (the S1-09 viewer); the agency's admins read their own.
    const rows = await asStaff(support.userId, (c) =>
      c.tx.execute(
        sql`select agency_id, type, actor_kind, actor_user_id, target_type, metadata from audit_logs where target_id = ${requestId}`,
      ),
    );
    expect(rows.rows).toEqual([
      {
        agency_id: f.agencyId,
        type: 'agencies.verification.decided',
        actor_kind: 'staff',
        actor_user_id: support.userId,
        target_type: 'verificationRequest',
        metadata: { decision: 'REJECTED', reviewedVersion: current.version },
      },
    ]);
    // Staff cannot append a row in someone else's name.
    await expect(
      asStaff(support.userId, (c) =>
        c.tx.execute(
          sql`insert into audit_logs (id, agency_id, type, actor_kind, actor_user_id)
              values (${newId()}, ${f.agencyId}, 'agencies.verification.decided', 'staff', ${f.userId})`,
        ),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('[S1-03] the database refuses VERIFIED without an approved decision recorded in the same transaction', async () => {
    const { f, requestId, version } = await submitted();
    // Staff SQL that skips the decision (a bug, or a future use case) cannot verify the agency.
    await expect(
      asStaff(support.userId, (c) =>
        c.tx.execute(`update agencies set status = 'VERIFIED' where agency_id = '${f.agencyId}'`),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    // Nor can staff touch other columns, or delete the agency.
    await expect(
      asStaff(support.userId, (c) =>
        c.tx.execute(`update agencies set name = 'X S.L.' where agency_id = '${f.agencyId}'`),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(
      asStaff(support.userId, (c) => c.tx.execute(`delete from agencies where agency_id = '${f.agencyId}'`)),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(as(f, (c) => agencies.getMyAgency(c))).resolves.toMatchObject({ status: 'PENDING' });
    // Through the use case it works.
    await expect(decide(requestId, { agencyVersion: version })).resolves.toMatchObject({ status: 'APPROVED' });
  });

  it('[S1-03] a decision needs a reason (contract) and staff with a verification role', async () => {
    expect(() => DecideVerificationBody.parse({ decision: 'REJECT', agencyVersion: 1, reason: '  ' })).toThrow();
    const { requestId, version } = await submitted();
    const dataOps = await createStaffUser('STAFF_DATA_OPS');
    await expect(
      asStaff(dataOps.userId, (c) =>
        agencies.decideVerification(c, { id: requestId, decision: 'APPROVE', agencyVersion: version, reason: 'ok ok' }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // A user who is not staff cannot even open a staff context.
    const founder = await createFounder();
    await expect(
      asStaff(founder.userId, (c) => agencies.getVerificationRequest(c, { id: requestId })),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', details: { reason: 'not_staff' } });
  });

  it('[S1-03] verification documents are never readable by other tenants; staff read them through short signed URLs', async () => {
    const { f, requestId } = await submitted();
    const other = await onboarded();
    const [doc] = (await as(f, (c) => agencies.getAgencyVerification(c))).documents;
    if (!doc) throw new Error('no document');

    // Tenant B sees none of A's documents and cannot touch them.
    expect((await as(other, (c) => agencies.getAgencyVerification(c))).documents).toEqual([]);
    await expect(agencies.deleteVerificationDocument(runner(other), { id: doc.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    // An agent of A cannot read them either (admins only).
    await admin.query(`update agency_members set role = 'AGENT' where user_id = $1`, [f.userId]);
    await expect(as(f, (c) => agencies.getAgencyVerification(c))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await admin.query(`update agency_members set role = 'AGENCY_ADMIN' where user_id = $1`, [f.userId]);

    // Staff get a 5-minute link that downloads the exact bytes.
    const link = await asStaff(support.userId, (c) =>
      agencies.getVerificationDocumentUrl(c, { id: requestId, documentId: doc.id }),
    );
    expect(new URL(link.url).searchParams.get('X-Amz-Expires')).toBe(String(agencies.DOCUMENT_URL_TTL_SECONDS));
    const res = await fetch(link.url);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PDF);
    // The same object without the signature is refused.
    const bare = new URL(link.url);
    bare.search = '';
    expect((await fetch(bare)).status).toBe(403);
    // A document id from another request does not resolve.
    await expect(
      asStaff(support.userId, (c) => agencies.getVerificationDocumentUrl(c, { id: newId(), documentId: doc.id })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('[S1-03] uploads are checked by magic bytes and size; submitted documents are kept', async () => {
    const f = await onboarded();
    await expect(upload(f, new TextEncoder().encode('<html><script>alert(1)</script>'))).rejects.toMatchObject({
      code: 'DOCUMENT_TYPE_NOT_ALLOWED',
    });
    const big = new Uint8Array(VERIFICATION_DOCUMENT_MAX_BYTES + 1);
    big.set(PDF);
    await expect(upload(f, big)).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });

    const doc = await upload(f, PDF, 'escritura.exe');
    expect(doc).toMatchObject({ contentType: 'application/pdf', fileName: 'escritura.exe.pdf', submitted: false });
    const removable = await upload(f);
    await agencies.deleteVerificationDocument(runner(f), { id: removable.id });

    const { agencyVersion } = await as(f, (c) => agencies.getAgencyVerification(c));
    await as(f, (c) => agencies.submitVerification(c, { version: agencyVersion }));
    await expect(agencies.deleteVerificationDocument(runner(f), { id: doc.id })).rejects.toMatchObject({
      code: 'DOCUMENT_LOCKED',
    });
    await expect(upload(f)).rejects.toMatchObject({ code: 'VERIFICATION_ALREADY_SUBMITTED' });
    await expect(as(f, (c) => agencies.submitVerification(c, { version: agencyVersion }))).rejects.toMatchObject({
      code: 'VERIFICATION_ALREADY_SUBMITTED',
    });
  });

  it('[S1-03] submitting needs onboarding, the current details version and at least one document', async () => {
    const fresh = await createFounder();
    const v0 = (await as(fresh, (c) => agencies.getMyAgency(c))).version;
    await expect(as(fresh, (c) => agencies.submitVerification(c, { version: v0 }))).rejects.toMatchObject({
      code: 'AGENCY_NOT_ONBOARDED',
    });
    const f = await onboarded();
    const { agencyVersion } = await as(f, (c) => agencies.getAgencyVerification(c));
    await expect(as(f, (c) => agencies.submitVerification(c, { version: agencyVersion }))).rejects.toMatchObject({
      code: 'VERIFICATION_DOCUMENTS_REQUIRED',
    });
    await upload(f);
    await expect(as(f, (c) => agencies.submitVerification(c, { version: agencyVersion - 1 }))).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });
  });

  it('[S1-03] the staff queue lists open requests oldest first with keyset pages', async () => {
    const first = await submitted();
    const second = await submitted();
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await asStaff(support.userId, (c) =>
        agencies.listVerificationQueue(c, { status: 'SUBMITTED', limit: 2, cursor }),
      );
      expect(page.items.length).toBeLessThanOrEqual(2);
      expect(page.items.every((i) => i.status === 'SUBMITTED')).toBe(true);
      ids.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(ids.indexOf(first.requestId)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(second.requestId)).toBeGreaterThan(ids.indexOf(first.requestId));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('[S1-03] the agency admins are emailed the decision and staff reason', async () => {
    const { f, requestId, version } = await submitted();
    await decide(requestId, { decision: 'REJECT', agencyVersion: version, reason: 'Please add the IAE registration.' });
    const event = (
      await admin.query<{ id: string }>(
        `select id from outbox_events where agency_id = $1 and type = 'agencies.verification.decided'`,
        [f.agencyId],
      )
    ).rows[0];
    if (!event) throw new Error('no decision event');
    const before = mail.sent.length;
    await identity.identityJobs.sendVerificationDecisionEmail.spec.run(
      { eventId: event.id, agencyId: f.agencyId, requestId },
      { log, jobId: event.id, attempt: 1, progress: async () => {}, signal: new AbortController().signal },
    );
    const sent = mail.sent.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: f.email, tag: 'agencies.verification-rejected' });
    // Spanish founder (locale es) gets the Spanish email with the reason and a link to the page.
    expect(sent[0]?.subject).toContain('Verificación de');
    expect(sent[0]?.text).toContain('Please add the IAE registration.');
    expect(sent[0]?.text).toContain('http://web.test/es/verification');
  });
});
