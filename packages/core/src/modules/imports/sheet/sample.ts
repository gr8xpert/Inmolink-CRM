import { AppError, MAPPER_SAMPLE, type MapperSampleDto, type XmlRecordNode } from '@inmolink/contracts';
import { detectSheetKind, isSheetError, readSheetRows, type SheetKind } from '@inmolink/platform/sheet';
import { collectPaths } from '../xml-mapped/sample';
import { suggestPaths } from '../xml-mapped/suggest';
import { columnKeys, rowNode } from './columns';

/** A sheet problem as the mapper's error: `FEED_SAMPLE_INVALID` with the reason code (the UI has a text per reason). */
export function sheetProblem(err: unknown): unknown {
  return isSheetError(err) ? new AppError('FEED_SAMPLE_INVALID', { reason: err.code }) : err;
}

/**
 * The sample of an uploaded file for the mapper: the kind by its first bytes, the header row, the first
 * `MAPPER_SAMPLE.maxRecords` data rows as records and every column with a value (the same `MapperSampleDto` the
 * XML mapper uses; `recordElement` is `row`, a path is a column key). Bounded: only the first rows are read.
 */
export async function analyzeSheet(bytes: Uint8Array): Promise<{ kind: SheetKind; sample: MapperSampleDto }> {
  try {
    const kind = detectSheetKind(bytes);
    let keys: string[] | null = null;
    const nodes: XmlRecordNode[] = [];
    for await (const row of readSheetRows(bytes, { stopAfter: 1 + MAPPER_SAMPLE.maxRecords })) {
      if (!keys) {
        keys = columnKeys(row.cells);
        continue;
      }
      // Preview cells are clipped (the browser sends the records back); a run reads them whole.
      nodes.push(rowNode(keys, row.cells, 1_000) as XmlRecordNode);
    }
    if (!keys || nodes.length === 0) throw new AppError('FEED_SAMPLE_INVALID', { reason: 'NO_RECORDS' });
    const paths = collectPaths(nodes);
    return {
      kind,
      sample: {
        recordElement: 'row',
        candidates: [],
        recordCount: nodes.length,
        truncated: false,
        bytes: bytes.length,
        paths,
        suggested: suggestPaths(paths),
        records: nodes,
      },
    };
  } catch (err) {
    throw sheetProblem(err);
  }
}
