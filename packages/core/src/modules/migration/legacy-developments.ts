/**
 * Legacy new-build import (S4-04, PLAN §14): one agency's staged legacy developments and their units → v2
 * developments and units through `developments.importLegacyDevelopments`, a `legacy_id_maps` row for each loaded
 * development and unit, and a report whose counts are checked against the extract's inventory.
 *
 * The transform is pure (`transformLegacyDevelopments`): it validates each staged row, maps its legacy location and
 * property type through the taxonomy maps (S2-06) and lists every row it cannot load with a reason — an unmapped
 * location is never guessed. Re-runnable: a second run with the same staging changes nothing.
 */
import {
  type DevelopmentStatus,
  LegacyDevelopmentRow,
  type LegacyLoadReport,
  LegacyUnitRow,
  type UnitStatus,
} from '@inmolink/contracts';
import type { Tx } from '@inmolink/db';
import * as developments from '../developments';
import {
  addIssue,
  chunks,
  contentLocale,
  countOutcome,
  countsOf,
  enumKey,
  finishReport,
  inSavepoint,
  newLoadReport,
  recordMaps,
  slugify,
  targetsOf,
  validateRows,
} from './load';

/** Staging entity names (S14-01 `DEFAULT_ENTITIES`) and the v2 entities of `legacy_id_maps` and the report. */
export const LEGACY_DEVELOPMENT_ENTITIES = { development: 'developments', unit: 'development_units' } as const;

/** Developments per write batch (each up to `MAX_UNITS_PER_DEVELOPMENT` units). */
export const LEGACY_DEVELOPMENT_BATCH = 100;

const DEVELOPMENT_STATUSES: Record<string, DevelopmentStatus> = {
  off_plan: 'OFF_PLAN',
  offplan: 'OFF_PLAN',
  plan: 'OFF_PLAN',
  sobre_plano: 'OFF_PLAN',
  under_construction: 'UNDER_CONSTRUCTION',
  construction: 'UNDER_CONSTRUCTION',
  en_construccion: 'UNDER_CONSTRUCTION',
  key_ready: 'KEY_READY',
  keyready: 'KEY_READY',
  finished: 'KEY_READY',
  completed: 'KEY_READY',
  llave_en_mano: 'KEY_READY',
  sold_out: 'SOLD_OUT',
  soldout: 'SOLD_OUT',
  sold: 'SOLD_OUT',
  vendido: 'SOLD_OUT',
};
const UNIT_STATUSES: Record<string, UnitStatus> = {
  available: 'AVAILABLE',
  for_sale: 'AVAILABLE',
  free: 'AVAILABLE',
  disponible: 'AVAILABLE',
  reserved: 'RESERVED',
  reservado: 'RESERVED',
  sold: 'SOLD',
  vendido: 'SOLD',
};
/** English and Spanish compass points (`O` = oeste). */
const ORIENTATIONS: Record<string, developments.LegacyUnitInput['orientation']> = {
  n: 'N',
  ne: 'NE',
  e: 'E',
  se: 'SE',
  s: 'S',
  sw: 'SW',
  so: 'SW',
  w: 'W',
  o: 'W',
  nw: 'NW',
  no: 'NW',
};

/** The taxonomy maps the transform needs: legacy id → v2 id. */
export interface LegacyTaxonomyTargets {
  locations: ReadonlyMap<string, string>;
  propertyTypes: ReadonlyMap<string, string>;
  /** Legacy unit id → v2 unit id, for units an earlier run loaded. */
  units: ReadonlyMap<string, string>;
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const cents = (euros: number) => Math.round(euros * 100);

/** A reference unique among `taken` (the legacy one, else `L-<legacy id>`), at most 40 characters. */
function uniqueRef(wanted: string | undefined, legacyId: string, taken: Set<string>): string {
  const fallback = `L-${legacyId}`.slice(0, 40);
  const ref = wanted && !taken.has(wanted) ? wanted : fallback;
  taken.add(ref);
  return ref;
}

/**
 * Staged rows → import inputs, listing every row that cannot be loaded in `report` (invalid, duplicate, unmapped
 * location or property type, unit of a development that is not loaded). Pure: no I/O.
 */
export function transformLegacyDevelopments(
  report: LegacyLoadReport,
  staged: { developments: readonly unknown[]; units: readonly unknown[] },
  targets: LegacyTaxonomyTargets,
): developments.LegacyDevelopmentInput[] {
  const devRows = validateRows(report, 'development', LegacyDevelopmentRow, staged.developments);
  const unitRows = validateRows(report, 'unit', LegacyUnitRow, staged.units);

  const unitsOf = new Map<string, LegacyUnitRow[]>();
  for (const u of unitRows) unitsOf.set(u.development_id, [...(unitsOf.get(u.development_id) ?? []), u]);

  const refs = new Set<string>();
  const inputs: developments.LegacyDevelopmentInput[] = [];
  const loaded = new Set<string>();
  for (const d of devRows) {
    const status = d.status === undefined ? 'OFF_PLAN' : DEVELOPMENT_STATUSES[enumKey(d.status)];
    if (!status) {
      addIssue(report, 'development', d.id, 'invalid', `status: unknown value ${JSON.stringify(d.status)}`);
      continue;
    }
    const locationId = d.location_id === undefined ? undefined : targets.locations.get(d.location_id);
    if (!locationId) {
      addIssue(report, 'development', d.id, 'unmapped_location', d.location_id ?? null);
      continue;
    }
    if ((d.lat === undefined) !== (d.lng === undefined)) {
      addIssue(report, 'development', d.id, 'invalid', 'coordinates: lat and lng go together');
      continue;
    }
    const texts: developments.LegacyDevelopmentInput['texts'][number][] = [];
    const locales = new Set<string>();
    let badLocale: string | null = null;
    for (const t of d.translations ?? []) {
      const locale = contentLocale(t.locale);
      if (!locale) {
        badLocale = t.locale;
        break;
      }
      if (locales.has(locale)) continue; // the first text of a locale wins
      locales.add(locale);
      const title = t.title ?? d.name;
      texts.push({
        locale,
        title,
        description: t.description ?? null,
        slug: slugify(title) || slugify(d.name) || `development-${slugify(d.id) || 'legacy'}`,
      });
    }
    if (badLocale !== null) {
      addIssue(report, 'development', d.id, 'invalid', `translations: unknown locale ${JSON.stringify(badLocale)}`);
      continue;
    }

    const unitRefs = new Set<string>();
    const units: developments.LegacyUnitInput[] = [];
    for (const u of unitsOf.get(d.id) ?? []) {
      const unitStatus = u.status === undefined ? 'AVAILABLE' : UNIT_STATUSES[enumKey(u.status)];
      if (!unitStatus) {
        addIssue(report, 'unit', u.id, 'invalid', `status: unknown value ${JSON.stringify(u.status)}`);
        continue;
      }
      const orientation = u.orientation === undefined ? null : ORIENTATIONS[enumKey(u.orientation)];
      if (orientation === undefined) {
        addIssue(report, 'unit', u.id, 'invalid', `orientation: unknown value ${JSON.stringify(u.orientation)}`);
        continue;
      }
      const propertyTypeId =
        u.property_type_id === undefined ? undefined : targets.propertyTypes.get(u.property_type_id);
      if (!propertyTypeId) {
        addIssue(report, 'unit', u.id, 'unmapped_property_type', u.property_type_id ?? null);
        continue;
      }
      units.push({
        legacyId: u.id,
        knownId: targets.units.get(u.id) ?? null,
        ref: uniqueRef(u.ref, u.id, unitRefs),
        propertyTypeId,
        bedrooms: u.bedrooms ?? null,
        bathrooms: u.bathrooms ?? null,
        internalM2: u.built_m2 ?? null,
        terraceM2: u.terrace_m2 ?? null,
        plotM2: u.plot_m2 ?? null,
        floor: u.floor ?? null,
        orientation,
        priceCents: u.price === undefined ? null : cents(u.price),
        status: unitStatus,
      });
    }

    loaded.add(d.id);
    inputs.push({
      legacyId: d.id,
      ref: uniqueRef(d.ref, d.id, refs),
      name: d.name,
      status,
      completionDate: d.completion_date ? isoDate(d.completion_date) : null,
      locationId,
      lat: d.lat ?? null,
      lng: d.lng ?? null,
      commissionBp: d.commission_percent === undefined ? null : Math.round(d.commission_percent * 100),
      currency: (d.currency ?? 'EUR').toUpperCase(),
      texts,
      units,
    });
  }
  // Units whose development is missing from the staging or was not loaded.
  for (const u of unitRows) {
    if (!loaded.has(u.development_id)) addIssue(report, 'unit', u.id, 'orphan', `development ${u.development_id}`);
  }
  return inputs;
}

export interface LoadLegacyDevelopmentsInput {
  legacyAgencyId: string;
  /** The v2 agency (`resolveLegacyAgency`). */
  agencyId: string;
  /** Raw staged rows (`developments.ndjson`, `development_units.ndjson`). */
  developments: readonly unknown[];
  units: readonly unknown[];
  /** The extract inventory's legacy row counts of this agency, when known. */
  legacyRows?: { development?: number; unit?: number };
}

/**
 * Loads one agency's legacy developments and units in the caller's `withSystem()` transaction and returns the report.
 * `dryRun` runs every check and statement in a savepoint that is rolled back.
 */
export async function loadLegacyDevelopments(
  tx: Tx,
  input: LoadLegacyDevelopmentsInput,
  opts: { dryRun?: boolean } = {},
): Promise<LegacyLoadReport> {
  const dryRun = opts.dryRun ?? false;
  const report = newLoadReport(input.legacyAgencyId, input.agencyId, dryRun);
  countsOf(report, 'development', input.legacyRows?.development ?? null);
  countsOf(report, 'unit', input.legacyRows?.unit ?? null);

  const idsOf = (rows: readonly unknown[], key: string) =>
    rows.flatMap((r) => {
      const v = (r as Record<string, unknown> | null)?.[key];
      return typeof v === 'string' || typeof v === 'number' ? [String(v).trim()] : [];
    });
  // One transaction, one connection: the lookups run one after the other.
  const locations = await targetsOf(tx, 'location', idsOf(input.developments, 'location_id'));
  const propertyTypes = await targetsOf(tx, 'propertyType', idsOf(input.units, 'property_type_id'));
  const units = await targetsOf(tx, 'unit', idsOf(input.units, 'id'));
  const inputs = transformLegacyDevelopments(
    report,
    { developments: input.developments, units: input.units },
    { locations, propertyTypes, units },
  );

  await inSavepoint(tx, dryRun, async (sp) => {
    for (const batch of chunks(inputs, LEGACY_DEVELOPMENT_BATCH)) {
      const result = await developments.importLegacyDevelopments(sp, input.agencyId, batch);
      for (const s of result.skipped) addIssue(report, s.entity, s.legacyId, s.reason, s.detail);
      for (const { outcome } of result.developments.values()) countOutcome(report, 'development', outcome);
      for (const { outcome } of result.units.values()) countOutcome(report, 'unit', outcome);
      await recordMaps(
        sp,
        'development',
        [...result.developments].map(([legacyId, d]) => [legacyId, d.id]),
      );
      await recordMaps(
        sp,
        'unit',
        [...result.units].map(([legacyId, u]) => [legacyId, u.id]),
      );
    }
  });
  return finishReport(report);
}
