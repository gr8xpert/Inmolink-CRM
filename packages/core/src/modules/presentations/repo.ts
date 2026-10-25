/**
 * presentations queries (PATTERNS §5). Takes `tx`, selects only the columns it needs, paginates by cursor.
 * Queries only `@inmolink/db/schema/presentations` — other modules' tables fail `pnpm check:boundaries`.
 */
import type { Tx } from '@inmolink/db';
import { selectionInteractions, selectionItems, selections } from '@inmolink/db/schema/presentations';
import { and, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import { type KeysetCursor, keysetAfterRaw, keysetOrderRaw, keysetStamp } from '../../pagination';

export type SelectionRow = typeof selections.$inferSelect;
export type SelectionInsert = typeof selections.$inferInsert;
export type ItemRow = typeof selectionItems.$inferSelect;
export type ItemInsert = typeof selectionItems.$inferInsert;
export type InteractionInsert = typeof selectionInteractions.$inferInsert;

const selectionColumns = {
  id: selections.id,
  agencyId: selections.agencyId,
  contactId: selections.contactId,
  title: selections.title,
  message: selections.message,
  locale: selections.locale,
  tokenHint: selections.tokenHint,
  expiresAt: selections.expiresAt,
  revokedAt: selections.revokedAt,
  version: selections.version,
  createdAt: selections.createdAt,
  updatedAt: selections.updatedAt,
};
export type SelectionView = Pick<SelectionRow, keyof typeof selectionColumns>;

export async function insertSelection(tx: Tx, row: SelectionInsert): Promise<void> {
  await tx.insert(selections).values(row);
}

export async function insertItems(tx: Tx, rows: ItemInsert[]): Promise<void> {
  if (rows.length > 0) await tx.insert(selectionItems).values(rows);
}

/** The new order of a selection's items (one delete, one insert). */
export async function replaceItems(tx: Tx, selectionId: string, rows: ItemInsert[]): Promise<void> {
  await tx.delete(selectionItems).where(eq(selectionItems.selectionId, selectionId));
  await insertItems(tx, rows);
}

export async function getSelection(tx: Tx, agencyId: string, id: string): Promise<SelectionView | null> {
  const [row] = await tx
    .select(selectionColumns)
    .from(selections)
    .where(and(eq(selections.agencyId, agencyId), eq(selections.id, id)));
  return row ?? null;
}

/** Bumps the version when it matches (optimistic concurrency): null when another edit won. */
export async function updateSelection(
  tx: Tx,
  ref: { agencyId: string; id: string; version: number },
  patch: Partial<
    Pick<SelectionRow, 'title' | 'message' | 'locale' | 'expiresAt' | 'revokedAt' | 'tokenHash' | 'tokenHint'>
  >,
): Promise<SelectionView | null> {
  const [row] = await tx
    .update(selections)
    .set({ ...patch, version: sql`${selections.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(selections.agencyId, ref.agencyId), eq(selections.id, ref.id), eq(selections.version, ref.version)))
    .returning(selectionColumns);
  return row ?? null;
}

export interface ItemWithStats {
  targetId: string;
  position: number;
  titleOverride: string | null;
  note: string | null;
  likes: number;
  enquiries: number;
}

/**
 * A selection's items in order with what the client did with each: liked now (their last like or unlike was a like)
 * and enquiries. One statement.
 */
export async function itemsWithStats(tx: Tx, selectionId: string): Promise<ItemWithStats[]> {
  const res = await tx.execute(sql`
    select i.target_id as "targetId", i.position, i.title_override as "titleOverride", i.note,
           coalesce(s.likes, 0)::int as likes, coalesce(s.enquiries, 0)::int as enquiries
      from ${selectionItems} i
      left join lateral (
        select (count(*) filter (where x.kind = 'ENQUIRE'))::int as enquiries,
               (case when (array_agg(x.kind order by x.created_at desc, x.id desc)
                           filter (where x.kind in ('LIKE', 'UNLIKE')))[1] = 'LIKE' then 1 else 0 end) as likes
          from ${selectionInteractions} x
         where x.selection_id = i.selection_id and x.target_id = i.target_id) s on true
     where i.selection_id = ${selectionId}
     order by i.position`);
  return res.rows as unknown as ItemWithStats[];
}

/** Views of these selections: how many, and the last (one statement). */
export async function viewStats(
  tx: Tx,
  selectionIds: readonly string[],
): Promise<Map<string, { views: number; lastViewedAt: Date | null; itemCount: number }>> {
  if (selectionIds.length === 0) return new Map();
  const res = await tx.execute(sql`
    select s.id, coalesce(v.views, 0)::int as views, v.last as "lastViewedAt",
           (select count(*)::int from ${selectionItems} i where i.selection_id = s.id) as "itemCount"
      from ${selections} s
      left join lateral (
        select count(*)::int as views, max(x.created_at) as last
          from ${selectionInteractions} x where x.selection_id = s.id and x.kind = 'VIEW') v on true
     where s.id in (${sql.join(
       selectionIds.map((id) => sql`${id}::uuid`),
       sql`, `,
     )})`);
  const rows = res.rows as { id: string; views: number; lastViewedAt: string | Date | null; itemCount: number }[];
  return new Map(
    rows.map((r) => [
      r.id,
      { views: r.views, lastViewedAt: r.lastViewedAt ? new Date(r.lastViewedAt) : null, itemCount: r.itemCount },
    ]),
  );
}

/** The agency's selections (one contact's, or all), newest first, keyset on the raw creation time. */
export async function listSelections(
  tx: Tx,
  agencyId: string,
  filter: { contactId?: string },
  cursor: KeysetCursor | undefined,
  limit: number,
): Promise<(SelectionView & { atUs: string })[]> {
  const where: (SQL | undefined)[] = [
    eq(selections.agencyId, agencyId),
    filter.contactId ? eq(selections.contactId, filter.contactId) : undefined,
    keysetAfterRaw(selections.createdAt, selections.id, cursor, 'desc'),
  ];
  return tx
    .select({ ...selectionColumns, atUs: keysetStamp(selections.createdAt) })
    .from(selections)
    .where(and(...where))
    .orderBy(...keysetOrderRaw(selections.createdAt, selections.id, 'desc'))
    .limit(limit + 1);
}

/** A selection's interactions, newest first, keyset. */
export async function listInteractions(tx: Tx, selectionId: string, cursor: KeysetCursor | undefined, limit: number) {
  return tx
    .select({
      id: selectionInteractions.id,
      kind: selectionInteractions.kind,
      targetId: selectionInteractions.targetId,
      message: selectionInteractions.message,
      createdAt: selectionInteractions.createdAt,
      atUs: keysetStamp(selectionInteractions.createdAt),
    })
    .from(selectionInteractions)
    .where(
      and(
        eq(selectionInteractions.selectionId, selectionId),
        keysetAfterRaw(selectionInteractions.createdAt, selectionInteractions.id, cursor, 'desc'),
      ),
    )
    .orderBy(...keysetOrderRaw(selectionInteractions.createdAt, selectionInteractions.id, 'desc'))
    .limit(limit + 1);
}

// ── Public pages (app_public: the registry's live predicate; app_intake: interactions) ─────────────────────────────

export interface PublicSelectionRow {
  id: string;
  agencyId: string;
  title: string;
  message: string | null;
  locale: string;
  expiresAt: Date | null;
  items: { targetId: string; position: number; titleOverride: string | null; note: string | null }[];
}

/**
 * The live selection a token names, with its items in order (one statement). `app_public` sees only live rows (not
 * revoked, not expired): the policy says so, and the query too.
 */
export async function liveSelectionByTokenHash(tx: Tx, hashes: readonly string[]): Promise<PublicSelectionRow | null> {
  if (hashes.length === 0) return null;
  const [row] = await tx
    .select({
      id: selections.id,
      agencyId: selections.agencyId,
      title: selections.title,
      message: selections.message,
      locale: selections.locale,
      expiresAt: selections.expiresAt,
      items: sql<PublicSelectionRow['items']>`coalesce((
        select json_agg(json_build_object('targetId', i.target_id, 'position', i.position,
                                          'titleOverride', i.title_override, 'note', i.note) order by i.position)
          from ${selectionItems} i where i.selection_id = selections.id), '[]'::json)`,
    })
    .from(selections)
    .where(
      and(
        inArray(selections.tokenHash, [...hashes]),
        isNull(selections.revokedAt),
        sql`(${selections.expiresAt} is null or ${selections.expiresAt} > now())`,
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function insertInteraction(tx: Tx, row: InteractionInsert): Promise<void> {
  await tx.insert(selectionInteractions).values(row);
}

// ── Worker (app_system) ───────────────────────────────────────────────────────────────────────────────────────

/** Who a selection is for (the CRM timeline's subject). */
export async function selectionContact(
  tx: Tx,
  selectionId: string,
): Promise<{ agencyId: string; contactId: string | null } | null> {
  const [row] = await tx
    .select({ agencyId: selections.agencyId, contactId: selections.contactId })
    .from(selections)
    .where(eq(selections.id, selectionId));
  return row ?? null;
}
