/**
 * Small value readers shared by the format connectors (Kyero, Resales, Milenio+, Infocasa, Inmoba, thinkSPAIN). Pure.
 * They read feed text strictly: a value that is not in the expected shape is "not given" (null) or refused by the
 * caller, never guessed.
 */

/** `1234.5` → 123450; thousands separators and other shapes are refused (null), never guessed. */
export function priceToCents(text: string): number | null {
  const m = /^(\d{1,12})(?:\.(\d{1,2})0*)?$/.exec(text.trim());
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || 0);
}

/**
 * A price as Spanish CRMs write it: `1250000`, `1250000.50`, `1250000,50`, `1.250.000` or `1.250.000,50`. A point is a
 * thousands separator only when exactly three digits follow every one of them; anything else (`1,250,000`, `12.5.0`)
 * is refused (null).
 */
export function localizedPriceToCents(text: string): number | null {
  if (text.length > 64) return null;
  const t = text
    .trim()
    .replace(/(?:€|eur)$/i, '')
    .trimEnd();
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(t)) return priceToCents(t.replaceAll('.', '').replace(',', '.'));
  if (/^\d{1,12},\d{1,2}$/.test(t)) return priceToCents(t.replace(',', '.'));
  return priceToCents(t);
}

export function decimal(text: string | undefined): number | null {
  if (!text) return null;
  const t = text.trim().replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** An area: zero ("not given") is no area. */
export function positive(text: string | undefined): number | null {
  const n = decimal(text);
  return n !== null && n > 0 ? n : null;
}

export function integer(text: string | undefined): number | null {
  const n = decimal(text);
  return n !== null && Number.isInteger(n) && n >= 0 ? n : null;
}

/** A year of construction: 1000-3000, else not given. */
export function year(text: string | undefined): number | null {
  const n = integer(text);
  return n !== null && n >= 1000 && n <= 3000 ? n : null;
}

export const truthy = (text: string | undefined) => text !== undefined && /^(1|true|yes|y|si|sí|s)$/i.test(text.trim());

export type EnergyRating = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'EXEMPT' | 'PENDING';
const RATINGS = new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G']);
export function rating(text: string | undefined): EnergyRating | null {
  if (!text) return null;
  const t = text.trim().toUpperCase();
  if (RATINGS.has(t)) return t as 'A';
  if (t === 'EXEMPT' || t === 'EXENTO') return 'EXEMPT';
  if (t === 'IN_PROGRESS' || t === 'PENDING' || t === 'EN TRAMITE' || t === 'EN TRÁMITE') return 'PENDING';
  return null;
}

export const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n).trimEnd());

/** A decimal in Spanish notation (`1.500`, `1.500,5`, `85,5`): a point is a thousands separator only before three digits. */
export function localizedDecimal(text: string | undefined): number | null {
  if (!text || text.length > 32) return null;
  const t = text.trim();
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) return decimal(t.replaceAll('.', '').replace(',', '.'));
  return decimal(t);
}

/** An area in Spanish notation: zero ("not given") is no area. */
export function localizedPositive(text: string | undefined): number | null {
  const n = localizedDecimal(text);
  return n !== null && n > 0 ? n : null;
}
