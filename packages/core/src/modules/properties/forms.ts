/**
 * What the forms library (documents, R2-05a) merges from the agency's own listings: reference, transaction, price,
 * commission and cadastral reference — read as stored, never generated. One statement for any number of listings.
 */
import { properties, propertyPrivates } from '@inmolink/db/schema/properties';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Ctx } from '../../context';
import { assertCan } from './policy';

export interface FormListing {
  id: string;
  ref: string;
  transactionType: 'SALE' | 'RENT_LONG_TERM' | 'RENT_SHORT_TERM';
  /** Null when the listing has no price (or it is on request). */
  price: { amountCents: number; currency: string } | null;
  /** The listing's currency (also without a price: a fixed commission is in it). */
  currency: string;
  commissionBp: number | null;
  commissionFixedCents: number | null;
  commissionIncludesVat: boolean;
  cadastralRef: string | null;
}

/** The caller's own live (not deleted) listings among `ids`, in no order; another agency's or a deleted one is left out. */
export async function formListings(ctx: Ctx, ids: readonly string[]): Promise<FormListing[]> {
  assertCan(ctx, 'listing.read');
  if (ids.length === 0) return [];
  const rows = await ctx.tx
    .select({
      id: properties.id,
      ref: properties.ref,
      transactionType: properties.transactionType,
      priceCents: properties.priceCents,
      priceOnRequest: properties.priceOnRequest,
      currency: properties.currency,
      commissionBp: properties.commissionBp,
      commissionFixedCents: properties.commissionFixedCents,
      commissionIncludesVat: properties.commissionIncludesVat,
      cadastralRef: propertyPrivates.cadastralRef,
    })
    .from(properties)
    .leftJoin(propertyPrivates, eq(propertyPrivates.propertyId, properties.id))
    .where(
      and(
        eq(properties.agencyId, ctx.tenant.agencyId),
        inArray(properties.id, [...new Set(ids)]),
        isNull(properties.deletedAt),
      ),
    );
  return rows.map((r) => ({
    id: r.id,
    ref: r.ref,
    transactionType: r.transactionType,
    price: r.priceCents !== null && !r.priceOnRequest ? { amountCents: r.priceCents, currency: r.currency } : null,
    currency: r.currency,
    commissionBp: r.commissionBp,
    commissionFixedCents: r.commissionFixedCents,
    commissionIncludesVat: r.commissionIncludesVat,
    cadastralRef: r.cadastralRef ?? null,
  }));
}
