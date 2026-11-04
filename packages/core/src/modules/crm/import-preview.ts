import {
  AppError,
  CONTACT_IMPORT_PREVIEW,
  type ContactImportDuplicateMode,
  type ContactImportError,
  type ContactImportPreviewDto,
  type ContactImportPreviewRow,
  SHEET_UPLOAD_MAX_BYTES,
  type StartContactImportBody,
} from '@inmolink/contracts';
import { isSheetError, readSheetRows } from '@inmolink/platform/sheet';
import { storage } from '@inmolink/platform/storage';
import type { CtxRunner } from '../../context';
import { assertMappedColumns, contactImportKey, fileProblem, isError, type ParsedRow, parseRow } from './import';
import { distinct } from './normalize';
import { assertCan } from './policy';
import * as repo from './repo';

/**
 * The check before a contact import (S17-F29): what the first rows of the stored file would do with a mapping — read
 * only, nothing imported, nothing stored. Bounded so it can answer in the request: `CONTACT_IMPORT_PREVIEW.checkRows`
 * rows and two lookups, whatever their number. The run itself (`import.ts`) reports on the whole file. Impersonating
 * staff never get here (`crm.contacts.import` is forbidden to them), so no impersonated read is audited.
 * The answer holds the uploader's own cell values (`no-store`, like every CRM answer); nothing here logs one.
 */

/**
 * The same matching as `importBatch`: a row belongs to whatever its first identifier that is already claimed points at
 * (a contact, or an earlier row of the file), and under `SKIP` a matched row claims nothing. `chosen`: the contacts who
 * have chosen on marketing, whom an import's yes leaves alone.
 */
export function classifyRows(
  rows: readonly (ParsedRow | ContactImportError)[],
  owners: readonly repo.IdentifierOwner[],
  onDuplicate: ContactImportDuplicateMode,
  chosen: ReadonlySet<string> = new Set(),
): ContactImportPreviewRow[] {
  /** identifier → the contact that owns it, or null for a row of the file that brought it. */
  const claimed = new Map<string, string | null>(
    owners.map((o) => [`${o.on === 'email' ? 'e' : 'p'}:${o.value}`, o.contactId]),
  );
  return rows.map((r) => {
    if (isError(r)) {
      return {
        row: r.row,
        status: 'INVALID',
        code: r.code,
        contactId: null,
        name: null,
        email: null,
        phone: null,
        consentMarketing: false,
        doNotContact: false,
      };
    }
    const keys = [...r.emails.map((e) => `e:${e}`), ...r.phones.map((p) => `p:${p}`)];
    const hit = keys.find((k) => claimed.has(k));
    const target = hit === undefined ? undefined : (claimed.get(hit) ?? null);
    const merge = onDuplicate === 'MERGE';
    if (hit === undefined || merge) {
      for (const k of keys) if (!claimed.has(k)) claimed.set(k, target ?? null);
    }
    const gets = hit === undefined || (merge && !(target && chosen.has(target)));
    return {
      row: r.row,
      status: hit === undefined ? 'NEW' : target ? 'EXISTING' : 'REPEATED',
      code: null,
      contactId: target ?? null,
      name: [r.firstName, r.lastName].filter(Boolean).join(' ') || null,
      email: r.emails[0] ?? null,
      phone: r.phones[0] ?? null,
      consentMarketing: r.consentMarketing && gets,
      doNotContact: r.doNotContact,
    };
  });
}

/**
 * `POST /v1/crm/contact-imports/:id/preview` (admins). Its own short transactions: the storage call and the parse run
 * outside any.
 */
export async function previewContactImport(
  run: CtxRunner,
  id: string,
  input: StartContactImportBody,
): Promise<ContactImportPreviewDto> {
  const { onDuplicate, ...settings } = input;
  const agencyId = await run(async (ctx) => {
    assertCan(ctx, 'crm.contacts.import');
    const current = await repo.getImport(ctx.tx, id);
    if (!current) throw new AppError('CONTACT_IMPORT_NOT_FOUND');
    if (current.status !== 'UPLOADED') throw new AppError('CONTACT_IMPORT_STARTED');
    assertMappedColumns(settings.mapping, current.headers);
    return current.agencyId;
  });
  const bytes = await storage().get('private', contactImportKey(agencyId, id), { maxBytes: SHEET_UPLOAD_MAX_BYTES });
  if (!bytes) throw new AppError('CONTACT_IMPORT_FILE_INVALID', { reason: 'FILE_MISSING' });

  const parsed: (ParsedRow | ContactImportError)[] = [];
  let more = false;
  try {
    let header = true;
    // one row past the check says whether the file goes on
    const read = { stopAfter: CONTACT_IMPORT_PREVIEW.checkRows + 2, strictPreview: true };
    for await (const row of readSheetRows(bytes, read)) {
      if (header) header = false;
      else if (parsed.length === CONTACT_IMPORT_PREVIEW.checkRows) more = true;
      else parsed.push(parseRow(row.cells, row.index + 1, settings));
    }
  } catch (err) {
    if (isSheetError(err) && err.code === 'PREVIEW_TOO_LARGE') return { rows: [], more: true, unchecked: true };
    throw fileProblem(err);
  }
  const good = parsed.filter((r): r is ParsedRow => !isError(r));
  const { owners, chosen } = await run(async (ctx) => {
    const found = await repo.identifierOwners(
      ctx.tx,
      agencyId,
      distinct(good.flatMap((r) => r.emails)),
      distinct(good.flatMap((r) => r.phones)),
    );
    const marketing = good.some((r) => r.consentMarketing) && onDuplicate === 'MERGE';
    return {
      owners: found,
      chosen: await repo.contactsWithMarketingChoice(
        ctx.tx,
        agencyId,
        marketing ? distinct(found.map((o) => o.contactId)) : [],
      ),
    };
  });
  return { rows: classifyRows(parsed, owners, onDuplicate, chosen), more, unchecked: false };
}
