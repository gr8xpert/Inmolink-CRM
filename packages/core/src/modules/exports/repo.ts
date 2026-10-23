/**
 * exports queries (PATTERNS §5). `app_user` under `withTenant` (dashboard) or `app_system` (workers). Queries only
 * `@inmolink/db/schema/exports`. Every connection query names the agency (RLS would hide other agencies' rows
 * anyway).
 */
import type { Tx } from '@inmolink/db';
import { agencyPortalConnections, portalChannels, portalConnectionProperties } from '@inmolink/db/schema/exports';
import { and, asc, count, eq, gt, inArray, ne, sql } from 'drizzle-orm';
import { type KeysetCursor, keysetAfter, keysetOrder } from '../../pagination';

export type ChannelStatus = (typeof portalChannels.$inferSelect)['status'];
export type SelectionMode = (typeof agencyPortalConnections.$inferSelect)['selectionMode'];
export type OverrideAction = (typeof portalConnectionProperties.$inferSelect)['action'];

export interface ChannelRow {
  code: string;
  name: string;
  status: ChannelStatus;
  credentialFields: string[];
}

const channelColumns = {
  code: portalChannels.code,
  name: portalChannels.name,
  status: portalChannels.status,
  credentialFields: portalChannels.credentialFields,
};

/** The whole catalog (a handful of rows), in display order. */
export async function listChannels(tx: Tx): Promise<ChannelRow[]> {
  return tx.select(channelColumns).from(portalChannels).orderBy(asc(portalChannels.position), asc(portalChannels.code));
}

export async function getChannel(tx: Tx, code: string): Promise<ChannelRow | null> {
  const [row] = await tx.select(channelColumns).from(portalChannels).where(eq(portalChannels.code, code)).limit(1);
  return row ?? null;
}

/** Catalog upsert (`withSystem`): the sync script and tests. */
export async function upsertChannels(tx: Tx, rows: readonly (ChannelRow & { position: number })[]): Promise<void> {
  if (rows.length === 0) return;
  await tx
    .insert(portalChannels)
    .values(rows.map((r) => ({ ...r, credentialFields: [...r.credentialFields] })))
    .onConflictDoUpdate({
      target: portalChannels.code,
      set: {
        name: sql`excluded.name`,
        status: sql`excluded.status`,
        credentialFields: sql`excluded.credential_fields`,
        position: sql`excluded.position`,
      },
    });
}

export interface ConnectionRow {
  id: string;
  agencyId: string;
  channelCode: string;
  name: string;
  enabled: boolean;
  selectionMode: SelectionMode;
  selectionTag: string | null;
  credentialsEnc: string | null;
  credentialKeys: string[];
  tokenHint: string;
  tokenCreatedAt: Date;
  revokedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

const connectionColumns = {
  id: agencyPortalConnections.id,
  agencyId: agencyPortalConnections.agencyId,
  channelCode: agencyPortalConnections.channelCode,
  name: agencyPortalConnections.name,
  enabled: agencyPortalConnections.enabled,
  selectionMode: agencyPortalConnections.selectionMode,
  selectionTag: agencyPortalConnections.selectionTag,
  credentialsEnc: agencyPortalConnections.credentialsEnc,
  credentialKeys: agencyPortalConnections.credentialKeys,
  tokenHint: agencyPortalConnections.tokenHint,
  tokenCreatedAt: agencyPortalConnections.tokenCreatedAt,
  revokedAt: agencyPortalConnections.revokedAt,
  version: agencyPortalConnections.version,
  createdAt: agencyPortalConnections.createdAt,
  updatedAt: agencyPortalConnections.updatedAt,
};

export interface NewConnection {
  id: string;
  agencyId: string;
  channelCode: string;
  name: string;
  selectionMode: SelectionMode;
  selectionTag: string | null;
  credentialsEnc: string | null;
  credentialKeys: string[];
  tokenHash: string;
  tokenHint: string;
  createdBy: string;
  now: Date;
}

export async function insertConnection(tx: Tx, c: NewConnection): Promise<ConnectionRow> {
  const [row] = await tx
    .insert(agencyPortalConnections)
    .values({
      id: c.id,
      agencyId: c.agencyId,
      channelCode: c.channelCode,
      name: c.name,
      selectionMode: c.selectionMode,
      selectionTag: c.selectionTag,
      credentialsEnc: c.credentialsEnc,
      credentialKeys: c.credentialKeys,
      tokenHash: c.tokenHash,
      tokenHint: c.tokenHint,
      tokenCreatedAt: c.now,
      createdBy: c.createdBy,
      createdAt: c.now,
      updatedAt: c.now,
    })
    .returning(connectionColumns);
  if (!row) throw new Error('insertConnection: no row returned');
  return row;
}

export async function countConnections(tx: Tx, agencyId: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(agencyPortalConnections)
    .where(eq(agencyPortalConnections.agencyId, agencyId));
  return row?.n ?? 0;
}

/** Another connection of the agency to the portal with this name (case-insensitive)? */
export async function nameTaken(
  tx: Tx,
  agencyId: string,
  channelCode: string,
  name: string,
  exceptId?: string,
): Promise<boolean> {
  const rows = await tx
    .select({ id: agencyPortalConnections.id })
    .from(agencyPortalConnections)
    .where(
      and(
        eq(agencyPortalConnections.agencyId, agencyId),
        eq(agencyPortalConnections.channelCode, channelCode),
        sql`lower(${agencyPortalConnections.name}) = lower(${name})`,
        exceptId ? ne(agencyPortalConnections.id, exceptId) : undefined,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** The agency's connections, oldest first (keyset on `(created_at, id)`). */
export async function listConnections(
  tx: Tx,
  agencyId: string,
  q: { limit: number; cursor?: KeysetCursor },
): Promise<ConnectionRow[]> {
  return tx
    .select(connectionColumns)
    .from(agencyPortalConnections)
    .where(
      and(
        eq(agencyPortalConnections.agencyId, agencyId),
        keysetAfter(agencyPortalConnections.createdAt, agencyPortalConnections.id, q.cursor, 'asc'),
      ),
    )
    .orderBy(...keysetOrder(agencyPortalConnections.createdAt, agencyPortalConnections.id, 'asc'))
    .limit(q.limit + 1);
}

/** One connection of the agency; `forUpdate` locks it (edits, token changes, per-property choices). */
export async function getConnection(
  tx: Tx,
  agencyId: string,
  id: string,
  forUpdate = false,
): Promise<ConnectionRow | null> {
  const query = tx
    .select(connectionColumns)
    .from(agencyPortalConnections)
    .where(and(eq(agencyPortalConnections.agencyId, agencyId), eq(agencyPortalConnections.id, id)));
  const [row] = await (forUpdate ? query.for('update') : query);
  return row ?? null;
}

export interface ConnectionFields {
  name: string;
  enabled: boolean;
  selectionMode: SelectionMode;
  selectionTag: string | null;
  credentialsEnc: string | null;
  credentialKeys: string[];
}

/** Writes a locked connection's new setup and bumps its version. */
export async function updateConnection(
  tx: Tx,
  agencyId: string,
  id: string,
  fields: ConnectionFields,
  now: Date,
): Promise<ConnectionRow> {
  const [row] = await tx
    .update(agencyPortalConnections)
    .set({ ...fields, version: sql`${agencyPortalConnections.version} + 1`, updatedAt: now })
    .where(and(eq(agencyPortalConnections.agencyId, agencyId), eq(agencyPortalConnections.id, id)))
    .returning(connectionColumns);
  if (!row) throw new Error('updateConnection: no row returned');
  return row;
}

/** Bumps a locked connection's version (its per-property choices changed). */
export async function touchConnection(tx: Tx, agencyId: string, id: string, now: Date): Promise<ConnectionRow> {
  const [row] = await tx
    .update(agencyPortalConnections)
    .set({ version: sql`${agencyPortalConnections.version} + 1`, updatedAt: now })
    .where(and(eq(agencyPortalConnections.agencyId, agencyId), eq(agencyPortalConnections.id, id)))
    .returning(connectionColumns);
  if (!row) throw new Error('touchConnection: no row returned');
  return row;
}

/** A new token (rotation; also revives a revoked connection's token). */
export async function setToken(
  tx: Tx,
  agencyId: string,
  id: string,
  t: { tokenHash: string; tokenHint: string; now: Date },
): Promise<ConnectionRow> {
  const [row] = await tx
    .update(agencyPortalConnections)
    .set({
      tokenHash: t.tokenHash,
      tokenHint: t.tokenHint,
      tokenCreatedAt: t.now,
      revokedAt: null,
      version: sql`${agencyPortalConnections.version} + 1`,
      updatedAt: t.now,
    })
    .where(and(eq(agencyPortalConnections.agencyId, agencyId), eq(agencyPortalConnections.id, id)))
    .returning(connectionColumns);
  if (!row) throw new Error('setToken: no row returned');
  return row;
}

export async function revokeToken(tx: Tx, agencyId: string, id: string, now: Date): Promise<ConnectionRow> {
  const [row] = await tx
    .update(agencyPortalConnections)
    .set({ revokedAt: now, version: sql`${agencyPortalConnections.version} + 1`, updatedAt: now })
    .where(and(eq(agencyPortalConnections.agencyId, agencyId), eq(agencyPortalConnections.id, id)))
    .returning(connectionColumns);
  if (!row) throw new Error('revokeToken: no row returned');
  return row;
}

/** Deletes a connection (its per-property choices cascade). */
export async function deleteConnection(tx: Tx, agencyId: string, id: string): Promise<void> {
  await tx
    .delete(agencyPortalConnections)
    .where(and(eq(agencyPortalConnections.agencyId, agencyId), eq(agencyPortalConnections.id, id)));
}

// ── Per-property choices ───────────────────────────────────────────────────────────────────────────────────────

/** INCLUDE / EXCLUDE counts of these connections: one grouped statement. */
export async function overrideCounts(
  tx: Tx,
  agencyId: string,
  connectionIds: readonly string[],
): Promise<Map<string, { include: number; exclude: number }>> {
  const out = new Map<string, { include: number; exclude: number }>();
  if (connectionIds.length === 0) return out;
  const rows = await tx
    .select({
      connectionId: portalConnectionProperties.connectionId,
      action: portalConnectionProperties.action,
      n: count(),
    })
    .from(portalConnectionProperties)
    .where(
      and(
        eq(portalConnectionProperties.agencyId, agencyId),
        inArray(portalConnectionProperties.connectionId, [...connectionIds]),
      ),
    )
    .groupBy(portalConnectionProperties.connectionId, portalConnectionProperties.action);
  for (const r of rows) {
    const entry = out.get(r.connectionId) ?? { include: 0, exclude: 0 };
    if (r.action === 'INCLUDE') entry.include = r.n;
    else entry.exclude = r.n;
    out.set(r.connectionId, entry);
  }
  return out;
}

/** The current choices among these listings of a connection. */
export async function overridesOf(
  tx: Tx,
  connectionId: string,
  propertyIds: readonly string[],
): Promise<{ propertyId: string; action: OverrideAction }[]> {
  if (propertyIds.length === 0) return [];
  return tx
    .select({ propertyId: portalConnectionProperties.propertyId, action: portalConnectionProperties.action })
    .from(portalConnectionProperties)
    .where(
      and(
        eq(portalConnectionProperties.connectionId, connectionId),
        inArray(portalConnectionProperties.propertyId, [...propertyIds]),
      ),
    );
}

export async function upsertOverrides(
  tx: Tx,
  rows: readonly {
    connectionId: string;
    propertyId: string;
    agencyId: string;
    action: OverrideAction;
    createdBy: string;
    now: Date;
  }[],
): Promise<void> {
  if (rows.length === 0) return;
  await tx
    .insert(portalConnectionProperties)
    .values(
      rows.map((r) => ({
        connectionId: r.connectionId,
        propertyId: r.propertyId,
        agencyId: r.agencyId,
        action: r.action,
        createdBy: r.createdBy,
        createdAt: r.now,
      })),
    )
    .onConflictDoUpdate({
      target: [portalConnectionProperties.connectionId, portalConnectionProperties.propertyId],
      set: { action: sql`excluded.action`, createdBy: sql`excluded.created_by`, createdAt: sql`excluded.created_at` },
    });
}

export async function deleteOverrides(tx: Tx, connectionId: string, propertyIds: readonly string[]): Promise<void> {
  if (propertyIds.length === 0) return;
  await tx
    .delete(portalConnectionProperties)
    .where(
      and(
        eq(portalConnectionProperties.connectionId, connectionId),
        inArray(portalConnectionProperties.propertyId, [...propertyIds]),
      ),
    );
}

/**
 * The connection's choices of one kind, ascending by listing id after `after` at most `limit`: `portal_connection_properties_action_idx`. `action` null: both kinds (the dashboard list).
 */
export async function overrideIdPage(
  tx: Tx,
  connectionId: string,
  q: { action: OverrideAction | null; after: string | null; limit: number },
): Promise<{ propertyId: string; action: OverrideAction }[]> {
  return tx
    .select({ propertyId: portalConnectionProperties.propertyId, action: portalConnectionProperties.action })
    .from(portalConnectionProperties)
    .where(
      and(
        eq(portalConnectionProperties.connectionId, connectionId),
        q.action ? eq(portalConnectionProperties.action, q.action) : undefined,
        q.after ? gt(portalConnectionProperties.propertyId, q.after) : undefined,
      ),
    )
    .orderBy(asc(portalConnectionProperties.propertyId))
    .limit(q.limit);
}
