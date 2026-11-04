import {
  CONTACT_IMPORT_PREVIEW,
  type ContactImportPreviewDto,
  CreateContactBody,
  SHEET_MAX_ROWS,
  SHEET_UPLOAD_MAX_BYTES,
  StartContactImportBody,
  type StartContactImportInput,
} from '@inmolink/contracts';
import { closeDb, countQueries, withSystem } from '@inmolink/db';
import { setupTestDb } from '@inmolink/db/testing';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { SHEET_LIMITS } from '@inmolink/platform/sheet';
import { buildXlsx } from '@inmolink/platform/sheet/testing';
import { configureStorage, createMemoryStore } from '@inmolink/platform/storage';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import { runContactImport } from '../import';
import * as crm from '../index';

/** What the contact import screen relies on (S17-F29): the check before an import, consents, duplicates and the caps. */

const RUN = newId().slice(-8).toLowerCase();
const email = (name: string) => `scr-${name}-${RUN}@example.com`;
const log = createLogger({ service: 'crm-test', level: 'silent' });
const job = () => ({ log, signal: new AbortController().signal, lastAttempt: true });
const store = createMemoryStore();
let a: Founder;
let b: Founder;
let agentId: string;

const as = <T>(userId: string, agencyId: string, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId, agencyId, requestId: newId(), locale: 'en' }, fn);
const asF = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) => as(m.userId, m.agencyId, fn);
const runner =
  (m: Founder) =>
  <T>(fn: (ctx: Ctx) => Promise<T>) =>
    asF(m, fn);
const csv = (lines: string[]) => new TextEncoder().encode(`${lines.join('\n')}\n`);
const body = (input: StartContactImportInput) => StartContactImportBody.parse(input);
const upload = (m: Founder, lines: string[]) => crm.uploadContactImport(runner(m), csv(lines));
const preview = (m: Founder, id: string, input: StartContactImportInput) =>
  crm.previewContactImport(runner(m), id, body(input));
const run = async (m: Founder, id: string, input: StartContactImportInput) => {
  await asF(m, (ctx) => crm.startContactImport(ctx, id, body(input)));
  const result = await runContactImport({ agencyId: m.agencyId, importId: id }, job());
  return { result, report: await asF(m, (ctx) => crm.getContactImport(ctx, id)) };
};
const select = <T>(q: ReturnType<typeof sql>) =>
  withSystem('crm.importScreen.test', async (tx) => (await tx.execute(q)).rows as T[]);
const contactOf = async (m: Founder, address: string) => {
  const found = await asF(m, (ctx) => crm.lookupContacts(ctx, { emails: [address], phones: [] }));
  const id = found.items[0]?.id;
  if (!id) throw new Error('no such contact');
  return asF(m, (ctx) => crm.getContact(ctx, id));
};
const counts = (p: ContactImportPreviewDto) =>
  Object.fromEntries(
    ['NEW', 'EXISTING', 'REPEATED', 'INVALID'].map((s) => [s, p.rows.filter((r) => r.status === s).length]),
  );

async function refusal(promise: Promise<unknown>): Promise<{ code: string; details?: Record<string, unknown> }> {
  try {
    await promise;
  } catch (err) {
    if (isAppError(err)) return { code: err.code, ...(err.details ? { details: err.details } : {}) };
    throw err;
  }
  return { code: 'accepted' };
}

beforeAll(async () => {
  await setupTestDb('worker');
  configureStorage(store);
  [a, b] = await Promise.all([createFounder(), createFounder()]);
  agentId = newId();
  await withSystem('crm.importScreen.test', async (tx) => {
    await tx.execute(sql`insert into users (id, email, password_hash, name, locale, status)
      values (${agentId}, ${`scr-agent-${agentId}@example.com`}, 'x', 'Agent', 'es', 'ACTIVE')`);
    await tx.execute(sql`insert into agency_members (agency_id, user_id, role, name, email)
      values (${a.agencyId}, ${agentId}, 'AGENT', 'Agent', ${`scr-agent-${agentId}@example.com`})`);
  });
});

afterAll(async () => {
  await closeDb();
});

describe('the check before an import', () => {
  it('[S17-F29] shows row errors and duplicates, writes nothing, and agrees with the run', async () => {
    const old = (
      await asF(a, (ctx) =>
        crm.createContact(ctx, CreateContactBody.parse({ firstName: 'Old', emails: [email('old')] })),
      )
    ).contact;
    const file = await upload(a, [
      'Name,Email',
      `Nia,${email('nia')}`,
      `Nia again,${email('nia')}`,
      `Oscar,${email('old')}`,
      'Bad,not-an-address',
      ',',
    ]);
    const input = { mapping: { fullName: 0, emails: [1] } };
    const before = await select<{ n: number }>(
      sql`select count(*)::int as n from contacts where agency_id = ${a.agencyId}`,
    );
    const checked = await preview(a, file.id, input);
    expect(checked.more).toBe(false);
    expect(checked.rows.map((r) => [r.row, r.status, r.code, r.contactId])).toEqual([
      [2, 'NEW', null, null],
      [3, 'REPEATED', null, null],
      [4, 'EXISTING', null, old.id],
      [5, 'INVALID', 'INVALID_EMAIL', null],
    ]);
    expect(checked.rows[0]).toMatchObject({ name: 'Nia', email: email('nia') });

    const after = await select<{ n: number }>(
      sql`select count(*)::int as n from contacts where agency_id = ${a.agencyId}`,
    );
    expect(after).toEqual(before);
    const [row] = await select<{ status: string; mapping: unknown }>(
      sql`select status, mapping from contact_imports where id = ${file.id}`,
    );
    expect(row?.status).toBe('UPLOADED');
    expect(row?.mapping).toBeNull();
    expect(
      await select(
        sql`select 1 from outbox_events where type = 'crm.import.requested' and payload->>'importId' = ${file.id}`,
      ),
    ).toEqual([]);

    const { report } = await run(a, file.id, input);
    expect(report).toMatchObject({
      status: 'SUCCEEDED',
      createdCount: counts(checked).NEW,
      skippedCount: (counts(checked).EXISTING ?? 0) + (counts(checked).REPEATED ?? 0),
      invalidCount: counts(checked).INVALID,
    });
    expect(report.errors).toEqual([{ row: 5, code: 'INVALID_EMAIL' }]);
  });

  it('[S17-F29] is bounded: only the first rows, one lookup whatever their number', async () => {
    const total = CONTACT_IMPORT_PREVIEW.checkRows + 50;
    const lines = Array.from({ length: total }, (_, i) => email(`many${i}`));
    const file = await upload(a, ['Email', ...lines]);
    const setup = await countQueries(() => asF(a, async () => null));
    let result: ContactImportPreviewDto | undefined;
    const queries = await countQueries(async () => {
      result = await preview(a, file.id, { mapping: { emails: [0] } });
    });
    if (!result) throw new Error('no answer');
    expect(result.rows).toHaveLength(CONTACT_IMPORT_PREVIEW.checkRows);
    expect(result.more).toBe(true);
    // two short transactions (policy + import row, then one lookup): nothing per row
    expect(queries).toBeLessThanOrEqual(2 * setup + 2);
  });

  it('[S17-F29] exactly the checked number of rows is not "more"', async () => {
    const lines = Array.from({ length: CONTACT_IMPORT_PREVIEW.checkRows }, (_, i) => email(`exact${i}`));
    const file = await upload(a, ['Email', ...lines]);
    expect((await preview(a, file.id, { mapping: { emails: [0] } })).more).toBe(false);
  });

  it('[S17-F29] only admins of the agency, for an import not yet started, with columns of the file', async () => {
    const file = await upload(a, ['Email', email('auth')]);
    const input = body({ mapping: { emails: [0] } });
    const agentRun = <T>(fn: (ctx: Ctx) => Promise<T>) => as(agentId, a.agencyId, fn);
    expect((await refusal(crm.previewContactImport(agentRun, file.id, input))).code).toBe('FORBIDDEN');
    expect((await refusal(preview(b, file.id, { mapping: { emails: [0] } }))).code).toBe('CONTACT_IMPORT_NOT_FOUND');
    expect(await refusal(preview(a, file.id, { mapping: { emails: [7] } }))).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { reason: 'column' },
    });
    await asF(a, (ctx) => crm.startContactImport(ctx, file.id, input));
    expect((await refusal(preview(a, file.id, { mapping: { emails: [0] } }))).code).toBe('CONTACT_IMPORT_STARTED');
  });
});

describe('the check with merging and Excel', () => {
  it('[S17-F29] agrees with the run under MERGE on an Excel file', async () => {
    const known = email('xl.known');
    await asF(a, (ctx) => crm.createContact(ctx, CreateContactBody.parse({ firstName: 'Known', emails: [known] })));
    const bytes = buildXlsx([
      ['Name', 'Email'],
      ['Xia', email('xl.new')],
      ['Xia again', email('xl.new')],
      ['Other', known],
      ['Bad', 'nope'],
    ]);
    const file = await crm.uploadContactImport(runner(a), new Uint8Array(bytes));
    const input = { mapping: { fullName: 0, emails: [1] }, onDuplicate: 'MERGE' as const };
    const checked = await preview(a, file.id, input);
    expect(counts(checked)).toEqual({ NEW: 1, EXISTING: 1, REPEATED: 1, INVALID: 1 });
    const { report } = await run(a, file.id, input);
    expect(report).toMatchObject({ createdCount: 1, mergedCount: 2, skippedCount: 0, invalidCount: 1 });
  });

  it('[S17-F29] an Excel file whose strings do not fit the check says so, and can still be imported', async () => {
    const rows = [['Email'], [email('xl.far')]];
    const first = CONTACT_IMPORT_PREVIEW.checkRows + 2;
    const bytes = buildXlsx(rows, { sharedOffset: first * SHEET_LIMITS.maxColumns + 1 });
    const file = await crm.uploadContactImport(runner(a), new Uint8Array(bytes));
    const checked = await preview(a, file.id, { mapping: { emails: [0] } });
    expect(checked).toEqual({ rows: [], more: true, unchecked: true });
    const { report } = await run(a, file.id, { mapping: { emails: [0] } });
    expect(report).toMatchObject({ status: 'SUCCEEDED', createdCount: 1 });
  });
});

describe('consent on import', () => {
  const records = (id: string) =>
    select<{ purpose: string; granted: boolean; source: string }>(
      sql`select purpose, granted, source from consent_records where contact_id = ${id}`,
    );

  it('[S17-F29] with no consent column nobody gets a consent, and no record is written', async () => {
    const file = await upload(a, ['Email,Marketing', `${email('cons.none')},yes`]);
    await run(a, file.id, { mapping: { emails: [0] } });
    const c = await contactOf(a, email('cons.none'));
    expect(c).toMatchObject({
      consentMarketing: false,
      consentMarketingAt: null,
      consentProcessing: false,
      source: 'IMPORT',
    });
    expect(await records(c.id)).toEqual([]);
  });

  it('[S17-F29] a mapped column gives consent only where it says yes, recorded with source IMPORT', async () => {
    const file = await upload(a, [
      'Email,Newsletter',
      `${email('cons.yes')},sí`,
      `${email('cons.no')},no`,
      `${email('cons.blank')},`,
      `${email('cons.other')},maybe`,
    ]);
    const checked = await preview(a, file.id, { mapping: { emails: [0], consentMarketing: 1 } });
    expect(checked.rows.map((r) => r.consentMarketing)).toEqual([true, false, false, false]);
    await run(a, file.id, { mapping: { emails: [0], consentMarketing: 1 } });
    const yes = await contactOf(a, email('cons.yes'));
    expect(yes.consentMarketing).toBe(true);
    expect(await records(yes.id)).toEqual([{ purpose: 'MARKETING', granted: true, source: 'IMPORT' }]);
    for (const name of ['cons.no', 'cons.blank', 'cons.other']) {
      const c = await contactOf(a, email(name));
      expect(c.consentMarketing).toBe(false);
      expect(await records(c.id)).toEqual([]);
    }
  });
});

describe('duplicates on import', () => {
  const existing = async (name: string) =>
    (
      await asF(a, (ctx) =>
        crm.createContact(
          ctx,
          CreateContactBody.parse({ firstName: 'Kept', lastName: 'Name', language: 'es', emails: [email(name)] }),
        ),
      )
    ).contact;

  it('[S17-F29] by default a duplicate row leaves the existing contact untouched', async () => {
    const c = await existing('dup.skip');
    const file = await upload(a, ['First,Last,Email,Newsletter', `Other,Person,${email('dup.skip')},yes`]);
    const { report } = await run(a, file.id, {
      mapping: { firstName: 0, lastName: 1, emails: [2], consentMarketing: 3 },
    });
    expect(report).toMatchObject({ onDuplicate: 'SKIP', skippedCount: 1, createdCount: 0, mergedCount: 0 });
    expect(await asF(a, (ctx) => crm.getContact(ctx, c.id))).toEqual(c);
  });

  it('[S17-F29] when merging is chosen, existing values are kept and only blanks are filled', async () => {
    const c = await existing('dup.merge');
    const file = await upload(a, ['First,Last,Email,Language', `Other,Person,${email('dup.merge')},en`]);
    const { report } = await run(a, file.id, {
      mapping: { firstName: 0, lastName: 1, emails: [2], language: 3 },
      onDuplicate: 'MERGE',
    });
    expect(report.mergedCount).toBe(1);
    expect(await asF(a, (ctx) => crm.getContact(ctx, c.id))).toMatchObject({
      firstName: 'Kept',
      lastName: 'Name',
      language: 'es',
      emails: [email('dup.merge')],
    });
  });
});

describe('caps and file checks', () => {
  it('[S17-F29] a file over the byte cap is refused before it is read or stored', async () => {
    const big = new Uint8Array(SHEET_UPLOAD_MAX_BYTES + 1).fill(0x61);
    expect(await refusal(crm.uploadContactImport(runner(a), big))).toMatchObject({
      code: 'CONTACT_IMPORT_FILE_INVALID',
      details: { reason: 'TOO_LARGE' },
    });
  });

  it('[S17-F29] the type comes from the bytes: a PNG named anything is refused', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
    const refused = await refusal(crm.uploadContactImport(runner(a), png));
    expect(refused.code).toBe('CONTACT_IMPORT_FILE_INVALID');
    expect(refused.details?.reason).toBeTypeOf('string');
  });

  it('[S17-F29] a file over the row cap fails whole: no contact is created', async () => {
    const lines = ['Email', ...Array.from({ length: SHEET_MAX_ROWS + 1 }, (_, i) => `capped${i}-${RUN}@example.com`)];
    const file = await upload(a, lines);
    const { result, report } = await run(a, file.id, { mapping: { emails: [0] } });
    expect(result).toEqual({ status: 'FAILED', errorCode: 'TOO_MANY_ROWS' });
    expect(report).toMatchObject({ status: 'FAILED', errorCode: 'TOO_MANY_ROWS', createdCount: 0 });
    const made = await select<{ n: number }>(
      sql`select count(*)::int as n from contact_emails where agency_id = ${a.agencyId} and email like ${`capped%-${RUN}@example.com`}`,
    );
    expect(made[0]?.n).toBe(0);
  });

  it('[S17-F29] the import stays with its agency: another agency cannot read or start it', async () => {
    const file = await upload(a, ['Email', email('tenant')]);
    expect((await refusal(asF(b, (ctx) => crm.getContactImport(ctx, file.id)))).code).toBe('CONTACT_IMPORT_NOT_FOUND');
    expect(
      (await refusal(asF(b, (ctx) => crm.startContactImport(ctx, file.id, body({ mapping: { emails: [0] } }))))).code,
    ).toBe('CONTACT_IMPORT_NOT_FOUND');
  });
});
