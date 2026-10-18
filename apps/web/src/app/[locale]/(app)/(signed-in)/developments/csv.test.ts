import { describe, expect, it } from 'vitest';
import { CSV_MAX_BYTES, csvSizeProblem } from './csv';

describe('development CSV files', () => {
  it('[S5-F1] refuses unit and price-list CSVs over 2 MB before reading them', () => {
    expect(CSV_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(csvSizeProblem(CSV_MAX_BYTES)).toBeNull();
    expect(csvSizeProblem(CSV_MAX_BYTES + 1)).toEqual({ line: 1, column: 'file', reason: 'tooLarge' });
  });
});
