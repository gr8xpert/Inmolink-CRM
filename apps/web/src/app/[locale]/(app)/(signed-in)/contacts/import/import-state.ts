import type { ContactImportMapping, StartContactImportInput } from '@inmolink/contracts';

/** A field a column can feed. */
export type ImportField = keyof ContactImportMapping;
/** What each column of the file feeds (`''`: not imported), by column position. */
export type ColumnFields = readonly (ImportField | '')[];

export const IMPORT_FIELDS: readonly ImportField[] = [
  'firstName',
  'lastName',
  'fullName',
  'emails',
  'phones',
  'language',
  'types',
  'tags',
  'note',
  'doNotContact',
  'consentMarketing',
];

/** `emails` and `phones` take several columns (the contract's maximum); every other field takes one. */
const MAX_MULTI_COLUMNS = 5;
const isMulti = (field: ImportField | '') => field === 'emails' || field === 'phones';

/**
 * The columns as the API guessed them from the header names. A marketing consent column is never preselected: a
 * consent only comes from a column the person chose themselves (a header such as "Marketing" says nothing about what
 * the cells mean).
 */
export function columnFieldsFrom(
  suggested: Readonly<Record<string, number | number[]>>,
  columns: number,
): (ImportField | '')[] {
  const out: (ImportField | '')[] = Array.from({ length: columns }, () => '');
  for (const field of IMPORT_FIELDS) {
    if (field === 'consentMarketing') continue;
    const value = suggested[field];
    if (value === undefined) continue;
    for (const column of [value].flat().slice(0, MAX_MULTI_COLUMNS)) {
      if (column >= 0 && column < columns && out[column] === '') out[column] = field;
    }
  }
  return out;
}

/** Sets one column's field; a single-column field leaves any other column it was on. A sixth e-mail column is refused. */
export function setColumnField(fields: ColumnFields, column: number, field: ImportField | ''): ColumnFields {
  if (isMulti(field) && fields.filter((f, i) => f === field && i !== column).length >= MAX_MULTI_COLUMNS) return fields;
  return fields.map((current, i) => {
    if (i === column) return field;
    return field !== '' && !isMulti(field) && current === field ? '' : current;
  });
}

export function hasIdentityColumn(fields: ColumnFields): boolean {
  return fields.some(
    (f) => f === 'firstName' || f === 'lastName' || f === 'fullName' || f === 'emails' || f === 'phones',
  );
}

export function hasConsentColumn(fields: ColumnFields): boolean {
  return fields.includes('consentMarketing');
}

export function toMapping(fields: ColumnFields): StartContactImportInput['mapping'] {
  const mapping: Partial<Record<ImportField, number | number[]>> = { emails: [], phones: [] };
  fields.forEach((field, column) => {
    if (field === '') return;
    if (isMulti(field)) (mapping[field] as number[]).push(column);
    else mapping[field] = column;
  });
  return mapping as StartContactImportInput['mapping'];
}

export interface ImportOptions {
  onDuplicate: 'SKIP' | 'MERGE';
  defaultTypes: string[];
  /** Comma-separated. */
  tags: string;
  phoneCountry: string;
}

/** Duplicates are skipped and no consent is given unless the person changes that. */
export const DEFAULT_IMPORT_OPTIONS: ImportOptions = {
  onDuplicate: 'SKIP',
  defaultTypes: [],
  tags: '',
  phoneCountry: 'ES',
};

/** The body of both the check and the start; the server action validates it with the contract. */
export function toStartInput(fields: ColumnFields, options: ImportOptions): StartContactImportInput {
  return {
    mapping: toMapping(fields),
    onDuplicate: options.onDuplicate,
    defaultTypes: options.defaultTypes as StartContactImportInput['defaultTypes'],
    tags: options.tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
    phoneCountry: options.phoneCountry.trim().toUpperCase(),
  };
}
