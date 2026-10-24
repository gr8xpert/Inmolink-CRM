import type { DataExportErrorCode, DataExportFormat, DataExportKind } from '@inmolink/contracts';
import { withSystem, withTenant } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
import type { Logger } from '@inmolink/platform/logger';
import { isPermanent } from '@inmolink/platform/queue';
import {
  type ByteSink,
  type ExportCell,
  ExportTooLargeError,
  startTableWriter,
  ZipWriter,
} from '@inmolink/platform/sheet';
import { MIN_UPLOAD_PART_BYTES, storage } from '@inmolink/platform/storage';
import type { KeysetCursor } from '../../pagination';
import * as crm from '../crm';
import * as media from '../media';
import * as properties from '../properties';
import { DATA_EXPORT_CONTENT_TYPES, DATA_EXPORT_TTL_MS, dataExportExtension, dataExportKey } from './data-export';
import * as repo from './data-export-repo';

/**
 * Data export, the worker side (S10-08): `compliance.runDataExport` writes one export's file. Only `worker.ts` (the
 * jobs) imports this file — it reads crm, properties and media through their public worker readers, which the
 * module's request-side `index.ts` must not import (`no-circular`).
 *
 * The run claims the export (`RUNNING`, attempt n), then streams: each table is read in keyset pages of
 * `EXPORT_PAGE_ROWS` (one short transaction per page — never a transaction held across the run, never a network call
 * inside one), written row by row through the CSV / XLSX writer (`platform/sheet`, formula injection handled there) —
 * for `ACCOUNT` into a ZIP entry each — and sent to storage as a multipart upload. Memory holds a page and one upload
 * part, never the file: a 100k-contact export is the same RSS as a 1k one. Progress is reported per page.
 *
 * Reads: contacts and leads as the agency (`withTenant`, RLS: crm's keyset is a stored column, an index condition
 * under RLS). Listings and their media as `app_system` with the agency's id as an explicit predicate (`withSystem`,
 * PATTERNS §12): the listing keyset is `date_trunc('milliseconds', created_at)` — not leakproof, so under RLS it is
 * only a filter (EXPLAIN under `withTenant`: every page read and sorted all of the agency's listings); without RLS the
 * row comparison is an index condition on `properties_agency_created_idx`.
 *
 * Outcomes are written only by the attempt holding the claim (`finishExport`: `RUNNING` and this attempt); a stale
 * attempt's uploaded file is deleted. A permanent error or the last attempt fails the export at once (expiring now,
 * so the sweep deletes anything stored), so the agency can start another. Logs carry ids and counts only, never a cell.
 *
 * Assumption (STATUS Decisions): the export is the agency's own data — every open contact is included, `do not
 * contact` ones too (the flag is a column), and so are commissions and internal fields; merged (closed) contacts,
 * deleted listings, contact notes, activities and the listing's private side table are not part of this export.
 */

/** Rows read per page (one transaction each). */
export const EXPORT_PAGE_ROWS = 1_000;
/** The upload's part size: the smallest S3 allows, so a run holds little while several run at once. */
const PART_BYTES = MIN_UPLOAD_PART_BYTES;

let mediaBaseUrl = '';

/** Called once at boot by the worker: the manifest's image URLs are under this base (the media CDN). */
export function configureDataExport(config: { mediaBaseUrl?: string }): void {
  mediaBaseUrl = (config.mediaBaseUrl ?? '').replace(/\/+$/, '');
}

const list = (values: readonly string[] | null | undefined) => (values ?? []).join('; ');
const units = (cents: number | null | undefined) => (cents === null || cents === undefined ? null : cents / 100);
const num = (v: string | number | null | undefined) => (v === null || v === undefined ? null : Number(v));

type Progress = (rows: number) => Promise<void>;

interface Table {
  name: 'contacts' | 'leads' | 'listings' | 'media';
  header: readonly string[];
  rows: (agencyId: string) => AsyncGenerator<ExportCell[]>;
}

type ReadTx = Parameters<Parameters<typeof withTenant>[1]>[0];

/** Keyset pages of a reader, each read in its own short transaction (`as`: the agency's RLS, or the system role). */
async function* pages<R extends { id: string }>(
  agencyId: string,
  as: 'tenant' | 'system',
  read: (tx: ReadTx, after: KeysetCursor | null) => Promise<R[]>,
  keyOf: (row: R) => Date,
): AsyncGenerator<R[]> {
  let after: KeysetCursor | null = null;
  for (;;) {
    const cursor = after;
    const page =
      as === 'tenant'
        ? await withTenant({ agencyId }, (tx) => read(tx, cursor))
        : await withSystem('compliance.runDataExport', (tx) => read(tx, cursor));
    if (page.length > 0) yield page;
    if (page.length < EXPORT_PAGE_ROWS) return;
    const last = page[page.length - 1] as R;
    after = { at: keyOf(last), id: last.id };
  }
}

const CONTACTS: Table = {
  name: 'contacts',
  header: [
    'id',
    'first_name',
    'last_name',
    'emails',
    'phones',
    'types',
    'tags',
    'language',
    'source',
    'owner_user_id',
    'consent_marketing',
    'consent_marketing_at',
    'consent_processing',
    'consent_processing_at',
    'do_not_contact',
    'created_at',
    'updated_at',
  ],
  async *rows(agencyId) {
    const read = (tx: ReadTx, after: KeysetCursor | null) =>
      crm.contactsForExport(tx, agencyId, { after, limit: EXPORT_PAGE_ROWS });
    for await (const page of pages(agencyId, 'tenant', read, (r) => r.createdMs)) {
      for (const c of page) {
        yield [
          c.id,
          c.firstName,
          c.lastName,
          list(c.emails),
          list(c.phones),
          list(c.types),
          list(c.tags),
          c.language,
          c.source,
          c.ownerUserId,
          c.consentMarketing,
          c.consentMarketingAt,
          c.consentProcessing,
          c.consentProcessingAt,
          c.doNotContact,
          c.createdAt,
          c.updatedAt,
        ];
      }
    }
  },
};

const LEADS: Table = {
  name: 'leads',
  header: [
    'id',
    'contact_id',
    'source',
    'kind',
    'status',
    'target_kind',
    'target_id',
    'shown_ref',
    'owner_agency_id',
    'presenting_agency_id',
    'message',
    'locale',
    'visitor_name',
    'visitor_email',
    'visitor_phone',
    'visitor_marketing_consent',
    'assigned_user_id',
    'assigned_at',
    'first_responded_at',
    'created_at',
    'updated_at',
  ],
  async *rows(agencyId) {
    const read = (tx: ReadTx, after: KeysetCursor | null) =>
      crm.leadsForExport(tx, agencyId, { after, limit: EXPORT_PAGE_ROWS });
    for await (const page of pages(agencyId, 'tenant', read, (r) => r.createdMs)) {
      for (const l of page) {
        yield [
          l.id,
          l.contactId,
          l.source,
          l.kind,
          l.status,
          l.targetKind,
          l.targetId,
          l.shownRef,
          l.ownerAgencyId,
          l.presentingAgencyId,
          l.message,
          l.locale,
          l.visitorName,
          l.visitorEmail,
          l.visitorPhone,
          l.visitorMarketingConsent,
          l.assignedUserId,
          l.assignedAt,
          l.firstRespondedAt,
          l.createdAt,
          l.updatedAt,
        ];
      }
    }
  },
};

const listingPages = (agencyId: string) =>
  pages(
    agencyId,
    'system',
    (tx, after) => properties.listingsForExport(tx, agencyId, { after, limit: EXPORT_PAGE_ROWS }),
    (r) => r.keyAt,
  );

const LISTINGS: Table = {
  name: 'listings',
  header: [
    'id',
    'ref',
    'source',
    'status',
    'visibility',
    'share_scope',
    'transaction_type',
    'price',
    'price_to',
    'currency',
    'price_period',
    'price_on_request',
    'community_fee_month',
    'ibi_year',
    'garbage_tax_year',
    'commission_bp',
    'commission_fixed',
    'split_bp',
    'commission_includes_vat',
    'built_m2',
    'plot_m2',
    'terrace_m2',
    'bedrooms',
    'bathrooms',
    'year_built',
    'energy_rating',
    'energy_emissions_rating',
    'lat',
    'lng',
    'location_precision',
    'property_type_id',
    'location_id',
    'development_id',
    'owner_user_id',
    'last_confirmed_at',
    'created_at',
    'updated_at',
  ],
  async *rows(agencyId) {
    for await (const page of listingPages(agencyId)) {
      for (const p of page) {
        yield [
          p.id,
          p.ref,
          p.source,
          p.status,
          p.visibility,
          p.shareScope,
          p.transactionType,
          units(p.priceCents),
          units(p.priceToCents),
          p.currency,
          p.pricePeriod,
          p.priceOnRequest,
          units(p.communityFeeMonthCents),
          units(p.ibiYearCents),
          units(p.garbageTaxYearCents),
          p.commissionBp,
          units(p.commissionFixedCents),
          p.splitBp,
          p.commissionIncludesVat,
          num(p.builtM2),
          num(p.plotM2),
          num(p.terraceM2),
          p.bedrooms,
          p.bathrooms,
          p.yearBuilt,
          p.energyRating,
          p.energyEmissionsRating,
          num(p.lat),
          num(p.lng),
          p.locationPrecision,
          p.propertyTypeId,
          p.locationId,
          p.developmentId,
          p.ownerUserId,
          p.lastConfirmedAt,
          p.createdAt,
          p.updatedAt,
        ];
      }
    }
  },
};

/** Largest stored image first: the manifest links the best copy a public URL serves. */
const IMAGE_SIZES = ['large', 'medium', 'og', 'small', 'thumb'] as const;

/**
 * The media manifest (ACCOUNT only): one row per shown image, floor plan and video link of each listing, in display
 * order — the public CDN URL of the largest variant (a variant key is an HMAC of the content hash, never the hash),
 * or no URL when the worker has no media CDN configured; video provider and id. Images still processing are left out.
 */
const MEDIA: Table = {
  name: 'media',
  header: [
    'listing_id',
    'listing_ref',
    'position',
    'kind',
    'cover',
    'url',
    'width',
    'height',
    'alt_text',
    'room',
    'video_provider',
    'video_id',
  ],
  async *rows(agencyId) {
    for await (const page of listingPages(agencyId)) {
      const ids = page.map((p) => p.id);
      const sets = await withSystem('compliance.runDataExport media', (tx) => media.mediaForReadModels(tx, ids));
      for (const listing of page) {
        const items = sets.get(listing.id)?.items ?? [];
        let position = 0;
        for (const item of items) {
          position += 1;
          if (item.kind === 'VIDEO') {
            yield [
              listing.id,
              listing.ref,
              position,
              'VIDEO',
              false,
              null,
              null,
              null,
              null,
              null,
              item.provider,
              item.id,
            ];
            continue;
          }
          const variants = item.variants as Partial<Record<string, string>>;
          const size = IMAGE_SIZES.find((s) => variants[s]);
          const key = size ? variants[size] : undefined;
          yield [
            listing.id,
            listing.ref,
            position,
            item.kind,
            item.cover,
            key && mediaBaseUrl ? `${mediaBaseUrl}/${key}` : null,
            item.width,
            item.height,
            item.alt,
            item.room,
            null,
            null,
          ];
        }
      }
    }
  },
};

const TABLES: Record<Exclude<DataExportKind, 'ACCOUNT'>, Table> = {
  CONTACTS,
  LEADS,
  LISTINGS,
};

async function writeTable(
  table: Table,
  agencyId: string,
  format: DataExportFormat,
  sink: ByteSink,
  job: { signal: AbortSignal; progress: Progress },
): Promise<number> {
  const writer = await startTableWriter(format, sink, table.header, { sheetName: table.name });
  let rows = 0;
  for await (const row of table.rows(agencyId)) {
    await writer.row(row);
    rows += 1;
    if (rows % EXPORT_PAGE_ROWS === 0) {
      if (job.signal.aborted) throw new Error('aborted');
      await job.progress(rows);
    }
  }
  await writer.finish();
  return rows;
}

export interface DataExportRunResult {
  status: 'SUCCEEDED' | 'FAILED' | 'SKIPPED' | 'STALE';
  errorCode?: DataExportErrorCode;
}

/** Fails the export (only while this attempt holds it); expiring now: the sweep deletes anything a run left stored. */
async function fail(
  p: { agencyId: string; exportId: string },
  attempt: number,
  errorCode: DataExportErrorCode,
): Promise<DataExportRunResult> {
  const now = clock.now();
  await withTenant({ agencyId: p.agencyId }, (tx) =>
    repo.finishExport(tx, p.exportId, attempt, {
      status: 'FAILED',
      errorCode,
      finishedAt: now,
      expiresAt: now,
    }),
  );
  return { status: 'FAILED', errorCode };
}

/** `compliance.runDataExport`: writes the export's file and records the outcome. */
export async function runDataExport(
  p: { agencyId: string; exportId: string },
  job: { log: Logger; signal: AbortSignal; lastAttempt: boolean; progress?: (value: object) => Promise<void> },
): Promise<DataExportRunResult> {
  const claim = await withTenant({ agencyId: p.agencyId }, (tx) => repo.claimExport(tx, p.exportId));
  if (!claim) return { status: 'SKIPPED' };
  const attempt = claim.attempts;
  const kind = claim.kind as DataExportKind;
  const format = claim.format as DataExportFormat;
  const ext = dataExportExtension(kind, format);
  const key = dataExportKey(p.agencyId, p.exportId);
  const upload = storage().upload('private', key, {
    contentType: DATA_EXPORT_CONTENT_TYPES[ext],
    partBytes: PART_BYTES,
  });
  const sink: ByteSink = (chunk) => upload.write(chunk);
  const counts: Record<string, number> = {};
  let done = 0;
  const progress =
    (table: string): Progress =>
    async (rows) => {
      await job.progress?.({ table, rows: done + rows });
    };
  let uploaded = false;
  try {
    if (kind === 'ACCOUNT') {
      const zip = new ZipWriter(sink, { now: clock.now() });
      for (const table of [CONTACTS, LEADS, LISTINGS, MEDIA]) {
        // a workbook is a ZIP already: stored as is, not deflated twice
        await zip.begin(`${table.name}.${format}`, { store: format === 'xlsx' });
        counts[table.name] = await writeTable(table, p.agencyId, format, (c) => zip.write(c), {
          signal: job.signal,
          progress: progress(table.name),
        });
        done += counts[table.name] ?? 0;
        await zip.end();
      }
      await zip.add(
        'manifest.json',
        JSON.stringify(
          {
            exportId: p.exportId,
            agencyId: p.agencyId,
            generatedAt: clock.now().toISOString(),
            format,
            files: Object.fromEntries(
              Object.entries(counts).map(([name, rows]) => [name, { file: `${name}.${format}`, rows }]),
            ),
          },
          null,
          2,
        ),
      );
      await zip.finish();
    } else {
      const table = TABLES[kind];
      counts[table.name] = await writeTable(table, p.agencyId, format, sink, {
        signal: job.signal,
        progress: progress(table.name),
      });
    }
    const { sizeBytes } = await upload.complete();
    uploaded = true;
    const finishedAt = clock.now();
    const recorded = await withTenant({ agencyId: p.agencyId }, (tx) =>
      repo.finishExport(tx, p.exportId, attempt, {
        status: 'SUCCEEDED',
        counts,
        fileBytes: sizeBytes,
        errorCode: null,
        finishedAt,
        expiresAt: new Date(finishedAt.getTime() + DATA_EXPORT_TTL_MS),
      }),
    );
    if (!recorded) {
      // A later attempt or the sweep took the export over: this attempt's file is nobody's.
      await storage()
        .delete('private', key)
        .catch(() => undefined);
      job.log.warn({ exportId: p.exportId, attempt }, 'data export attempt superseded; its file was deleted');
      return { status: 'STALE' };
    }
    job.log.info({ exportId: p.exportId, kind, format, counts, bytes: sizeBytes }, 'data export finished');
    return { status: 'SUCCEEDED' };
  } catch (err) {
    if (!uploaded) await upload.abort().catch(() => undefined);
    if (err instanceof ExportTooLargeError) return fail(p, attempt, 'TOO_LARGE');
    if (job.lastAttempt || isPermanent(err)) await fail(p, attempt, 'INTERNAL').catch(() => undefined);
    throw err;
  }
}

const SWEEP_BATCH = 200;
/** An export still queued or running this long after it was asked for lost its job: failed by the sweep. */
export const DATA_EXPORT_STUCK_MS = 24 * 3_600_000;

/**
 * `compliance.sweepDataExports` (daily, every agency: `withSystem`): fails exports whose job was lost, then deletes
 * the files of exports past their expiry (finished + 7 days; failed ones at once) and marks them (`EXPIRED` for a
 * succeeded one). A file whose delete fails stays listed for the next pass.
 */
export async function sweepDataExports(opts: { now?: Date; signal?: AbortSignal } = {}): Promise<{
  failed: number;
  deleted: number;
}> {
  const now = opts.now ?? clock.now();
  const failed = await withSystem('compliance.sweepDataExports', (tx) =>
    repo.failStuck(tx, new Date(now.getTime() - DATA_EXPORT_STUCK_MS)),
  );
  let deleted = 0;
  const skip = new Set<string>();
  for (;;) {
    if (opts.signal?.aborted) break;
    const batch = (
      await withSystem('compliance.sweepDataExports', (tx) => repo.expiredFiles(tx, now, SWEEP_BATCH + skip.size))
    ).filter((r) => !skip.has(r.id));
    const done: string[] = [];
    for (const r of batch) {
      const ok = await storage()
        .delete('private', dataExportKey(r.agencyId, r.id))
        .then(() => true)
        .catch(() => false);
      if (ok) done.push(r.id);
      else skip.add(r.id);
    }
    await withSystem('compliance.sweepDataExports', (tx) => repo.markExpired(tx, done));
    deleted += done.length;
    if (batch.length < SWEEP_BATCH) break;
  }
  return { failed, deleted };
}
