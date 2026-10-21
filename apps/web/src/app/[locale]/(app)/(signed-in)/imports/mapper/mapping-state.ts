import type { MappedValue, MapperSampleDto, XmlMappingInput } from '@inmolink/contracts';
import { XML_MAPPED_ENUM_FIELDS, XML_MAPPED_FIELDS, type XmlMappedField } from '@inmolink/contracts/values';

/**
 * The mapper's form state (S6-04) and its conversion to a mapping profile. Plain data, no zod: this file ships in
 * the mapper's own chunk. The server validates the result with `XmlMapping` on every call.
 */

/** A select value meaning "a fixed text instead of a path". */
export const CONSTANT = '=';

export interface FieldState {
  /** A path of the sample, `CONSTANT`, or '' (not mapped). */
  source: string;
  constant: string;
  /** `feed value = our value`, one per line (fields with a fixed set of words only). */
  translate: string;
}

export interface ListState {
  path: string;
  separator: string;
}

export interface TranslationState {
  locale: string;
  title: string;
  description: string;
}

export interface MapperState {
  recordElement: string;
  decimalSeparator: 'point' | 'comma';
  fields: Record<XmlMappedField, FieldState>;
  features: ListState;
  images: ListState;
  translations: TranslationState[];
}

const empty = (): FieldState => ({ source: '', constant: '', translate: '' });

/**
 * The state the mapper starts from: the server's guesses (`suggested`, S7-F2: fields, lists, and the first
 * translation's `title` and `description`) for the paths it found. No guessing here — only UI state.
 */
export function initialState(sample: MapperSampleDto, defaultLocale: string): MapperState {
  const fields = Object.fromEntries(XML_MAPPED_FIELDS.map((f) => [f, empty()])) as Record<XmlMappedField, FieldState>;
  for (const f of XML_MAPPED_FIELDS) {
    const path = sample.suggested[f];
    if (path) fields[f] = { ...empty(), source: path };
  }
  return {
    recordElement: sample.recordElement,
    decimalSeparator: 'point',
    fields,
    features: { path: sample.suggested.features ?? '', separator: '' },
    images: { path: sample.suggested.images ?? '', separator: '' },
    translations: [
      { locale: defaultLocale, title: sample.suggested.title ?? '', description: sample.suggested.description ?? '' },
    ],
  };
}

/** `feed = VALUE` lines → a value map; lines without `=` are ignored. */
export function parseTranslate(text: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const from = line.slice(0, i).trim();
    const to = line.slice(i + 1).trim();
    if (from && to) map[from] = to;
  }
  return map;
}

function readField(f: FieldState, enumField: boolean): MappedValue | undefined {
  if (f.source === '') return undefined;
  const map = enumField ? parseTranslate(f.translate) : {};
  const withMap = Object.keys(map).length > 0 ? { map } : {};
  if (f.source === CONSTANT) return f.constant.trim() ? { constant: f.constant.trim(), ...withMap } : undefined;
  return { path: f.source, ...withMap };
}

/** The mapping profile the form describes (what the server validates, previews and saves). */
export function toMapping(state: MapperState): XmlMappingInput {
  const fields: Record<string, MappedValue> = {};
  for (const f of XML_MAPPED_FIELDS) {
    const v = readField(state.fields[f], f in XML_MAPPED_ENUM_FIELDS);
    if (v) fields[f] = v;
  }
  const list = (l: ListState) =>
    l.path ? [{ path: l.path, ...(l.separator.trim() ? { separator: l.separator.trim().slice(0, 3) } : {}) }] : [];
  return {
    schemaVersion: 1,
    recordElement: state.recordElement,
    decimalSeparator: state.decimalSeparator,
    fields: fields as XmlMappingInput['fields'],
    features: list(state.features),
    images: list(state.images),
    translations: state.translations
      .filter((t) => t.locale && (t.title || t.description))
      .map((t) => ({
        locale: t.locale,
        ...(t.title ? { title: { path: t.title } } : {}),
        ...(t.description ? { description: { path: t.description } } : {}),
      })),
  };
}

/** The two fields a mapping cannot do without. */
export const hasRequired = (state: MapperState): boolean =>
  readField(state.fields.ref, false) !== undefined && readField(state.fields.propertyType, false) !== undefined;
