/**
 * Price list versions (S4-02, PLAN §6 M3): a new version (typed, uploaded or read by AI) is stored with its diff
 * against the units as they are — references added and removed, prices and statuses changed. Nothing changes
 * until a person approves it: the diff is then recomputed and applied (price and status history name the
 * version), and the development is marked verified. Only the latest version can be approved.
 */
import {
  type CreatePriceListBody,
  type PageQuery,
  type PriceListDiff,
  type PriceListDto,
  PriceListEntry,
  type PriceListPage,
  type PriceListSummaryDto,
  type UnitStatus,
} from '@inmolink/contracts';
import { clock } from '@inmolink/platform/clock';
import { AppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { emit } from '@inmolink/platform/outbox';
import { z } from 'zod';
import { type Ctx, memberUserId } from '../../context';
import * as compliance from '../compliance';
import { developmentsEvents } from './events';
import * as repo from './repo';
import { ownForChange, ownForRead, withDbErrors } from './service';

/**
 * At most this many unit changes, and this many bytes of them, are spelled out in an approval's audit entry (the
 * metadata cap is 4 KB; a ref of 40 non-Latin characters alone is 120 bytes).
 */
const PRICE_LIST_AUDIT_CHANGES = 20;
const PRICE_LIST_AUDIT_BYTES = 2048;

/** `ref price from→to status from→to` for the first changes that fit; all of them are in the history rows. */
function auditChanges(changed: PriceListDiff['changed']): string[] {
  const out: string[] = [];
  let bytes = 0;
  for (const c of changed.slice(0, PRICE_LIST_AUDIT_CHANGES)) {
    const line = [
      c.ref,
      c.priceCents ? `price ${c.priceCents.from ?? 'none'}→${c.priceCents.to ?? 'none'}` : null,
      c.status ? `status ${c.status.from}→${c.status.to}` : null,
    ]
      .filter(Boolean)
      .join(' ');
    bytes += Buffer.byteLength(line) + 3; // quotes and comma in the JSON
    if (bytes > PRICE_LIST_AUDIT_BYTES) break;
    out.push(line);
  }
  return out;
}

type UnitPrice = { id: string; ref: string; priceCents: number | null; status: UnitStatus };

/**
 * The price list against the units: `added` references the list has and the development does not, `removed`
 * units the list leaves out, `changed` units whose price (or, when the line names one, status) differs.
 */
export function diffPriceList(entries: readonly PriceListEntry[], units: readonly UnitPrice[]): PriceListDiff {
  const byRef = new Map(units.map((u) => [u.ref, u]));
  const listed = new Set(entries.map((e) => e.ref));
  const diff: PriceListDiff = { added: [], removed: [], changed: [], unchanged: 0 };
  for (const e of entries) {
    const u = byRef.get(e.ref);
    if (!u) {
      diff.added.push({ ref: e.ref, priceCents: e.priceCents });
      continue;
    }
    const price = u.priceCents !== e.priceCents ? { from: u.priceCents, to: e.priceCents } : null;
    const status = e.status !== undefined && e.status !== u.status ? { from: u.status, to: e.status } : null;
    if (price || status) diff.changed.push({ unitId: u.id, ref: u.ref, priceCents: price, status });
    else diff.unchanged += 1;
  }
  for (const u of units) {
    if (!listed.has(u.ref)) diff.removed.push({ unitId: u.id, ref: u.ref, priceCents: u.priceCents });
  }
  return diff;
}

type PriceListFields = Omit<repo.PriceListRow, 'diffSummary'>;

function priceListFields(row: PriceListFields): Omit<PriceListDto, 'diff'> {
  return {
    id: row.id,
    developmentId: row.developmentId,
    version: row.version,
    effectiveFrom: row.effectiveFrom,
    sourceDocumentId: row.sourceDocumentId,
    extractedBy: row.extractedBy,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    reviewedByUserId: row.reviewedByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

function toPriceListDto(row: repo.PriceListRow): PriceListDto {
  return { ...priceListFields(row), diff: row.diffSummary as PriceListDiff };
}

/** A list carries the diff's counts only (S4-F5): a full repricing diff is thousands of lines. */
function toPriceListSummary(row: repo.PriceListSummaryRow): PriceListSummaryDto {
  return { ...priceListFields(row), counts: row.counts };
}

/** `POST /v1/developments/:id/price-lists`: the next version, with its diff against the current units. */
export async function createPriceList(
  ctx: Ctx,
  developmentId: string,
  input: CreatePriceListBody,
): Promise<PriceListDto> {
  // The development's row lock serializes version numbers.
  const dev = await ownForChange(ctx, developmentId, 'development.update');
  // S4-F4: the source is one of this development's documents (the FK alone only checks the agency).
  if (input.sourceDocumentId && !(await repo.getDocument(ctx.tx, developmentId, input.sourceDocumentId))) {
    throw new AppError('VALIDATION_FAILED', { field: 'sourceDocumentId', reason: 'unknown' });
  }
  const version = (await repo.latestPriceListVersion(ctx.tx, developmentId)) + 1;
  const diff = diffPriceList(input.entries, await repo.unitPrices(ctx.tx, developmentId));
  const row = await withDbErrors(() =>
    repo.insertPriceList(ctx.tx, {
      id: newId(),
      developmentId,
      agencyId: dev.agencyId,
      version,
      effectiveFrom: input.effectiveFrom,
      sourceDocumentId: input.sourceDocumentId ?? null,
      extractedBy: input.extractedBy ?? 'HUMAN',
      entries: input.entries,
      diffSummary: diff,
      createdByUserId: memberUserId(ctx),
    }),
  );
  await emit(
    ctx.tx,
    developmentsEvents.priceListCreated({ priceListId: row.id, developmentId, agencyId: dev.agencyId, version }),
  );
  return toPriceListDto(row);
}

/**
 * `POST /v1/developments/:id/price-lists/:version/approve`: applies the latest version's prices (and statuses)
 * to the units it names. Added and removed references are left to the person (create or delete those units).
 *
 * S5-F3: a repricing touches up to 2,000 units. Their history rows name the version; no per-unit events — the one
 * `developments.priceList.approved` tells consumers (read models) to reload the development's units. Ten statements
 * whatever the size; the unit update and the history inserts bind one array per column (`unnest`).
 */
export async function approvePriceList(ctx: Ctx, developmentId: string, version: number): Promise<PriceListDto> {
  const dev = await ownForChange(ctx, developmentId, 'priceList.approve');
  const list = await repo.getPriceListToApprove(ctx.tx, developmentId, version);
  if (!list) throw new AppError('PRICE_LIST_NOT_FOUND');
  if (list.reviewedAt) throw new AppError('PRICE_LIST_REVIEWED');
  if (list.latestVersion !== version) throw new AppError('PRICE_LIST_SUPERSEDED');
  const entries = z.array(PriceListEntry).parse(list.entries);
  const units = await repo.unitPricesForUpdate(ctx.tx, developmentId);
  const diff = diffPriceList(entries, units);
  const byId = new Map(units.map((u) => [u.id, u]));
  await repo.setUnitPrices(
    ctx.tx,
    developmentId,
    diff.changed.map((c) => {
      const u = byId.get(c.unitId) as repo.UnitPriceRow;
      return { id: u.id, priceCents: c.priceCents ? c.priceCents.to : u.priceCents, status: c.status?.to ?? u.status };
    }),
  );
  const userId = memberUserId(ctx);
  await repo.insertPriceListHistories(ctx.tx, {
    agencyId: dev.agencyId,
    priceListId: list.id,
    changedByUserId: userId,
    prices: diff.changed.flatMap((c) =>
      c.priceCents
        ? [
            {
              id: newId(),
              unitId: c.unitId,
              from: c.priceCents.from,
              to: c.priceCents.to,
              currency: (byId.get(c.unitId) as repo.UnitPriceRow).currency,
            },
          ]
        : [],
    ),
    statuses: diff.changed.flatMap((c) =>
      c.status ? [{ id: newId(), unitId: c.unitId, from: c.status.from, to: c.status.to }] : [],
    ),
  });
  const reviewed = await repo.markPriceListReviewed(ctx.tx, list.id, {
    reviewedByUserId: userId,
    diffSummary: diff,
  });
  // Publishing new prices to every agency that sees the development: who, which version, how much changed (S5-F1).
  // Per-unit before and after values are the price and status history rows of this price list.
  const changes = auditChanges(diff.changed);
  await compliance.audit(
    ctx,
    'developments.priceList.approved',
    { type: 'priceList', id: list.id },
    {
      developmentId,
      version,
      unitsChanged: diff.changed.length,
      pricesChanged: diff.changed.filter((c) => c.priceCents).length,
      statusesChanged: diff.changed.filter((c) => c.status).length,
      lastVerifiedBefore: dev.lastVerifiedAt?.toISOString() ?? null,
      changes,
      truncated: changes.length < diff.changed.length,
    },
  );
  // Units and prices were just confirmed (freshness SLA, PLAN §3 #21).
  const touched = await repo.updateDevelopment(ctx.tx, developmentId, dev.version, { lastVerifiedAt: clock.now() });
  if (!touched) throw new AppError('VERSION_CONFLICT'); // unreachable: the development is row-locked
  await emit(ctx.tx, [
    developmentsEvents.updated({
      developmentId,
      agencyId: dev.agencyId,
      version: touched.version,
      changed: ['lastVerifiedAt'],
    }),
    developmentsEvents.priceListApproved({ priceListId: list.id, developmentId, agencyId: dev.agencyId, version }),
  ]);
  return toPriceListDto(reviewed);
}

/** `GET /v1/developments/:id/price-lists/:version`: the owner's view of one version and its diff. */
export async function getPriceList(ctx: Ctx, developmentId: string, version: number): Promise<PriceListDto> {
  await ownForRead(ctx, developmentId, 'priceList.read');
  const row = await repo.getPriceList(ctx.tx, developmentId, version);
  if (!row) throw new AppError('PRICE_LIST_NOT_FOUND');
  return toPriceListDto(row);
}

function decodeVersionCursor(cursor: string | undefined): number | undefined {
  if (cursor === undefined) return undefined;
  const v = Number(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (!Number.isInteger(v) || v < 1) throw new AppError('VALIDATION_FAILED', { field: 'cursor' });
  return v;
}

/** `GET /v1/developments/:id/price-lists`: the owner's versions, latest first. */
export async function listPriceLists(ctx: Ctx, developmentId: string, q: PageQuery): Promise<PriceListPage> {
  await ownForRead(ctx, developmentId, 'priceList.read');
  const beforeVersion = decodeVersionCursor(q.cursor);
  const page = await repo.listPriceLists(ctx.tx, developmentId, {
    limit: q.limit,
    ...(beforeVersion !== undefined ? { beforeVersion } : {}),
  });
  const last = page.items.at(-1);
  return {
    items: page.items.map(toPriceListSummary),
    nextCursor: page.hasMore && last ? Buffer.from(String(last.version)).toString('base64url') : null,
  };
}
