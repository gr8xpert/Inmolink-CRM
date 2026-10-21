import {
  type FeedListingInput,
  SHEET_MAPPED_CONNECTOR,
  SHEET_UPLOAD_MAX_BYTES,
  SHEET_URL_PREFIX,
} from '@inmolink/contracts';
import { readSheetRows, SheetError } from '@inmolink/platform/sheet';
import { storage } from '@inmolink/platform/storage';
import type { XmlElement } from '@inmolink/platform/xml';
import {
  type FeedConnector,
  type FeedRecord,
  type FeedSource,
  feedListingProblems,
  registerConnector,
} from '../connectors';
import { mappingOf } from '../xml-mapped/connector';
import { mapXmlRecord, xmlMappedSettings } from '../xml-mapped/mapping';
import { columnKeys, rowNode } from './columns';

/**
 * The CSV / Excel connector (S6-05): the file the agency uploaded (kept in the private bucket under
 * `imports/sheets/<agency>/<file id>`, the connection's `url` is `upload://<file id>`), read row by row, each row
 * mapped by the connection's profile with the XML mapper's rules and checked against the `FeedListing` contract.
 * The first row is the header. A row's position is its row number in the file minus one (the header is 0), so
 * the run's error list points at the line the user sees in Excel.
 */

/** Where an agency's uploaded sheet lives. */
export const sheetKey = (agencyId: string, fileId: string) => `imports/sheets/${agencyId}/${fileId}`;

const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The file id of a sheet connection's url, or null when it is not one. */
export function sheetFileId(url: string): string | null {
  const id = url.startsWith(SHEET_URL_PREFIX) ? url.slice(SHEET_URL_PREFIX.length) : '';
  return FILE_ID.test(id) ? id.toLowerCase() : null;
}

/** The uploaded file is gone (deleted from storage, or the url is not a sheet's): the run fails, retrying will not help. */
export class SheetFileMissingError extends Error {
  override readonly name = 'SheetFileMissingError';
  constructor() {
    super('the uploaded file is not available');
  }
}

async function* once(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

async function* sheetRecords(source: FeedSource): AsyncGenerator<FeedRecord<XmlElement>> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of source.body) chunks.push(chunk);
  const bytes = chunks.length === 1 ? (chunks[0] as Uint8Array) : Buffer.concat(chunks);
  let keys: string[] | null = null;
  for await (const row of readSheetRows(bytes)) {
    if (!keys) {
      keys = columnKeys(row.cells);
      continue;
    }
    yield { position: row.index, raw: rowNode(keys, row.cells) };
  }
  if (!keys) throw new SheetError('EMPTY');
}

export const sheetMappedConnector: FeedConnector<XmlElement, FeedListingInput> = {
  key: SHEET_MAPPED_CONNECTOR,
  requiresMapping: true,
  fetch: async (ctx) => {
    mappingOf(ctx); // fail before reading the file
    const fileId = sheetFileId(ctx.url);
    if (!fileId) throw new SheetFileMissingError();
    const bytes = await storage().get('private', sheetKey(ctx.agencyId, fileId), { maxBytes: SHEET_UPLOAD_MAX_BYTES });
    if (!bytes) throw new SheetFileMissingError();
    return { body: once(bytes), bytesRead: () => bytes.length, contentType: null };
  },
  parse: (source) => sheetRecords(source),
  map: (raw, ctx) => mapXmlRecord(raw, mappingOf(ctx), xmlMappedSettings(ctx.settings, SHEET_MAPPED_CONNECTOR)),
  validate: (item) => feedListingProblems(item),
};

registerConnector(sheetMappedConnector);
