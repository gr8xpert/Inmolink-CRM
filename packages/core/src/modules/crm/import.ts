import {
  AppError,
  CONTACT_IMPORT_MAX_ERRORS,
  CONTACT_IMPORT_PREVIEW,
  CONTACT_LIMITS,
  type ContactImportDto,
  type ContactImportError,
  ContactImportMapping,
  type ContactImportPage,
  type ContactImportUploadDto,
  type ContactType,
  type PageQuery,
  SHEET_UPLOAD_MAX_BYTES,
  StartContactImportBody,
} from '@inmolink/contracts';
import { type Tx, withSystem, withTenant } from '@inmolink/db';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import type { Logger } from '@inmolink/platform/logger';
import { emit } from '@inmolink/platform/outbox';
import { detectSheetKind, isSheetError, readSheetRows, type SheetKind } from '@inmolink/platform/sheet';
import { storage } from '@inmolink/platform/storage';
import type { Ctx, CtxRunner } from '../../context';
import { decodeCursor, toPage } from '../../pagination';
import * as billing from '../billing';
import * as compliance from '../compliance';
import { auditImpersonatedRead } from './audit';
import { crmEvents } from './events';
import { distinct, normalizeEmail, normalizePhone } from './normalize';
import { assertCan } from './policy';
import * as repo from './repo';

/**
 * CSV / Excel import of contacts (S10-01). Three steps, like the listing sheet import (S6-05):
 *  1. upload — the file is identified by its first bytes (`platform/sheet`, never its name), the header and the first
 *     rows are read for the mapper, the file is stored privately and an `UPLOADED` import recorded;
 *  2. start — the member's column mapping and defaults are saved (`QUEUED`) and `crm.import.requested` emitted; the
 *     subscription queues `crm.importContacts` (pool `imports`, one per agency at a time);
 *  3. run — the worker streams the file in batches of `IMPORT_BATCH_ROWS`, one transaction per batch (a fixed handful of
 *     statements whatever its size): rows are normalized, matched against the agency's contacts by e-mail and phone
 *     (and against each other), then created, merged into the match (`MERGE`) or skipped (`SKIP`). The checkpoint
 *     (`processed_rows`) moves with each batch, so a retried job never imports a row twice. The file is deleted when
 *     the run ends; uploads never started are deleted by the daily sweep.
 * Cell values are PII: never logged, never stored in the import's report (row numbers and codes only).
 */

export const IMPORT_BATCH_ROWS = 500;
/** An upload not started within this time is deleted (daily sweep). */
export const IMPORT_UPLOAD_TTL_MS = 24 * 3_600_000;
const SWEEP_BATCH = 200;

const CONTENT_TYPES = {
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
} as const;

export const contactImportKey = (agencyId: string, importId: string) => `crm/contact-imports/${agencyId}/${importId}`;

function toImportDto(row: repo.ImportRow): ContactImportDto {
  return {
    id: row.id,
    status: row.status as ContactImportDto['status'],
    kind: row.fileKind as SheetKind,
    onDuplicate: row.onDuplicate as ContactImportDto['onDuplicate'],
    totalRows: row.totalRows,
    createdCount: row.createdCount,
    mergedCount: row.mergedCount,
    skippedCount: row.skippedCount,
    invalidCount: row.invalidCount,
    errors: (row.errors as ContactImportError[]) ?? [],
    errorCode: row.errorCode,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
  };
}

/** The upload route's early check: called from `onRequest`, before Fastify reads the (up to 25 MB) body. */
export async function authorizeContactImport(ctx: Ctx): Promise<void> {
  assertCan(ctx, 'crm.contacts.import');
}

const fileProblem = (err: unknown): unknown =>
  isSheetError(err) ? new AppError('CONTACT_IMPORT_FILE_INVALID', { reason: err.code }) : err;

const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text);

/** Header → field guesses (English and Spanish headers), the mapper's starting point. */
const SUGGEST: readonly [keyof ContactImportMapping, RegExp][] = [
  ['firstName', /^(first[ _-]?name|given[ _-]?name|nombre)$/i],
  ['lastName', /^(last[ _-]?name|surname|family[ _-]?name|apellidos?)$/i],
  ['fullName', /^(full[ _-]?name|name|nombre[ _-]completo|contact|contacto)$/i],
  ['emails', /(e-?mail|correo)/i],
  ['phones', /(phone|tel[eé]fono|^tel|m[oó]vil|mobile|cell|whatsapp)/i],
  ['language', /^(language|lang|idioma|lengua)$/i],
  ['tags', /^(tags?|etiquetas?|labels?)$/i],
  ['types', /^(types?|tipos?|role|rol)$/i],
  // Opt-outs first (S10-01 review): an "unsubscribed" / "baja" column is never read as a consent.
  ['doNotContact', /(do[ _-]?not[ _-]?(contact|call|email)|no[ _-]?contactar|opt[ _-]?out|unsub|baja|robinson)/i],
  ['consentMarketing', /(consent|opt[ _-]?in|marketing|newsletter|consentimiento)/i],
  ['note', /^(notes?|notas?|comments?|comentarios?|observaciones)$/i],
];

export function suggestMapping(headers: readonly string[]): ContactImportUploadDto['suggested'] {
  const out: ContactImportUploadDto['suggested'] = {};
  headers.forEach((header, column) => {
    const name = header.trim();
    const hit = SUGGEST.find(([, re]) => re.test(name));
    if (!hit) return;
    const [field] = hit;
    if (field === 'emails' || field === 'phones') {
      const list = (out[field] as number[] | undefined) ?? [];
      out[field] = [...list, column];
    } else if (out[field] === undefined) {
      out[field] = column;
    }
  });
  if (out.firstName !== undefined || out.lastName !== undefined) delete out.fullName;
  return out;
}

/**
 * `POST /v1/crm/contact-imports` (raw body, admins): checks and previews the file, stores it, records the upload.
 * Its own short transactions: the parse and the storage call run outside any.
 */
export async function uploadContactImport(run: CtxRunner, bytes: Uint8Array): Promise<ContactImportUploadDto> {
  const actor = await run(async (ctx) => {
    assertCan(ctx, 'crm.contacts.import');
    return { agencyId: ctx.tenant.agencyId, userId: ctx.actor.kind === 'user' ? ctx.actor.userId : '' };
  });
  if (bytes.length > SHEET_UPLOAD_MAX_BYTES) {
    throw new AppError('CONTACT_IMPORT_FILE_INVALID', { reason: 'TOO_LARGE' });
  }
  let kind: SheetKind;
  let headers: string[] | null = null;
  const rows: string[][] = [];
  try {
    kind = detectSheetKind(bytes);
    for await (const row of readSheetRows(bytes, { stopAfter: 1 + CONTACT_IMPORT_PREVIEW.rows })) {
      if (!headers) headers = row.cells.map((c) => clip(c.trim(), CONTACT_IMPORT_PREVIEW.headerChars));
      else rows.push(row.cells.map((c) => clip(c, CONTACT_IMPORT_PREVIEW.cellChars)));
    }
  } catch (err) {
    throw fileProblem(err);
  }
  if (!headers || rows.length === 0) throw new AppError('CONTACT_IMPORT_FILE_INVALID', { reason: 'NO_RECORDS' });

  const id = newId();
  const key = contactImportKey(actor.agencyId, id);
  await storage().put('private', key, bytes, { contentType: CONTENT_TYPES[kind] });
  try {
    await run((ctx) =>
      repo.insertImport(ctx.tx, {
        id,
        agencyId: ctx.tenant.agencyId,
        createdBy: actor.userId,
        fileKind: kind,
        fileBytes: bytes.length,
        headers,
      }),
    );
  } catch (err) {
    await storage()
      .delete('private', key)
      .catch(() => undefined);
    throw err;
  }
  return { id, kind, headers, rows, suggested: suggestMapping(headers) };
}

/** What `start` saves next to the mapping: the run reads it back (`StartContactImportBody` without `onDuplicate`). */
type ImportSettings = Omit<StartContactImportBody, 'onDuplicate'>;

/** `POST /v1/crm/contact-imports/:id/start` (admins): saves the mapping and queues the run. */
export async function startContactImport(
  ctx: Ctx,
  id: string,
  input: StartContactImportBody,
): Promise<ContactImportDto> {
  assertCan(ctx, 'crm.contacts.import');
  const current = await repo.getImport(ctx.tx, id, { forUpdate: true });
  if (!current) throw new AppError('CONTACT_IMPORT_NOT_FOUND');
  if (current.status !== 'UPLOADED') throw new AppError('CONTACT_IMPORT_STARTED');
  // S13-F21: an agency already at its plan's contacts cannot start one (each batch is counted again by the run).
  await billing.requireQuota(ctx, 'crm_contacts', repo.contactQuotaUsed(ctx.tx, current.agencyId));
  const { onDuplicate, ...settings } = input;
  const m = settings.mapping;
  const columns = [m.firstName, m.lastName, m.fullName, m.language, m.tags, m.types, m.consentMarketing]
    .concat([m.doNotContact, m.note], m.emails, m.phones)
    .filter((c): c is number => c !== undefined);
  if (columns.some((c) => c >= current.headers.length)) {
    throw new AppError('VALIDATION_FAILED', { field: 'mapping', reason: 'column' });
  }
  await repo.updateImport(ctx.tx, id, { status: 'QUEUED', mapping: settings satisfies ImportSettings, onDuplicate });
  await compliance.audit(
    ctx,
    'crm.contactImport.started',
    { type: 'contactImport', id },
    { kind: current.fileKind, onDuplicate, mappedColumns: columns.length },
  );
  await emit(ctx.tx, crmEvents.importRequested({ agencyId: current.agencyId, importId: id }));
  const row = await repo.getImport(ctx.tx, id);
  if (!row) throw new AppError('CONTACT_IMPORT_NOT_FOUND');
  return toImportDto(row);
}

export async function getContactImport(ctx: Ctx, id: string): Promise<ContactImportDto> {
  assertCan(ctx, 'crm.contacts.read');
  const row = await repo.getImport(ctx.tx, id);
  if (!row) throw new AppError('CONTACT_IMPORT_NOT_FOUND');
  await auditImpersonatedRead(ctx, 'contactImports', { target: { type: 'contactImport', id } });
  return toImportDto(row);
}

export async function listContactImports(ctx: Ctx, query: PageQuery): Promise<ContactImportPage> {
  assertCan(ctx, 'crm.contacts.read');
  const cursor = decodeCursor(query.cursor);
  const rows = await repo.listImports(
    ctx.tx,
    ctx.tenant.agencyId,
    cursor ? { limit: query.limit, cursor } : { limit: query.limit },
  );
  const page = toPage(rows, query.limit, (r) => ({ at: r.createdAt, id: r.id, atUs: r.atUs }), toImportDto);
  await auditImpersonatedRead(ctx, 'contactImports', { count: page.items.length });
  return page;
}

// ---- the run ------------------------------------------------------------------------------------------------------

/** One data row as the mapping reads it. */
export interface ParsedRow {
  row: number;
  firstName: string | null;
  lastName: string | null;
  emails: string[];
  phones: string[];
  language: string | null;
  tags: string[];
  types: ContactType[];
  consentMarketing: boolean;
  doNotContact: boolean;
  note: string | null;
}

const TYPE_WORDS: Record<string, ContactType> = {
  buyer: 'BUYER',
  comprador: 'BUYER',
  compradora: 'BUYER',
  seller: 'SELLER',
  vendor: 'SELLER',
  vendedor: 'SELLER',
  vendedora: 'SELLER',
  tenant: 'TENANT',
  inquilino: 'TENANT',
  inquilina: 'TENANT',
  arrendatario: 'TENANT',
  landlord: 'LANDLORD',
  propietario: 'LANDLORD',
  propietaria: 'LANDLORD',
  arrendador: 'LANDLORD',
};
const YES = new Set(['yes', 'y', 'si', 'sí', 's', 'true', '1', 'x']);
const LANGUAGE = /^[a-z]{2}(-[A-Z]{2})?$/;
const split = (cell: string) =>
  cell
    .split(/[;,|]/)
    .map((v) => v.trim())
    .filter(Boolean);

/** Reads one data row with the mapping: a value or the reason the row cannot be imported. */
export function parseRow(
  cells: readonly string[],
  row: number,
  settings: ImportSettings,
): ParsedRow | ContactImportError {
  const m = settings.mapping;
  const cell = (c: number | undefined) => (c === undefined ? '' : (cells[c] ?? '').trim());
  let firstName = cell(m.firstName) || null;
  let lastName = cell(m.lastName) || null;
  if (!firstName && !lastName && m.fullName !== undefined) {
    const full = cell(m.fullName).replace(/\s+/g, ' ');
    const space = full.indexOf(' ');
    firstName = (space < 0 ? full : full.slice(0, space)) || null;
    lastName = space < 0 ? null : full.slice(space + 1) || null;
  }
  if ((firstName?.length ?? 0) > CONTACT_LIMITS.nameChars || (lastName?.length ?? 0) > CONTACT_LIMITS.nameChars) {
    return { row, code: 'TOO_LONG' };
  }
  const emails: string[] = [];
  for (const raw of m.emails.flatMap((c) => split(cell(c)))) {
    const email = normalizeEmail(raw);
    if (!email) return { row, code: 'INVALID_EMAIL' };
    emails.push(email);
  }
  const phones: string[] = [];
  for (const raw of m.phones.flatMap((c) =>
    cell(c)
      .split(/[;,|/]/)
      .map((v) => v.trim())
      .filter(Boolean),
  )) {
    const phone = normalizePhone(raw, settings.phoneCountry);
    if (!phone) return { row, code: 'INVALID_PHONE' };
    phones.push(phone);
  }
  if (!firstName && !lastName && emails.length === 0 && phones.length === 0) return { row, code: 'NO_IDENTITY' };
  const languageCell = cell(m.language);
  const language = LANGUAGE.test(languageCell)
    ? languageCell
    : LANGUAGE.test(languageCell.toLowerCase())
      ? languageCell.toLowerCase()
      : null;
  const types = distinct(
    split(cell(m.types))
      .map((t) => TYPE_WORDS[t.toLowerCase()] ?? (t.toUpperCase() as ContactType))
      .filter((t) => ['BUYER', 'SELLER', 'TENANT', 'LANDLORD'].includes(t)),
  );
  const tags = distinct([...settings.tags, ...split(cell(m.tags))].map((t) => clip(t, CONTACT_LIMITS.tagChars))).slice(
    0,
    CONTACT_LIMITS.tags,
  );
  const note = cell(m.note);
  return {
    row,
    firstName,
    lastName,
    emails: distinct(emails).slice(0, CONTACT_LIMITS.emails),
    phones: distinct(phones).slice(0, CONTACT_LIMITS.phones),
    language,
    tags,
    types: types.length > 0 ? types : distinct(settings.defaultTypes),
    consentMarketing: YES.has(cell(m.consentMarketing).toLowerCase()),
    doNotContact: YES.has(cell(m.doNotContact).toLowerCase()),
    note: note ? clip(note, CONTACT_LIMITS.noteChars) : null,
  };
}

const isError = (r: ParsedRow | ContactImportError): r is ContactImportError => 'code' in r && !('emails' in r);

/** A contact the batch builds: a new one, or an existing one the rows merge into. */
interface Target {
  contactId: string;
  existing: boolean;
  data: ParsedRow;
  /** Identifiers the batch adds to it (new to the agency). */
  emails: string[];
  phones: string[];
  notes: string[];
}

function fold(into: ParsedRow, row: ParsedRow): void {
  into.firstName ??= row.firstName;
  into.lastName ??= row.lastName;
  into.language ??= row.language;
  into.types = distinct([...into.types, ...row.types]);
  into.tags = distinct([...into.tags, ...row.tags]).slice(0, CONTACT_LIMITS.tags);
  into.consentMarketing ||= row.consentMarketing;
  into.doNotContact ||= row.doNotContact;
}

export interface BatchOutcome {
  created: number;
  merged: number;
  skipped: number;
  invalid: number;
  errors: ContactImportError[];
}

/**
 * One batch in one transaction: one lookup of the agency's contacts owning the batch's e-mails and phones, then at
 * most ten statements (contacts, e-mails, phones, notes, the merge patches, the merged contacts' new identifiers,
 * primaries, events, progress) — no statement per row.
 */
export async function importBatch(
  tx: Tx,
  scope: { agencyId: string; importId: string; onDuplicate: 'SKIP' | 'MERGE'; processedRows: number },
  settings: ImportSettings,
  rows: readonly { row: number; cells: readonly string[] }[],
): Promise<BatchOutcome> {
  const out: BatchOutcome = { created: 0, merged: 0, skipped: 0, invalid: 0, errors: [] };
  const parsed: ParsedRow[] = [];
  for (const r of rows) {
    const p = parseRow(r.cells, r.row, settings);
    if (isError(p)) {
      out.invalid += 1;
      out.errors.push(p);
    } else parsed.push(p);
  }
  const owners = await repo.identifierOwners(
    tx,
    scope.agencyId,
    distinct(parsed.flatMap((p) => p.emails)),
    distinct(parsed.flatMap((p) => p.phones)),
  );
  /** identifier ("e:" / "p:" + value) → the contact (existing or built here) it belongs to. */
  const claimed = new Map<string, Target>();
  const existing = new Map<string, Target>();
  for (const o of owners) {
    let target = existing.get(o.contactId);
    if (!target) {
      target = {
        contactId: o.contactId,
        existing: true,
        data: {
          row: 0,
          firstName: null,
          lastName: null,
          emails: [],
          phones: [],
          language: null,
          tags: [],
          types: [],
          consentMarketing: false,
          doNotContact: false,
          note: null,
        },
        emails: [],
        phones: [],
        notes: [],
      };
      existing.set(o.contactId, target);
    }
    claimed.set(`${o.on === 'email' ? 'e' : 'p'}:${o.value}`, target);
  }
  const created: Target[] = [];
  const mergedInto = new Set<Target>();
  /** identifier key → the row that brought it (a `DUPLICATE_RACE` report names the row). */
  const rowOf = new Map<string, number>();
  for (const p of parsed) {
    const keys = [...p.emails.map((e) => `e:${e}`), ...p.phones.map((v) => `p:${v}`)];
    const match = keys.map((k) => claimed.get(k)).find((t) => t !== undefined);
    if (match && scope.onDuplicate === 'SKIP') {
      out.skipped += 1;
      continue;
    }
    const target: Target = match ?? {
      contactId: newId(),
      existing: false,
      data: { ...p, emails: [], phones: [] },
      emails: [],
      phones: [],
      notes: [],
    };
    if (match) {
      fold(match.data, p);
      out.merged += 1;
      if (match.existing) mergedInto.add(match);
    } else {
      created.push(target);
      out.created += 1;
    }
    for (const e of p.emails) {
      if (!claimed.has(`e:${e}`)) {
        claimed.set(`e:${e}`, target);
        rowOf.set(`e:${e}`, p.row);
        target.emails.push(e);
      }
    }
    for (const v of p.phones) {
      if (!claimed.has(`p:${v}`)) {
        claimed.set(`p:${v}`, target);
        rowOf.set(`p:${v}`, p.row);
        target.phones.push(v);
      }
    }
    if (p.note) target.notes.push(p.note);
  }

  const agencyId = scope.agencyId;
  // S13-F21: Free's CRM holds 100 contacts (PLAN §11). The batch's new contacts are counted against the plan quota
  // under the agency's contact-quota lock (merges add none); a batch that would cross it is refused whole and the run
  // fails with `PLAN_REQUIRED` — the batches before it stay imported (their counts are on the import).
  if (created.length > 0) {
    await billing.requireAgencyQuota(tx, agencyId, 'crm_contacts', repo.contactQuotaUsed(tx, agencyId), created.length);
  }
  await repo.insertContacts(
    tx,
    created.map((t) => ({
      id: t.contactId,
      agencyId,
      ownerUserId: null,
      types: t.data.types,
      firstName: t.data.firstName,
      lastName: t.data.lastName,
      language: t.data.language,
      source: 'IMPORT',
      tags: t.data.tags,
      consentMarketing: t.data.consentMarketing,
      consentMarketingAt: t.data.consentMarketing ? new Date() : null,
      consentProcessing: settings.consentProcessing,
      consentProcessingAt: settings.consentProcessing ? new Date() : null,
      doNotContact: t.data.doNotContact,
    })),
  );
  const merged = [...mergedInto];
  const versions = await repo.absorb(
    tx,
    agencyId,
    merged.map((t) => ({
      contactId: t.contactId,
      types: t.data.types,
      tags: t.data.tags,
      firstName: t.data.firstName,
      lastName: t.data.lastName,
      language: t.data.language,
      consentMarketing: t.data.consentMarketing,
      consentMarketingAt: null,
      consentProcessing: settings.consentProcessing,
      consentProcessingAt: null,
      doNotContact: t.data.doNotContact,
    })),
    CONTACT_LIMITS.tags,
  );
  // New contacts' identifiers first (positions from 0); merged ones go after the contact's own (positions from 100).
  const all = [...created, ...merged];
  const base = (t: Target) => (t.existing ? 100 : 0);
  const inserted = await repo.insertIdentifiers(
    tx,
    agencyId,
    all.flatMap((t) => t.emails.map((value, i) => ({ contactId: t.contactId, value, position: base(t) + i }))),
    all.flatMap((t) => t.phones.map((value, i) => ({ contactId: t.contactId, value, position: base(t) + i }))),
    { skipTaken: true },
  );
  // Another contact took an identifier between the lookup and the insert (a concurrent form or import): the row is
  // imported without it and reported, never failing the batch (S10-01 review).
  const raced = new Set<number>();
  for (const t of all) {
    for (const e of t.emails) if (!inserted.emails.has(e)) raced.add(rowOf.get(`e:${e}`) ?? 0);
    for (const v of t.phones) if (!inserted.phones.has(v)) raced.add(rowOf.get(`p:${v}`) ?? 0);
  }
  for (const row of [...raced].sort((x, y) => x - y)) out.errors.push({ row, code: 'DUPLICATE_RACE' });
  await repo.insertNotes(
    tx,
    all.flatMap((t) => t.notes.map((body) => ({ agencyId, contactId: t.contactId, authorUserId: null, body }))),
  );
  await repo.refreshPrimaries(
    tx,
    agencyId,
    all.map((t) => t.contactId),
  );
  await repo.syncFacets(
    tx,
    agencyId,
    all.map((t) => t.contactId),
  );
  await emit(tx, [
    ...created.map((t) => crmEvents.contactCreated({ agencyId, contactId: t.contactId, source: 'IMPORT' })),
    ...versions.map((v) => crmEvents.contactUpdated({ agencyId, contactId: v.id, version: v.version })),
  ]);
  await repo.addImportProgress(
    tx,
    scope.importId,
    { processedRows: scope.processedRows + rows.length, ...out },
    CONTACT_IMPORT_MAX_ERRORS,
  );
  return out;
}

export interface RunResult {
  status: 'SUCCEEDED' | 'FAILED' | 'SKIPPED';
  errorCode?: string;
}

/**
 * `crm.importContacts`: claims the import (QUEUED, or RUNNING after a crash), streams the stored file and imports
 * it batch by batch as the agency (`withTenant`, RLS), resuming after `processed_rows`. A file that is not readable
 * fails the import with the sheet's error code; any other error is retried by the queue (`lastAttempt` fails it).
 */
export async function runContactImport(
  p: { agencyId: string; importId: string },
  job: { log: Logger; signal: AbortSignal; lastAttempt: boolean },
): Promise<RunResult> {
  const claim = await withTenant({ agencyId: p.agencyId }, async (tx) => {
    const row = await repo.getImport(tx, p.importId, { forUpdate: true });
    if (!row || (row.status !== 'QUEUED' && row.status !== 'RUNNING')) return null;
    await repo.updateImport(tx, row.id, { status: 'RUNNING', startedAt: row.startedAt ?? new Date() });
    return row;
  });
  if (!claim) return { status: 'SKIPPED' };
  const settingsParsed = StartContactImportBody.omit({ onDuplicate: true }).safeParse(claim.mapping);
  const mappingOk = settingsParsed.success && ContactImportMapping.safeParse(settingsParsed.data.mapping).success;
  const key = contactImportKey(p.agencyId, p.importId);
  try {
    if (!settingsParsed.success || !mappingOk) return await finish(p, key, 'FAILED', 'MAPPING_INVALID');
    const settings = settingsParsed.data;
    const bytes = await storage().get('private', key, { maxBytes: SHEET_UPLOAD_MAX_BYTES });
    if (!bytes) return await finish(p, key, 'FAILED', 'FILE_MISSING');
    let processed = claim.processedRows;
    let seen = 0;
    let header = true;
    let batch: { row: number; cells: string[] }[] = [];
    const flush = async () => {
      if (batch.length === 0) return;
      const rows = batch;
      batch = [];
      await withTenant({ agencyId: p.agencyId }, (tx) =>
        importBatch(
          tx,
          {
            agencyId: p.agencyId,
            importId: p.importId,
            onDuplicate: claim.onDuplicate as 'SKIP' | 'MERGE',
            processedRows: processed,
          },
          settings,
          rows,
        ),
      );
      processed += rows.length;
    };
    try {
      for await (const row of readSheetRows(bytes)) {
        if (header) {
          header = false;
          continue;
        }
        seen += 1;
        if (seen <= claim.processedRows) continue; // imported by an earlier attempt
        batch.push({ row: row.index + 1, cells: row.cells });
        if (batch.length >= IMPORT_BATCH_ROWS) {
          if (job.signal.aborted) throw new Error('aborted');
          await flush();
        }
      }
      await flush();
    } catch (err) {
      if (isSheetError(err)) return await finish(p, key, 'FAILED', err.code);
      // S13-F21: over the plan's contacts: not retried (the plan decides), the import says why.
      if (isAppError(err) && err.code === 'PLAN_REQUIRED') return await finish(p, key, 'FAILED', 'PLAN_REQUIRED');
      throw err;
    }
    job.log.info({ importId: p.importId, rows: processed }, 'contact import finished');
    return await finish(p, key, 'SUCCEEDED', null);
  } catch (err) {
    if (job.lastAttempt) await finish(p, key, 'FAILED', 'INTERNAL').catch(() => undefined);
    throw err;
  }
}

async function finish(
  p: { agencyId: string; importId: string },
  key: string,
  status: 'SUCCEEDED' | 'FAILED',
  errorCode: string | null,
): Promise<RunResult> {
  await withTenant({ agencyId: p.agencyId }, (tx) =>
    repo.updateImport(tx, p.importId, { status, errorCode, finishedAt: new Date() }),
  );
  // After the commit: the file is PII and no longer needed. A failed delete leaves `file_deleted_at` null: the daily
  // sweep deletes it then (S10-01 review).
  const deleted = await storage()
    .delete('private', key)
    .then(() => true)
    .catch(() => false);
  if (deleted) await withTenant({ agencyId: p.agencyId }, (tx) => repo.markFilesDeleted(tx, [p.importId]));
  return errorCode ? { status, errorCode } : { status };
}

/** A finished run's file is left alone this long before the sweep retries its delete (the run deletes it itself). */
export const IMPORT_FINISHED_GRACE_MS = 3_600_000;

/**
 * `crm.sweepContactImports` (daily): deletes the files left in storage — uploads never started within
 * `IMPORT_UPLOAD_TTL_MS` (expired first, so a start racing the sweep finds `EXPIRED`), and finished runs whose own
 * delete failed (`file_deleted_at` null after `IMPORT_FINISHED_GRACE_MS`). System role (every agency); a file whose
 * delete fails again stays listed for the next pass.
 */
export async function sweepContactImports(opts: { now?: Date; signal?: AbortSignal } = {}): Promise<{
  expired: number;
  filesDeleted: number;
}> {
  const now = (opts.now ?? new Date()).getTime();
  const uploadedBefore = new Date(now - IMPORT_UPLOAD_TTL_MS);
  const finishedBefore = new Date(now - IMPORT_FINISHED_GRACE_MS);
  let expired = 0;
  let filesDeleted = 0;
  const failed = new Set<string>();
  for (;;) {
    if (opts.signal?.aborted) break;
    const batch = await withSystem('crm.sweepContactImports', async (tx) => {
      const rows = (await repo.filesToSweep(tx, uploadedBefore, finishedBefore, SWEEP_BATCH + failed.size)).filter(
        (r) => !failed.has(r.id),
      );
      await repo.expireImports(
        tx,
        rows.filter((r) => r.status === 'UPLOADED').map((r) => r.id),
      );
      return rows;
    });
    expired += batch.filter((r) => r.status === 'UPLOADED').length;
    const done: string[] = [];
    for (const r of batch) {
      const ok = await storage()
        .delete('private', contactImportKey(r.agencyId, r.id))
        .then(() => true)
        .catch(() => false);
      if (ok) done.push(r.id);
      else failed.add(r.id);
    }
    await withSystem('crm.sweepContactImports', (tx) => repo.markFilesDeleted(tx, done));
    filesDeleted += done.length;
    if (batch.length < SWEEP_BATCH) break;
  }
  return { expired, filesDeleted };
}
