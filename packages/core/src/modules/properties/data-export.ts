/**
 * The listing side of the data export (S10-08, PATTERNS §12 "Cross-module functions for workers"): raw `tx` — the
 * compliance worker reads as `app_system` (`withSystem`), `agency_id` an explicit predicate — no authorization
 * (compliance authorizes the export), never called from request code. The agency's own listings that are not deleted,
 * newest first in keyset pages on `properties_agency_created_idx` (`date_trunc('milliseconds', created_at, 'UTC')`,
 * id): one statement per page. Not under RLS on purpose: `date_trunc` is not leakproof, so under RLS the cursor's row
 * comparison is only a filter (each page would read and sort all of the agency's listings); without RLS it is an index
 * condition.
 * Everything the agency entered, commission terms included — the export is the agency's own data, for its admins.
 */
import type { Tx } from '@inmolink/db';
import { properties } from '@inmolink/db/schema/properties';
import { and, desc, eq, isNull, type SQL, sql } from 'drizzle-orm';
import type { KeysetCursor } from '../../pagination';

/** Most rows one page may ask for. */
export const LISTING_EXPORT_PAGE_MAX = 2_000;

const keyTime = sql`date_trunc('milliseconds', ${properties.createdAt}, 'UTC')`;

export async function listingsForExport(tx: Tx, agencyId: string, q: { after: KeysetCursor | null; limit: number }) {
  const where: (SQL | undefined)[] = [eq(properties.agencyId, agencyId), isNull(properties.deletedAt)];
  if (q.after)
    where.push(sql`(${keyTime}, ${properties.id}) < (${q.after.at.toISOString()}::timestamptz, ${q.after.id}::uuid)`);
  return tx
    .select({
      id: properties.id,
      /** The keyset key (the creation time to the millisecond). */
      keyAt: sql<Date>`${keyTime}`.mapWith((v: string | Date) => new Date(v)),
      ref: properties.ref,
      source: properties.source,
      status: properties.status,
      visibility: properties.visibility,
      shareScope: properties.shareScope,
      transactionType: properties.transactionType,
      priceCents: properties.priceCents,
      priceToCents: properties.priceToCents,
      currency: properties.currency,
      pricePeriod: properties.pricePeriod,
      priceOnRequest: properties.priceOnRequest,
      communityFeeMonthCents: properties.communityFeeMonthCents,
      ibiYearCents: properties.ibiYearCents,
      garbageTaxYearCents: properties.garbageTaxYearCents,
      commissionBp: properties.commissionBp,
      commissionFixedCents: properties.commissionFixedCents,
      splitBp: properties.splitBp,
      commissionIncludesVat: properties.commissionIncludesVat,
      builtM2: properties.builtM2,
      plotM2: properties.plotM2,
      terraceM2: properties.terraceM2,
      bedrooms: properties.bedrooms,
      bathrooms: properties.bathrooms,
      yearBuilt: properties.yearBuilt,
      energyRating: properties.energyRating,
      energyEmissionsRating: properties.energyEmissionsRating,
      lat: properties.lat,
      lng: properties.lng,
      locationPrecision: properties.locationPrecision,
      propertyTypeId: properties.propertyTypeId,
      locationId: properties.locationId,
      developmentId: properties.developmentId,
      ownerUserId: properties.ownerUserId,
      lastConfirmedAt: properties.lastConfirmedAt,
      createdAt: properties.createdAt,
      updatedAt: properties.updatedAt,
    })
    .from(properties)
    .where(and(...where))
    .orderBy(desc(keyTime), desc(properties.id))
    .limit(Math.max(1, Math.min(q.limit, LISTING_EXPORT_PAGE_MAX)));
}

export type ExportListingRow = Awaited<ReturnType<typeof listingsForExport>>[number];
