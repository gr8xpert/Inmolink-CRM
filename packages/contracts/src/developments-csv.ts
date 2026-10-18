import { MAX_UNITS_PER_BULK, MAX_UNITS_PER_DEVELOPMENT } from './values';

/**
 * The developer's spreadsheets (S4-03): a unit CSV (one row per unit) and a price-list CSV (ref, price, status).
 * Comma or semicolon separated (Spanish Excel writes `;`), quoted fields, a header row naming the columns in any
 * order. Zod-free (`@inmolink/contracts/developments-csv`, S5-F3): the dashboard parses in the browser, the legacy
 * new-build import (S4-04) and the S6 imports reuse the same rules; the API validates the bodies again.
 */

export interface CsvProblem {
  /** 1-based line of the file (the header is line 1). */
  line: number;
  /** The column at fault, or `file` for the file as a whole. */
  column: string;
  reason: 'required' | 'invalid' | 'unknownType' | 'duplicate' | 'tooMany' | 'empty' | 'noHeader' | 'tooLarge';
}

export type UnitStatusValue = 'AVAILABLE' | 'RESERVED' | 'SOLD';
type OrientationValue = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW';

export interface CsvUnit {
  ref: string;
  propertyTypeId: string;
  bedrooms?: number | null;
  bathrooms?: number | null;
  internalM2?: number | null;
  terraceM2?: number | null;
  plotM2?: number | null;
  floor?: number | null;
  orientation?: OrientationValue | null;
  priceCents?: number | null;
  status?: UnitStatusValue;
}

export interface CsvPriceEntry {
  ref: string;
  priceCents: number | null;
  status?: UnitStatusValue;
}

const STATUSES = new Set<string>(['AVAILABLE', 'RESERVED', 'SOLD']);
const ORIENTATIONS = new Set<string>(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']);
/** Header spellings → field. */
const UNIT_COLUMNS: Record<string, keyof CsvUnit | 'type'> = {
  ref: 'ref',
  reference: 'ref',
  type: 'type',
  property_type: 'type',
  bedrooms: 'bedrooms',
  beds: 'bedrooms',
  bathrooms: 'bathrooms',
  baths: 'bathrooms',
  internal_m2: 'internalM2',
  built_m2: 'internalM2',
  terrace_m2: 'terraceM2',
  plot_m2: 'plotM2',
  floor: 'floor',
  orientation: 'orientation',
  price: 'priceCents',
  status: 'status',
};

/** Splits CSV text into rows of trimmed cells; the delimiter is whichever of `;` and `,` the header uses more. */
export function parseCsv(text: string): string[][] {
  const body = text.replace(/^﻿/, '');
  const firstLine = body.slice(0, body.search(/\r?\n|$/));
  const delimiter = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quoted) {
      if (c === '"' && body[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) {
      row.push(cell.trim());
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && body[i + 1] === '\n') i++;
      row.push(cell.trim());
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell.trim());
    rows.push(row);
  }
  return rows;
}

/**
 * A price in major units → cents; `''` is null (on request). Accepts `850000`, `850000.50`, `850.000`,
 * `850,000`, `1.250.000,00` and a leading or trailing `€`. Undefined when it is not a price.
 */
export function priceToCents(raw: string): number | null | undefined {
  const s = raw.replace(/[\s€]/g, '');
  if (s === '') return null;
  let normal: string;
  if (/^\d{1,3}([.,]\d{3})+$/.test(s)) normal = s.replace(/[.,]/g, '');
  else if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(s)) normal = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(,\d{3})+\.\d{1,2}$/.test(s)) normal = s.replace(/,/g, '');
  else if (/^\d+([.,]\d{1,2})?$/.test(s)) normal = s.replace(',', '.');
  else return undefined;
  const cents = Math.round(Number(normal) * 100);
  return Number.isSafeInteger(cents) ? cents : undefined;
}

function number(raw: string, integer: boolean): number | null | undefined {
  if (raw === '') return null;
  const n = Number(raw.replace(',', '.'));
  if (!Number.isFinite(n) || (integer && !Number.isInteger(n))) return undefined;
  return n;
}

const keyOf = (header: string) => header.toLowerCase().replace(/[\s-]+/g, '_');

/**
 * Units from a CSV: `ref` and `type` (a property type's name or id, resolved by `typeId`) are required, every
 * other column optional. Problems name the line and column; nothing is sent while there are any.
 */
export function unitsFromCsv(
  text: string,
  typeId: (nameOrId: string) => string | null,
): { units: CsvUnit[]; problems: CsvProblem[] } {
  const rows = parseCsv(text).filter((r) => r.some((c) => c !== ''));
  const problems: CsvProblem[] = [];
  const [header, ...data] = rows;
  const columns = (header ?? []).map((h) => UNIT_COLUMNS[keyOf(h)] ?? null);
  if (!columns.includes('ref') || !columns.includes('type')) {
    return { units: [], problems: [{ line: 1, column: 'file', reason: 'noHeader' }] };
  }
  if (data.length === 0) return { units: [], problems: [{ line: 1, column: 'file', reason: 'empty' }] };
  if (data.length > MAX_UNITS_PER_BULK) {
    return { units: [], problems: [{ line: 1, column: 'file', reason: 'tooMany' }] };
  }
  const seen = new Set<string>();
  const units: CsvUnit[] = [];
  data.forEach((cells, i) => {
    const line = i + 2;
    const unit: Partial<CsvUnit> = {};
    columns.forEach((field, c) => {
      if (field === null) return;
      const reason = readCell(unit, field, cells[c] ?? '', seen, typeId);
      if (reason) problems.push({ line, column: header?.[c] ?? '', reason });
    });
    if (unit.ref && unit.propertyTypeId) units.push(unit as CsvUnit);
  });
  return problems.length > 0 ? { units: [], problems } : { units, problems };
}

/** Reads one cell into `unit`; the problem's reason when the value is refused. */
function readCell(
  unit: Partial<CsvUnit>,
  field: keyof CsvUnit | 'type',
  raw: string,
  seen: Set<string>,
  typeId: (nameOrId: string) => string | null,
): CsvProblem['reason'] | null {
  switch (field) {
    case 'ref':
      if (raw === '') return 'required';
      if (raw.length > 40) return 'invalid';
      if (seen.has(raw)) return 'duplicate';
      seen.add(raw);
      unit.ref = raw;
      return null;
    case 'type':
    case 'propertyTypeId': {
      if (raw === '') return 'required';
      const id = typeId(raw);
      if (!id) return 'unknownType';
      unit.propertyTypeId = id;
      return null;
    }
    case 'status':
      if (raw === '') return null;
      if (!STATUSES.has(raw.toUpperCase())) return 'invalid';
      unit.status = raw.toUpperCase() as UnitStatusValue;
      return null;
    case 'orientation':
      if (raw === '') return null;
      if (!ORIENTATIONS.has(raw.toUpperCase())) return 'invalid';
      unit.orientation = raw.toUpperCase() as OrientationValue;
      return null;
    case 'priceCents': {
      const cents = priceToCents(raw);
      if (cents === undefined) return 'invalid';
      unit.priceCents = cents;
      return null;
    }
    default: {
      const n = number(raw, field === 'bedrooms' || field === 'bathrooms' || field === 'floor');
      if (n === undefined || (n !== null && n < (field === 'floor' ? -10 : 0))) return 'invalid';
      unit[field] = n;
      return null;
    }
  }
}

/** Price-list lines from a CSV with `ref` and `price` columns (and optionally `status`). */
export function priceListFromCsv(text: string): { entries: CsvPriceEntry[]; problems: CsvProblem[] } {
  const rows = parseCsv(text).filter((r) => r.some((c) => c !== ''));
  const [header, ...data] = rows;
  const keys = (header ?? []).map(keyOf);
  const refAt = keys.findIndex((k) => k === 'ref' || k === 'reference');
  const priceAt = keys.indexOf('price');
  const statusAt = keys.indexOf('status');
  if (refAt < 0 || priceAt < 0) return { entries: [], problems: [{ line: 1, column: 'file', reason: 'noHeader' }] };
  if (data.length === 0) return { entries: [], problems: [{ line: 1, column: 'file', reason: 'empty' }] };
  if (data.length > MAX_UNITS_PER_DEVELOPMENT) {
    return { entries: [], problems: [{ line: 1, column: 'file', reason: 'tooMany' }] };
  }
  const problems: CsvProblem[] = [];
  const seen = new Set<string>();
  const entries: CsvPriceEntry[] = [];
  data.forEach((cells, i) => {
    const line = i + 2;
    const ref = cells[refAt] ?? '';
    const priceCents = priceToCents(cells[priceAt] ?? '');
    const status = statusAt < 0 ? '' : (cells[statusAt] ?? '').toUpperCase();
    if (ref === '' || ref.length > 40) problems.push({ line, column: header?.[refAt] ?? 'ref', reason: 'required' });
    else if (seen.has(ref)) problems.push({ line, column: header?.[refAt] ?? 'ref', reason: 'duplicate' });
    if (priceCents === undefined) problems.push({ line, column: header?.[priceAt] ?? 'price', reason: 'invalid' });
    if (status !== '' && !STATUSES.has(status)) {
      problems.push({ line, column: header?.[statusAt] ?? 'status', reason: 'invalid' });
    }
    seen.add(ref);
    if (ref !== '' && priceCents !== undefined) {
      entries.push({ ref, priceCents, ...(status ? { status: status as UnitStatusValue } : {}) });
    }
  });
  return problems.length > 0 ? { entries: [], problems } : { entries, problems };
}
