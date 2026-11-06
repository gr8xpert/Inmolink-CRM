import {
  CLIENT_PROFILE_LIMITS,
  type ClientProfileDto,
  type ClientProfileFrequency,
  type ClientProfileMode,
  type ClientProfilePage,
  CreateClientProfileBody,
  type PageQuery,
  type TransactionType,
  UpdateClientProfileBody,
} from '@inmolink/contracts';
import { type Tx, withSystem, withTenant } from '@inmolink/db';
import { AppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { emit } from '@inmolink/platform/outbox';
import type { z } from 'zod';
import type { Ctx } from '../../context';
import { decodeCursor, toPage } from '../../pagination';
import * as crm from '../crm';
import * as taxonomy from '../taxonomy';
import { CLIENT_PROFILE_EVENT_IDS, matchingEvents } from './events';
import { assertCan } from './policy';
import * as repo from './repo';

/**
 * Client profiles (R2-02a, PLAN §7 M9, §3 #23): what a client — an open CRM contact of the agency — is looking for, and
 * how the match engine works it (`mode`, `frequency`). Request side under the agency's RLS; the rule is the owning
 * contact's (`matching.clientProfiles.read` / `.write` = `crm.contacts.read` / `.write`), and the contact must be an
 * open contact of the agency (`crm.openContactExists`: a merged or erased contact takes no profile). Every write emits
 * `matching.clientProfiles.changed` in its transaction (the embedding job, later the match engine, follow it).
 *
 * Worker side: a contact merge (`crm.contact.merged`) moves the closed contact's profiles to the survivor; a contact
 * erasure (`crm.contact.erased`) deletes the erased contact's (and contacts merged into it) profiles and their vectors.
 * Agency erasure is `deleteAgencySavedSearches` (erasure.ts).
 */

/** Profiles per worker statement (merge / erasure); also the event's id cap. */
const PROFILE_BATCH = CLIENT_PROFILE_EVENT_IDS;

function toDto(r: repo.ClientProfileRow): ClientProfileDto {
  return {
    id: r.id,
    contactId: r.contactId,
    mode: r.mode as ClientProfileMode,
    frequency: r.frequency as ClientProfileFrequency,
    transactionType: r.transactionType as TransactionType | null,
    propertyTypeIds: r.propertyTypeIds,
    locationIds: r.locationIds,
    featureIds: r.featureIds,
    priceMinCents: r.priceMinCents === null ? null : Number(r.priceMinCents),
    priceMaxCents: r.priceMaxCents === null ? null : Number(r.priceMaxCents),
    bedsMin: r.bedsMin,
    bathsMin: r.bathsMin,
    areaMinM2: r.areaMinM2 === null ? null : Number(r.areaMinM2),
    areaMaxM2: r.areaMaxM2 === null ? null : Number(r.areaMaxM2),
    wishes: r.wishes,
    version: r.version,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

const unique = <T>(xs: readonly T[] | undefined): T[] => [...new Set(xs ?? [])];

/** Refuses taxonomy ids that do not exist (`VALIDATION_FAILED` on the field, `unknown`): three statements at most. */
async function assertKnownTaxa(tx: Tx, f: repo.ClientProfileFields): Promise<void> {
  if (f.locationIds.length > 0) {
    const lines = await taxonomy.locationLineages(tx, f.locationIds);
    if (f.locationIds.some((id) => !lines.has(id))) {
      throw new AppError('VALIDATION_FAILED', { field: 'locationIds', reason: 'unknown' });
    }
  }
  for (const [field, kind] of [
    ['propertyTypeIds', 'propertyType'],
    ['featureIds', 'feature'],
  ] as const) {
    const ids = f[field];
    if (ids.length === 0) continue;
    const known = await taxonomy.existingCatalogIds(tx, kind, ids);
    if (ids.some((id) => !known.has(id))) throw new AppError('VALIDATION_FAILED', { field, reason: 'unknown' });
  }
}

/** The profile's columns from a parsed body; taxonomy ids checked. */
async function fieldsOf(
  ctx: Ctx,
  s: z.output<typeof CreateClientProfileBody> | z.output<typeof UpdateClientProfileBody>,
): Promise<repo.ClientProfileFields> {
  // trimmed by the contract; blank is none
  const wishes = s.wishes || null;
  const fields: repo.ClientProfileFields = {
    mode: s.mode,
    frequency: s.frequency,
    transactionType: s.transactionType ?? null,
    propertyTypeIds: unique(s.propertyTypeIds),
    locationIds: unique(s.locationIds),
    featureIds: unique(s.featureIds),
    priceMinCents: s.priceMinCents ?? null,
    priceMaxCents: s.priceMaxCents ?? null,
    bedsMin: s.bedsMin ?? null,
    bathsMin: s.bathsMin ?? null,
    areaMinM2: s.areaMinM2 ?? null,
    areaMaxM2: s.areaMaxM2 ?? null,
    wishes,
  };
  await assertKnownTaxa(ctx.tx, fields);
  return fields;
}

/**
 * The contact must be an open contact of the caller's agency (`CONTACT_NOT_FOUND` otherwise). `lock` (a create): the
 * contact is locked until the commit, so a merge or erasure of it waits for the new profile (and its reaction moves /
 * deletes it), and two creates for one contact count one after the other (the cap holds).
 */
async function assertOpenContact(ctx: Ctx, contactId: string, lock = false): Promise<void> {
  const open = lock ? crm.lockOpenContact : crm.openContactExists;
  if (!(await open(ctx.tx, ctx.tenant.agencyId, contactId))) {
    throw new AppError('CONTACT_NOT_FOUND');
  }
}

/** A profile of the caller's agency whose contact is still open (`CLIENT_PROFILE_NOT_FOUND` otherwise). */
async function loadProfile(ctx: Ctx, id: string): Promise<repo.ClientProfileRow> {
  const row = await repo.clientProfileOf(ctx.tx, ctx.tenant.agencyId, id);
  if (!row || !(await crm.openContactExists(ctx.tx, ctx.tenant.agencyId, row.contactId))) {
    throw new AppError('CLIENT_PROFILE_NOT_FOUND');
  }
  return row;
}

const changed = (ctx: Ctx, profileIds: string[]) =>
  emit(ctx.tx, matchingEvents.clientProfilesChanged({ agencyId: ctx.tenant.agencyId, profileIds }));

/** `GET /v1/crm/contacts/:id/profiles`: the contact's profiles, oldest first (keyset, ≤ 100 a page). */
export async function listClientProfiles(ctx: Ctx, contactId: string, query: PageQuery): Promise<ClientProfilePage> {
  assertCan(ctx, 'matching.clientProfiles.read');
  const cursor = decodeCursor(query.cursor);
  await assertOpenContact(ctx, contactId);
  const rows = await repo.clientProfilesOfContact(ctx.tx, ctx.tenant.agencyId, contactId, {
    limit: query.limit,
    cursor,
  });
  return toPage(rows, query.limit, (r) => ({ at: r.createdAt, id: r.id, atUs: r.atUs }), toDto);
}

/** `GET /v1/client-profiles/:id`. */
export async function getClientProfile(ctx: Ctx, id: string): Promise<ClientProfileDto> {
  assertCan(ctx, 'matching.clientProfiles.read');
  return toDto(await loadProfile(ctx, id));
}

/** `POST /v1/crm/contacts/:id/profiles`: at most `CLIENT_PROFILE_LIMITS.perContact` per contact (`CLIENT_PROFILE_LIMIT`). */
export async function createClientProfile(
  ctx: Ctx,
  contactId: string,
  raw: CreateClientProfileBody,
): Promise<ClientProfileDto> {
  assertCan(ctx, 'matching.clientProfiles.write');
  const body = CreateClientProfileBody.parse(raw);
  await assertOpenContact(ctx, contactId, true);
  const fields = await fieldsOf(ctx, body);
  const row = await repo.insertClientProfile(ctx.tx, {
    ...fields,
    agencyId: ctx.tenant.agencyId,
    id: newId(),
    contactId,
    max: CLIENT_PROFILE_LIMITS.perContact,
  });
  if (!row) throw new AppError('CLIENT_PROFILE_LIMIT', { max: CLIENT_PROFILE_LIMITS.perContact });
  await changed(ctx, [row.id]);
  return toDto(row);
}

/** `PUT /v1/client-profiles/:id`: every field replaced at `version` (`VERSION_CONFLICT` otherwise); the version moves on. */
export async function updateClientProfile(
  ctx: Ctx,
  id: string,
  raw: UpdateClientProfileBody,
): Promise<ClientProfileDto> {
  assertCan(ctx, 'matching.clientProfiles.write');
  const body = UpdateClientProfileBody.parse(raw);
  const current = await loadProfile(ctx, id);
  if (current.version !== body.version) throw new AppError('VERSION_CONFLICT');
  const fields = await fieldsOf(ctx, body);
  const row = await repo.updateClientProfile(ctx.tx, ctx.tenant.agencyId, id, body.version, fields);
  if (!row) throw new AppError('VERSION_CONFLICT');
  await changed(ctx, [row.id]);
  return toDto(row);
}

/** `DELETE /v1/client-profiles/:id` (its vector goes with the `changed` event's embed job). */
export async function deleteClientProfile(ctx: Ctx, id: string): Promise<void> {
  assertCan(ctx, 'matching.clientProfiles.write');
  await loadProfile(ctx, id);
  if (!(await repo.deleteClientProfile(ctx.tx, ctx.tenant.agencyId, id))) {
    throw new AppError('CLIENT_PROFILE_NOT_FOUND');
  }
  await changed(ctx, [id]);
}

/** Rows one `subjectClientProfiles` page holds. */
export const SUBJECT_PROFILE_PAGE = 1_000;

/**
 * R2-02a, the `SUBJECT` data export (compliance): a page of the contact's profiles by id — criteria, wishes, mode,
 * frequency and times. Under the caller's RLS (`tx`).
 */
export async function subjectClientProfiles(tx: Tx, agencyId: string, contactId: string, afterId: string | null) {
  const rows = await repo.subjectClientProfiles(tx, { agencyId, contactId, afterId, limit: SUBJECT_PROFILE_PAGE });
  return rows.map(toDto);
}

/* ------------------------------------------------------------------ contact merge / erasure (worker) */

/**
 * A contact merge (`matching.repointClientProfiles` on `crm.contact.merged`): the closed contact's profiles name the
 * survivor, `PROFILE_BATCH` a transaction, each batch with its `matching.clientProfiles.changed`. The survivor may end
 * with more than `perContact` profiles (nothing is dropped: the cap only bounds creation). Idempotent: a redelivery
 * finds nothing left to move.
 */
export async function repointClientProfiles(p: {
  agencyId: string;
  survivorId: string;
  mergedId: string;
}): Promise<{ profiles: number }> {
  let total = 0;
  for (;;) {
    const moved = await withTenant({ agencyId: p.agencyId }, async (tx) => {
      const ids = await repo.repointClientProfiles(tx, {
        agencyId: p.agencyId,
        fromId: p.mergedId,
        toId: p.survivorId,
        limit: PROFILE_BATCH,
      });
      if (ids.length > 0) {
        await emit(tx, matchingEvents.clientProfilesChanged({ agencyId: p.agencyId, profileIds: ids }));
      }
      return ids.length;
    });
    total += moved;
    if (moved < PROFILE_BATCH) return { profiles: total };
  }
}

/**
 * A contact erasure (`matching.eraseContactProfiles` on `crm.contact.erased`): the profiles of these contacts (the
 * erased one and the closed contacts merged into it) and their vectors are deleted, `PROFILE_BATCH` a transaction.
 * Worker-only (`app_system`: the vectors are global, worker-only rows; the agency is an explicit predicate). No event:
 * nothing is left to embed, and the vectors go here. An embed job racing this can still write a vector (numbers
 * only): the daily profile backfill drops it as an orphan. Idempotent.
 */
export async function eraseContactProfiles(p: {
  agencyId: string;
  contactIds: readonly string[];
}): Promise<{ profiles: number }> {
  if (p.contactIds.length === 0) return { profiles: 0 };
  let total = 0;
  for (;;) {
    const deleted = await withSystem('matching.eraseContactProfiles', async (tx) => {
      const ids = await repo.deleteContactsClientProfiles(tx, {
        agencyId: p.agencyId,
        contactIds: p.contactIds,
        limit: PROFILE_BATCH,
      });
      await repo.deleteProfileEmbeddings(tx, p.agencyId, ids);
      return ids.length;
    });
    total += deleted;
    if (deleted < PROFILE_BATCH) return { profiles: total };
  }
}
