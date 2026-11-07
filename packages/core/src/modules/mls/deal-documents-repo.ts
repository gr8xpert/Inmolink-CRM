/**
 * mls deal-room document queries (R2-04b, PATTERNS §5). Takes `tx`, selects only the columns it needs. A party reads and
 * writes its own copy (`agency_id` = the caller's agency); `deal_documents_mirror` appends the peer's copy and copies a
 * removal to it in the same statement. The worker side (object deletes, the orphan sweep) runs as app_system.
 */
import type { Tx } from '@inmolink/db';
import { dealDocuments } from '@inmolink/db/schema/mls';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';

const columns = {
  id: dealDocuments.id,
  dealId: dealDocuments.dealId,
  agencyId: dealDocuments.agencyId,
  uploaderAgencyId: dealDocuments.uploaderAgencyId,
  uploaderName: dealDocuments.uploaderName,
  kind: dealDocuments.kind,
  fileName: dealDocuments.fileName,
  sizeBytes: dealDocuments.sizeBytes,
  sha256: dealDocuments.sha256,
  storageKey: dealDocuments.storageKey,
  createdAt: dealDocuments.createdAt,
  removedAt: dealDocuments.removedAt,
};

export interface DealDocumentRow {
  id: string;
  dealId: string;
  agencyId: string;
  uploaderAgencyId: string;
  uploaderName: string;
  kind: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  storageKey: string;
  createdAt: Date;
  removedAt: Date | null;
}

/** The deal's documents on the agency's copy, oldest first (`deal_documents_deal_idx`; ≤ `DEAL_DOCUMENTS_MAX` rows). */
export async function documentsOf(tx: Tx, agencyId: string, dealId: string, max: number): Promise<DealDocumentRow[]> {
  return tx
    .select(columns)
    .from(dealDocuments)
    .where(and(eq(dealDocuments.agencyId, agencyId), eq(dealDocuments.dealId, dealId)))
    .orderBy(asc(dealDocuments.createdAt), asc(dealDocuments.id))
    .limit(max);
}

/** One document of the deal on the agency's copy (the primary key). */
export async function documentOf(
  tx: Tx,
  agencyId: string,
  dealId: string,
  id: string,
): Promise<DealDocumentRow | null> {
  const [row] = await tx
    .select(columns)
    .from(dealDocuments)
    .where(and(eq(dealDocuments.agencyId, agencyId), eq(dealDocuments.id, id), eq(dealDocuments.dealId, dealId)));
  return row ?? null;
}

export interface NewDealDocument {
  agencyId: string;
  id: string;
  dealId: string;
  uploadedByUserId: string;
  uploaderName: string;
  kind: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  storageKey: string;
}

/** The uploader's copy (the guard checks the deal, the member and the key; the mirror appends the peer's copy). */
export async function insertDocument(tx: Tx, d: NewDealDocument): Promise<DealDocumentRow> {
  const [row] = await tx
    .insert(dealDocuments)
    .values({ ...d, uploaderAgencyId: d.agencyId })
    .returning(columns);
  if (!row) throw new Error('mls: deal document insert returned no row');
  return row;
}

/** Removes the agency's own upload (the guard stamps the time; the mirror copies it). Null: none, or removed already. */
export async function removeDocument(
  tx: Tx,
  agencyId: string,
  dealId: string,
  id: string,
  userId: string,
): Promise<DealDocumentRow | null> {
  const [row] = await tx
    .update(dealDocuments)
    .set({ removedAt: sql`now()`, removedByUserId: userId, updatedAt: sql`now()` })
    .where(
      and(
        eq(dealDocuments.agencyId, agencyId),
        eq(dealDocuments.id, id),
        eq(dealDocuments.dealId, dealId),
        eq(dealDocuments.uploaderAgencyId, agencyId),
        isNull(dealDocuments.removedAt),
      ),
    )
    .returning(columns);
  return row ?? null;
}

/** Worker (app_system): which of these object keys a live (not removed) document row still names, on any copy. */
export async function liveDocumentKeys(tx: Tx, keys: readonly string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const rows = await tx
    .selectDistinct({ key: dealDocuments.storageKey })
    .from(dealDocuments)
    .where(and(inArray(dealDocuments.storageKey, [...keys]), isNull(dealDocuments.removedAt)));
  return new Set(rows.map((r) => r.key));
}
