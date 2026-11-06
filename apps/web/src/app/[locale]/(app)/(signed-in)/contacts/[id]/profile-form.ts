import {
  CLIENT_PROFILE_FREQUENCIES,
  CLIENT_PROFILE_MODES,
  type ClientProfileDto,
  CreateClientProfileBody,
  TRANSACTION_TYPES,
} from '@inmolink/contracts';
import { z } from 'zod';

/**
 * The client profile form (R2-02d) as a `CreateClientProfileBody`: the posted fields parsed (euros → cents, empty →
 * unset), then the contract's own schema — the API checks everything again. Pure (no session, no fetch): unit-tested.
 */

const UUID = z.uuid();

/** Whole euros to cents; undefined when empty, null when invalid (as `server/actions` `cents`, without its imports). */
const cents = (v: string): number | undefined | null => {
  if (!v) return undefined;
  return /^\d{1,12}$/.test(v) ? Number(v) * 100 : null;
};

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

/** Whole numbers up to `max` digits; undefined when empty, null when invalid. */
const whole = (v: string, digits: number): number | undefined | null => {
  if (!v) return undefined;
  return new RegExp(`^\\d{1,${digits}}$`).test(v) ? Number(v) : null;
};

/** Square metres with up to 2 decimals; undefined when empty, null when invalid. */
const area = (v: string): number | undefined | null => {
  if (!v) return undefined;
  return /^\d{1,7}([.,]\d{1,2})?$/.test(v) ? Number(v.replace(',', '.')) : null;
};

/** The posted ids of a multi-select or checkbox group, or null when one is not an id. */
const ids = (form: FormData, name: string): string[] | null => {
  const all = form.getAll(name).filter((v): v is string => typeof v === 'string' && v !== '');
  return all.every((v) => UUID.safeParse(v).success) ? [...new Set(all)] : null;
};

export type ParsedProfile = { ok: true; body: z.output<typeof CreateClientProfileBody> } | { ok: false };

export function parseProfileForm(form: FormData): ParsedProfile {
  const mode = text(form, 'mode');
  const frequency = text(form, 'frequency');
  const transactionType = text(form, 'transactionType');
  const [priceMin, priceMax] = [cents(text(form, 'priceMin')), cents(text(form, 'priceMax'))];
  const [beds, baths] = [whole(text(form, 'bedsMin'), 2), whole(text(form, 'bathsMin'), 2)];
  const [areaMin, areaMax] = [area(text(form, 'areaMin')), area(text(form, 'areaMax'))];
  const [types, places, features] = [ids(form, 'propertyTypeIds'), ids(form, 'locationIds'), ids(form, 'featureIds')];
  if (
    !CLIENT_PROFILE_MODES.includes(mode as never) ||
    !CLIENT_PROFILE_FREQUENCIES.includes(frequency as never) ||
    (transactionType !== '' && !TRANSACTION_TYPES.includes(transactionType as never)) ||
    [priceMin, priceMax, beds, baths, areaMin, areaMax].some((v) => v === null) ||
    types === null ||
    places === null ||
    features === null
  ) {
    return { ok: false };
  }
  const wishes = text(form, 'wishes');
  const parsed = CreateClientProfileBody.safeParse({
    mode,
    frequency,
    transactionType: transactionType || null,
    propertyTypeIds: types,
    locationIds: places,
    featureIds: features,
    priceMinCents: priceMin ?? null,
    priceMaxCents: priceMax ?? null,
    bedsMin: beds ?? null,
    bathsMin: baths ?? null,
    areaMinM2: areaMin ?? null,
    areaMaxM2: areaMax ?? null,
    wishes: wishes || null,
  });
  return parsed.success ? { ok: true, body: parsed.data } : { ok: false };
}

/** The version an edit form was opened at (a whole number ≥ 1), or null. */
export function parseVersion(form: FormData): number | null {
  const v = whole(text(form, 'version'), 9);
  return typeof v === 'number' && v >= 1 ? v : null;
}

/** A profile's values as the form shows them (euros, not cents). */
export function profileFormValues(p: ClientProfileDto | null) {
  const euros = (c: number | null) => (c === null ? '' : String(Math.round(c / 100)));
  const n = (v: number | null) => (v === null ? '' : String(v));
  return {
    mode: p?.mode ?? 'REVIEW',
    frequency: p?.frequency ?? 'DAILY',
    transactionType: p?.transactionType ?? '',
    propertyTypeIds: p?.propertyTypeIds ?? [],
    locationIds: p?.locationIds ?? [],
    featureIds: p?.featureIds ?? [],
    priceMin: euros(p?.priceMinCents ?? null),
    priceMax: euros(p?.priceMaxCents ?? null),
    bedsMin: n(p?.bedsMin ?? null),
    bathsMin: n(p?.bathsMin ?? null),
    areaMin: n(p?.areaMinM2 ?? null),
    areaMax: n(p?.areaMaxM2 ?? null),
    wishes: p?.wishes ?? '',
  };
}
