import type { CsvProblem } from '@inmolink/contracts/developments-csv';

/**
 * Reading the developer's CSV files in the browser (S4-03). Parsing and the unit and price rules live in
 * `@inmolink/contracts/developments-csv` (S5-F3), shared with the imports.
 */
export {
  type CsvPriceEntry,
  type CsvProblem,
  type CsvUnit,
  priceListFromCsv,
  priceToCents,
  type UnitStatusValue,
  unitsFromCsv,
} from '@inmolink/contracts/developments-csv';

/** Bigger files are refused before they are read (S5-F1): 2,000 units fit in far less. */
export const CSV_MAX_BYTES = 2 * 1024 * 1024;

/** The file-level problem of a file over `CSV_MAX_BYTES`, or null: check before `file.text()`. */
export function csvSizeProblem(sizeBytes: number): CsvProblem | null {
  return sizeBytes > CSV_MAX_BYTES ? { line: 1, column: 'file', reason: 'tooLarge' } : null;
}
