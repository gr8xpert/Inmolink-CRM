/**
 * Legacy new-build import (S4-04, PLAN §14): the developments and units of one agency, as the migration module
 * transformed them from the legacy staging files, written in batches. A development is matched by its legacy id
 * (`developments.legacy_id`), a unit by the v2 id it already became (`legacy_id_maps`, passed in as `knownId`) or by
 * its reference within the development; nothing else is adopted: a reference held by a development that is not this
 * legacy row is reported (`ref_taken`), never overwritten. Idempotent: a second run with the same input writes
 * nothing, bumps no version and emits no event. A development deleted in v2 stays deleted (its units are reported).
 *
 * The caller is the operator script in a `withSystem()` transaction (like the taxonomy import): there is no member
 * and no `ctx`, so no policy check — the script is the authority, and the history rows name no user. A batch is a
 * fixed number of statements whatever its size; when it fails on some development's data, each development is retried
 * in its own savepoint so one bad row is reported alone.
 */
import { MAX_UNITS_PER_DEVELOPMENT } from '@inmolink/contracts';
import type { Tx } from '@inmolink/db';
import { AppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { emit, type OutboxMessage } from '@inmolink/platform/outbox';
import { developmentsEvents } from './events';
import * as repo from './repo';
import { withDbErrors } from './service';

export interface LegacyUnitInput extends Omit<repo.LegacyUnitValues, 'id' | 'developmentId'> {
  legacyId: string;
  /** The v2 unit this legacy unit already became (`legacy_id_maps`), if any. */
  knownId: string | null;
}

export interface LegacyDevelopmentInput {
  legacyId: string;
  /** Unique in the agency; the transform derives one when the legacy row has none. */
  ref: string;
  name: string;
  status: repo.LegacyDevelopmentValues['status'];
  /** `YYYY-MM-DD`. */
  completionDate: string | null;
  locationId: string;
  lat: number | null;
  lng: number | null;
  commissionBp: number | null;
  /** Set when the development is created; units take it. */
  currency: string;
  texts: readonly { locale: string; title: string; description: string | null; slug: string }[];
  /** Unique references (the transform makes them so). */
  units: readonly LegacyUnitInput[];
}

export type LegacyOutcome = 'created' | 'updated' | 'unchanged';

export interface LegacyDevelopmentsResult {
  /** Legacy development id → v2 id and what the run did. */
  developments: Map<string, { id: string; outcome: LegacyOutcome }>;
  /** Legacy unit id → v2 id and what the run did. */
  units: Map<string, { id: string; outcome: LegacyOutcome }>;
  skipped: { entity: 'development' | 'unit'; legacyId: string; reason: 'ref_taken' | 'refused'; detail: string }[];
}

const emptyResult = (): LegacyDevelopmentsResult => ({ developments: new Map(), units: new Map(), skipped: [] });

function addInto(total: LegacyDevelopmentsResult, part: LegacyDevelopmentsResult): void {
  for (const [k, v] of part.developments) total.developments.set(k, v);
  for (const [k, v] of part.units) total.units.set(k, v);
  total.skipped.push(...part.skipped);
}

/** Values the database refuses (class 22 data exceptions and integrity checks): the legacy data, not a fault. */
const INTEGRITY_CODES = new Set(['23502', '23503', '23505', '23514']);
function dataErrorCode(err: unknown): string | null {
  if (err instanceof AppError) return err.code;
  const code = (err as { cause?: { code?: string } }).cause?.code;
  return code && (code.startsWith('22') || INTEGRITY_CODES.has(code)) ? `DB_${code}` : null;
}

/** Imports one batch of an agency's legacy developments in the caller's (system) transaction. */
export async function importLegacyDevelopments(
  tx: Tx,
  agencyId: string,
  inputs: readonly LegacyDevelopmentInput[],
): Promise<LegacyDevelopmentsResult> {
  const byLegacy = new Map<string, LegacyDevelopmentInput>();
  for (const input of inputs) if (!byLegacy.has(input.legacyId)) byLegacy.set(input.legacyId, input);
  const todo = [...byLegacy.values()];
  const total = emptyResult();
  if (todo.length === 0) return total;
  try {
    addInto(total, await tx.transaction((sp) => writeBatch(sp, agencyId, todo)));
    return total;
  } catch (err) {
    if (dataErrorCode(err) === null) throw err;
  }
  for (const input of todo) {
    try {
      addInto(total, await tx.transaction((sp) => writeBatch(sp, agencyId, [input])));
    } catch (err) {
      const code = dataErrorCode(err);
      if (code === null) throw err;
      total.skipped.push({ entity: 'development', legacyId: input.legacyId, reason: 'refused', detail: code });
      for (const u of input.units) {
        total.skipped.push({ entity: 'unit', legacyId: u.legacyId, reason: 'refused', detail: 'DEVELOPMENT_REFUSED' });
      }
    }
  }
  return total;
}

const same = (a: string | number | null, b: number | null) => (a === null ? b === null : b !== null && Number(a) === b);
/** Coordinates are stored with 6 decimals. */
const round6 = (n: number | null) => (n === null ? null : Math.round(n * 1e6) / 1e6);

const UNIT_FIELDS = [
  'ref',
  'propertyTypeId',
  'bedrooms',
  'bathrooms',
  'internalM2',
  'terraceM2',
  'plotM2',
  'floor',
  'orientation',
  'priceCents',
  'status',
] as const;
const NUMERIC_UNIT_FIELDS = new Set<string>(['internalM2', 'terraceM2', 'plotM2']);

function unitChanges(was: repo.UnitListRow, u: LegacyUnitInput): string[] {
  return UNIT_FIELDS.filter((k) =>
    NUMERIC_UNIT_FIELDS.has(k)
      ? !same(was[k] as string | null, u[k] as number | null)
      : (was[k] ?? null) !== (u[k] ?? null),
  );
}

function developmentChanges(was: repo.LegacyMatchRow, d: LegacyDevelopmentInput): string[] {
  return [
    ...(was.name !== d.name ? ['name'] : []),
    ...(was.status !== d.status ? ['status'] : []),
    ...((was.completionDate ?? null) !== d.completionDate ? ['completionDate'] : []),
    ...(was.locationId !== d.locationId ? ['locationId'] : []),
    ...(!same(was.lat, round6(d.lat)) || !same(was.lng, round6(d.lng)) ? ['coordinates'] : []),
    ...((was.commissionBp ?? null) !== d.commissionBp ? ['commission'] : []),
  ];
}

/** One batch: three reads, the diff in memory, then one statement per kind of write. */
async function writeBatch(
  tx: Tx,
  agencyId: string,
  inputs: readonly LegacyDevelopmentInput[],
): Promise<LegacyDevelopmentsResult> {
  const out = emptyResult();
  const matches = await repo.legacyMatchesForUpdate(
    tx,
    agencyId,
    inputs.map((i) => i.legacyId),
    inputs.map((i) => i.ref),
  );
  const byLegacy = new Map(matches.filter((m) => m.legacyId !== null).map((m) => [m.legacyId as string, m]));
  const byRef = new Map(matches.map((m) => [m.ref, m]));
  const live = [...byLegacy.values()].filter((m) => !m.deletedAt);
  const unitsOf = new Map<string, repo.UnitListRow[]>(live.map((d) => [d.id, []]));
  for (const u of await repo.unitsOfDevelopments(
    tx,
    agencyId,
    live.map((d) => d.id),
  )) {
    unitsOf.get(u.developmentId)?.push(u);
  }
  const textsOf = new Map<string, Map<string, repo.LegacyTextRow & { locked: boolean }>>();
  for (const t of await repo.legacyTextsOf(
    tx,
    live.map((d) => d.id),
  )) {
    const m = textsOf.get(t.developmentId) ?? new Map();
    m.set(t.locale, t);
    textsOf.set(t.developmentId, m);
  }

  const skipUnits = (input: LegacyDevelopmentInput, detail: string) => {
    for (const u of input.units) out.skipped.push({ entity: 'unit', legacyId: u.legacyId, reason: 'refused', detail });
  };
  const newDevelopments: repo.LegacyDevelopmentInsert[] = [];
  const devChanges: (repo.LegacyDevelopmentValues & { changed: string[] })[] = [];
  const texts: repo.LegacyTextRow[] = [];
  const freshUnits: (repo.LegacyUnitValues & { currency: string; legacyId: string })[] = [];
  const unitChanges_: (repo.LegacyUnitValues & { legacyId: string; before: repo.UnitListRow; changed: string[] })[] =
    [];

  for (const input of inputs) {
    const dev = byLegacy.get(input.legacyId);
    if (!dev) {
      const holder = byRef.get(input.ref);
      if (holder) {
        out.skipped.push({
          entity: 'development',
          legacyId: input.legacyId,
          reason: 'ref_taken',
          detail: holder.legacyId ? `legacy ${holder.legacyId}` : 'v2 development',
        });
        skipUnits(input, 'DEVELOPMENT_REF_TAKEN');
        continue;
      }
    }
    if (dev?.deletedAt) {
      out.developments.set(input.legacyId, { id: dev.id, outcome: 'unchanged' });
      skipUnits(input, 'DEVELOPMENT_DELETED');
      continue;
    }
    const have = dev ? (unitsOf.get(dev.id) ?? []) : [];
    const haveById = new Map(have.map((u) => [u.id, u]));
    const haveByRef = new Map(have.map((u) => [u.ref, u]));
    const developmentId = dev?.id ?? newId();
    const currency = dev?.currency ?? input.currency;
    const fresh: typeof freshUnits = [];
    const changed: typeof unitChanges_ = [];
    const unchanged: { legacyId: string; id: string }[] = [];
    for (const u of input.units) {
      const was = (u.knownId ? haveById.get(u.knownId) : undefined) ?? haveByRef.get(u.ref);
      const { knownId: _k, ...values } = u;
      if (!was) {
        fresh.push({ ...values, id: newId(), developmentId, currency });
        continue;
      }
      const diff = unitChanges(was, u);
      if (diff.length === 0) unchanged.push({ legacyId: u.legacyId, id: was.id });
      else changed.push({ ...values, id: was.id, developmentId, before: was, changed: diff });
    }
    if (have.length + fresh.length > MAX_UNITS_PER_DEVELOPMENT) {
      out.skipped.push({
        entity: 'development',
        legacyId: input.legacyId,
        reason: 'refused',
        detail: 'DEVELOPMENT_UNIT_LIMIT',
      });
      skipUnits(input, 'DEVELOPMENT_UNIT_LIMIT');
      continue;
    }
    freshUnits.push(...fresh);
    unitChanges_.push(...changed);
    for (const u of unchanged) out.units.set(u.legacyId, { id: u.id, outcome: 'unchanged' });

    const current = textsOf.get(developmentId);
    const textChanged = input.texts.filter((t) => {
      const was = current?.get(t.locale);
      return (
        !was || (!was.locked && (was.title !== t.title || was.description !== t.description || was.slug !== t.slug))
      );
    });
    texts.push(...textChanged.map((t) => ({ ...t, developmentId })));

    const values: repo.LegacyDevelopmentValues = {
      id: developmentId,
      name: input.name,
      status: input.status,
      completionDate: input.completionDate,
      locationId: input.locationId,
      lat: round6(input.lat),
      lng: round6(input.lng),
      commissionBp: input.commissionBp,
    };
    if (!dev) {
      newDevelopments.push({ ...values, ref: input.ref, legacyId: input.legacyId, currency: input.currency });
      continue;
    }
    const diff = [...developmentChanges(dev, input), ...(textChanged.length > 0 ? ['translations'] : [])];
    if (diff.length > 0) devChanges.push({ ...values, changed: diff });
    else out.developments.set(input.legacyId, { id: dev.id, outcome: 'unchanged' });
  }

  const events: OutboxMessage[] = [];
  const created = await withDbErrors(() => repo.insertLegacyDevelopments(tx, agencyId, newDevelopments));
  const createdIds = new Set(created.map((d) => d.id));
  for (const d of created)
    events.push(developmentsEvents.created({ developmentId: d.id, agencyId, version: d.version }));
  for (const d of newDevelopments) {
    if (createdIds.has(d.id)) out.developments.set(d.legacyId, { id: d.id, outcome: 'created' });
  }
  const updated = await withDbErrors(() => repo.setLegacyDevelopments(tx, agencyId, devChanges));
  const changeOf = new Map(devChanges.map((c) => [c.id, c.changed]));
  const legacyOfDev = new Map(inputs.map((i) => [byLegacy.get(i.legacyId)?.id, i.legacyId]));
  for (const d of updated) {
    events.push(
      developmentsEvents.updated({
        developmentId: d.id,
        agencyId,
        version: d.version,
        changed: changeOf.get(d.id) ?? [],
      }),
    );
    const legacyId = legacyOfDev.get(d.id);
    if (legacyId) out.developments.set(legacyId, { id: d.id, outcome: 'updated' });
  }
  await withDbErrors(() => repo.upsertLegacyTexts(tx, agencyId, texts));

  await withDbErrors(() => repo.insertLegacyUnits(tx, agencyId, freshUnits));
  const prices: Parameters<typeof repo.insertPriceListHistories>[1]['prices'][number][] = [];
  const statuses: Parameters<typeof repo.insertPriceListHistories>[1]['statuses'][number][] = [];
  for (const u of freshUnits) {
    out.units.set(u.legacyId, { id: u.id, outcome: 'created' });
    statuses.push({ id: newId(), unitId: u.id, from: null, to: u.status });
    if (u.priceCents !== null)
      prices.push({ id: newId(), unitId: u.id, from: null, to: u.priceCents, currency: u.currency });
    events.push(developmentsEvents.unitCreated({ unitId: u.id, developmentId: u.developmentId, agencyId, version: 1 }));
  }
  const after = new Map(
    (await withDbErrors(() => repo.setLegacyUnits(tx, agencyId, unitChanges_))).map((u) => [u.id, u.version]),
  );
  for (const u of unitChanges_) {
    const version = after.get(u.id);
    if (version === undefined) continue;
    out.units.set(u.legacyId, { id: u.id, outcome: 'updated' });
    const ids = { unitId: u.id, developmentId: u.developmentId, agencyId, version };
    events.push(developmentsEvents.unitUpdated({ ...ids, changed: u.changed }));
    if (u.before.status !== u.status) {
      statuses.push({ id: newId(), unitId: u.id, from: u.before.status, to: u.status });
      events.push(developmentsEvents.unitStatusChanged({ ...ids, from: u.before.status, to: u.status }));
    }
    if (u.before.priceCents !== u.priceCents) {
      prices.push({
        id: newId(),
        unitId: u.id,
        from: u.before.priceCents,
        to: u.priceCents,
        currency: u.before.currency,
      });
      events.push(developmentsEvents.unitPriceChanged({ ...ids, priceListId: null }));
    }
  }
  await repo.insertPriceListHistories(tx, { agencyId, priceListId: null, changedByUserId: null, prices, statuses });
  await emit(tx, events);
  return out;
}
