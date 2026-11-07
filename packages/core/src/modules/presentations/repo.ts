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

// ── Public pages (app_public: `selection_by_token`; app_intake: interactions) ────────────────────────────────────

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
 * The live selection a token names, with its items in order (one statement). S13-F1: `app_public` reads neither table;
 * the SECURITY DEFINER `selection_by_token` answers one live (not revoked, not expired, agency not suspended) selection
 * for the token's keyed hashes, and nothing else.
 */
export async function liveSelectionByTokenHash(tx: Tx, hashes: readonly string[]): Promise<PublicSelectionRow | null> {
  // the HMAC rotation candidates: one per key (the function reads at most 8)
  if (hashes.length === 0 || hashes.length > 8) return null;
  const res = await tx.execute(sql`
    select s.id, s.agency_id as "agencyId", s.title, s.message, s.locale, s.expires_at as "expiresAt", s.items
      from public.selection_by_token(array[${sql.join(
        hashes.map((h) => sql`${h}`),
        sql`, `,
      )}]::text[]) s`);
  const row = res.rows[0] as (Omit<PublicSelectionRow, 'expiresAt'> & { expiresAt: Date | string | null }) | undefined;
  if (!row) return null;
  // `execute` returns timestamps as the driver parses them (a string for timestamptz)
  return { ...row, expiresAt: row.expiresAt === null ? null : new Date(row.expiresAt) };
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

/**
 * R2-02c: the client's latest like or unlike of this item across the contact's selections, and when (one row over
 * `selection_interactions_likes_idx`, newest first, joined to the selection for its contact); null: neither.
 */
export async function latestLikeOfContact(
  tx: Tx,
  p: { agencyId: string; contactId: string; targetId: string },
): Promise<{ liked: boolean; at: Date } | null> {
  const res = await tx.execute<{ kind: string; created_at: string | Date }>(sql`
    select i.kind, i.created_at from ${selectionInteractions} i
      join ${selections} s on s.id = i.selection_id
     where i.agency_id = ${p.agencyId} and i.target_id = ${p.targetId} and i.kind in ('LIKE', 'UNLIKE')
       and s.agency_id = ${p.agencyId} and s.contact_id = ${p.contactId}
     order by i.created_at desc, i.id desc limit 1`);
  const r = res.rows[0];
  return r ? { liked: r.kind === 'LIKE', at: new Date(r.created_at) } : null;
}

export type EndedSelection = { id: string; endedAt: string };

/**
 * S13-F9: selections that ended (revoked or expired, whichever came first) before `before`, after `after` in
 * (ended, id) order — at most `limit`, over `selections_ended_idx` (keyset, never OFFSET).
 */
export async function endedSelectionsPage(
  tx: Tx,
  before: Date,
  after: EndedSelection | null,
  limit: number,
): Promise<EndedSelection[]> {
  const ended = sql`least(${selections.revokedAt}, ${selections.expiresAt})`;
  const cursor = after
    ? sql`and (${ended}, ${selections.id}) > (${after.endedAt}::timestamptz, ${after.id}::uuid)`
    : sql``;
  const res = await tx.execute<{ id: string; ended_at: string }>(sql`
    select ${selections.id} as id, to_char(${ended} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as ended_at
      from ${selections}
     where (${selections.revokedAt} is not null or ${selections.expiresAt} is not null)
       and ${ended} < ${before.toISOString()}::timestamptz ${cursor}
     order by ${ended}, ${selections.id}
     limit ${limit}`);
  return res.rows.map((r) => ({ id: r.id, endedAt: r.ended_at }));
}

/**
 * S13-F9: deletes interactions of `selectionIds` — at most `limit`, one statement, over
 * `selection_interactions_selection_idx`. `skip locked`: a row in use is left for the next run.
 */
export async function pruneInteractionsOf(tx: Tx, selectionIds: readonly string[], limit: number): Promise<number> {
  if (selectionIds.length === 0) return 0;
  const res = await tx.execute(sql`
    delete from ${selectionInteractions} where id in (
      select id from ${selectionInteractions}
       where selection_id = any(${`{${selectionIds.join(',')}}`}::uuid[])
       limit ${limit} for update skip locked)`);
  return res.rowCount ?? 0;
}

/**
 * R2-02d: appends `targetId` to the selection while it is a draft of the contact — the agency's, for that contact,
 * live (not revoked, not expired), never viewed by the client, fewer than `max` items — at the next position, and moves
 * the selection's version on (an open editor gets VERSION_CONFLICT). `open`: it is such a draft; `present`: the target
 * was in it already; `added`: appended now. One statement.
 */
export async function appendDraftItem(
  tx: Tx,
  p: { agencyId: string; selectionId: string; contactId: string; targetId: string; itemId: string; max: number },
): Promise<{ open: boolean; present: boolean; added: boolean }> {
  const res = await tx.execute(sql`
    with s as (
      select s.id from ${selections} s
       where s.agency_id = ${p.agencyId}::uuid and s.id = ${p.selectionId}::uuid and s.contact_id = ${p.contactId}::uuid
         and s.revoked_at is null and (s.expires_at is null or s.expires_at > now())
         and not exists (select 1 from ${selectionInteractions} x where x.selection_id = s.id and x.kind = 'VIEW')
       for update),
    c as (
      select count(*)::int as n, coalesce(max(i.position), -1) as last, coalesce(bool_or(i.target_id = ${p.targetId}::uuid), false) as present
        from ${selectionItems} i where i.selection_id = ${p.selectionId}::uuid),
    ins as (
      insert into ${selectionItems} (id, agency_id, selection_id, target_id, position)
      select ${p.itemId}::uuid, ${p.agencyId}::uuid, s.id, ${p.targetId}::uuid, c.last + 1
        from s, c where not c.present and c.n < ${p.max}
      returning 1),
    bump as (
      update ${selections} set version = version + 1, updated_at = now()
       where id in (select id from s) and exists (select 1 from ins)
      returning 1)
    select (select count(*) from s)::int > 0 as open, (select present from c) as present,
           (select count(*) from ins)::int > 0 as added, (select count(*) from bump)::int as bumped`);
  const row = res.rows[0] as { open: boolean; present: boolean; added: boolean };
  return { open: row.open, present: row.present, added: row.added };
}

/**
 * R2-02e (never twice across sends): of these targets, the ones already in any selection the agency made for the
 * contact — live, expired or revoked. Over `selections_contact_idx` and `selection_items_target_uq`; one statement.
 */
export async function contactSelectionTargets(
  tx: Tx,
  agencyId: string,
  contactId: string,
  targetIds: readonly string[],
): Promise<string[]> {
  if (targetIds.length === 0) return [];
  const rows = await tx
    .selectDistinct({ targetId: selectionItems.targetId })
    .from(selections)
    .innerJoin(selectionItems, eq(selectionItems.selectionId, selections.id))
    .where(
      and(
        eq(selections.agencyId, agencyId),
        eq(selections.contactId, contactId),
        inArray(selectionItems.targetId, [...new Set(targetIds)]),
      ),
    );
  return rows.map((r) => r.targetId);
}

/**
 * R2-02e: a new link for the agency's selection (the old one stops); an expired one lives again until `expiresAt`. A
 * selection a member revoked stays revoked (false): a retried alert never re-opens it. One statement.
 */
export async function relinkSelection(
  tx: Tx,
  ref: { agencyId: string; id: string },
  link: { tokenHash: string; tokenHint: string; expiresAt: Date },
): Promise<boolean> {
  const rows = await tx
    .update(selections)
    .set({
      tokenHash: link.tokenHash,
      tokenHint: link.tokenHint,
      expiresAt: sql`greatest(coalesce(${selections.expiresAt}, ${link.expiresAt}), ${link.expiresAt})`,
      version: sql`${selections.version} + 1`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(selections.agencyId, ref.agencyId), eq(selections.id, ref.id), isNull(selections.revokedAt)))
    .returning({ id: selections.id });
  return rows.length > 0;
}

/**
 * R2-06: a window card's live pages, one selection per listing (worker, `withSystem`). Printing a listing again finds
 * its page by its derived token and gives it no expiry and puts its one item back to the listing (a page the agent revoked stays revoked). Two statements; answers the selection id per token hash.
 */
export async function upsertWindowCardSelections(
  tx: Tx,
  rows: readonly { selection: SelectionInsert; item: Omit<ItemInsert, 'selectionId'> }[],
): Promise<Map<string, string>> {
  if (rows.length === 0) return new Map();
  const saved = await tx
    .insert(selections)
    .values(rows.map((r) => r.selection))
    .onConflictDoUpdate({
      target: selections.tokenHash,
      set: {
        title: sql`excluded.title`,
        locale: sql`excluded.locale`,
        expiresAt: sql`null`,
        version: sql`${selections.version} + 1`,
        updatedAt: sql`now()`,
      },
      // another agency's row can never share a token (the agency is in the MAC); belt and braces
      setWhere: sql`${selections.agencyId} = excluded.agency_id`,
    })
    .returning({ id: selections.id, tokenHash: selections.tokenHash });
  const idByHash = new Map(saved.map((s) => [s.tokenHash, s.id]));
  const items = rows.flatMap((r) => {
    const selectionId = idByHash.get(r.selection.tokenHash);
    return selectionId ? [{ ...r.item, selectionId }] : [];
  });
  if (items.length > 0)
    await tx
      .insert(selectionItems)
      .values(items)
      .onConflictDoUpdate({
        target: [selectionItems.selectionId, selectionItems.position],
        set: { targetId: sql`excluded.target_id`, titleOverride: sql`null`, note: sql`null` },
      });
  return idByHash;
}
