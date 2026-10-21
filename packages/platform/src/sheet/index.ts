import { isUtf8 } from 'node:buffer';
import { Readable } from 'node:stream';
import { TextDecoder } from 'node:util';
import { createInflateRaw } from 'node:zlib';
import { SHEET_MAX_COLUMNS, SHEET_MAX_ROWS } from '@inmolink/contracts/values';
import { streamXmlRecords, type XmlElement } from '../xml';

/**
 * @inmolink/platform/sheet — the only reader for untrusted spreadsheets (S6-05): CSV text and XLSX (a zip of XML).
 *
 * `readSheetRows(bytes, options)` yields one row at a time (`{ index, cells }`, `index` 0-based like the row number
 * in the spreadsheet minus one), so nothing but the row being built and one decoded chunk sits in memory beside the
 * file itself. Every bound is a `SheetError`:
 *  - the file kind comes from its first bytes (`PK\x03\x04` zip, text otherwise), never from a name or a header;
 *    binaries, HTML/XML/scripts, legacy `.xls` and password-protected workbooks (an OLE container) are refused;
 *  - XLSX: the zip's central directory is read here (no archive library, nothing is ever written to disk, entry
 *    names are only looked up, never used as paths); an entry is inflated through a counter that stops at its cap, so
 *    a zip bomb (declared or real) ends in `ZIP_BOMB`, zip64 and encrypted entries are refused; XML goes through
 *    `platform/xml` (no DTD, no entities); formulas (`<f>`) are never evaluated — the cached value (`<v>`) is read;
 *  - rows, columns and the size of one cell are capped (`SHEET_LIMITS`).
 * Text of a cell is data: a leading `=`, `+`, `-` or `@` is kept as the user wrote it and never interpreted.
 */

export const SHEET_LIMITS = {
  /** Rows with a value (the header included). */
  maxRows: SHEET_MAX_ROWS,
  maxColumns: SHEET_MAX_COLUMNS,
  maxCellChars: 50_000,
  /** Inflated size of the worksheet and of the shared strings, each. */
  maxEntryBytes: 200 * 1024 * 1024,
  /** Shared strings are held in memory for the whole run: their own, smaller caps. */
  maxSharedStringsBytes: 64 * 1024 * 1024,
  maxSharedStringChars: 32 * 1024 * 1024,
  maxSharedStrings: 2_000_000,
  /** A preview inside a request: worksheet bytes inflated, rows looked at (empty ones included), strings read. */
  previewSheetBytes: 16 * 1024 * 1024,
  previewScanRows: 2_000,
  previewStringsBytes: 8 * 1024 * 1024,
  /** Declared inflated size of the whole archive. */
  maxArchiveBytes: 400 * 1024 * 1024,
  maxEntries: 2_000,
} as const;

export type SheetErrorCode =
  | 'EMPTY'
  | 'NOT_SHEET'
  | 'NOT_TEXT'
  | 'UNSUPPORTED_XLS'
  | 'ENCRYPTED'
  | 'BAD_ZIP'
  | 'ZIP_BOMB'
  | 'NO_SHEET'
  | 'MALFORMED'
  | 'TOO_MANY_ROWS'
  | 'TOO_MANY_COLUMNS'
  | 'CELL_TOO_LARGE';

export class SheetError extends Error {
  override readonly name = 'SheetError';
  constructor(
    readonly code: SheetErrorCode,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export function isSheetError(err: unknown): err is SheetError {
  return err instanceof SheetError;
}

export type SheetKind = 'csv' | 'xlsx';

export interface SheetRow {
  /** 0-based position in the file: the spreadsheet's row number minus one (a CSV record counts blank lines too). */
  index: number;
  /** Cell texts from the first column to the last one with a value; '' for gaps. Never longer than `maxColumns`. */
  cells: string[];
}

export interface SheetReadOptions {
  /** Stop quietly after this many rows with a value (a preview). Without it `maxRows` is a hard limit. */
  stopAfter?: number;
}

// ── Kind detection ─────────────────────────────────────────────────────────────────────────────────────────────

/** Decides csv / xlsx from the first bytes; throws for anything else. */
export function detectSheetKind(bytes: Uint8Array): SheetKind {
  if (bytes.length === 0) throw new SheetError('EMPTY');
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return 'xlsx';
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    throw new SheetError('UNSUPPORTED_XLS', 'an old .xls file or a password-protected workbook');
  }
  const wide = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff);
  const head = bytes.subarray(0, 8_192);
  if (!wide) {
    for (const b of head) {
      // NUL and other control characters (tab, line feeds and form feed excepted) mean a binary, not text.
      if (b === 0 || (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x0c))
        throw new SheetError('NOT_TEXT');
    }
    const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
    // Markup or script (an HTML page, an XML feed, a `<?php`), a PDF: not a table.
    const first = Buffer.from(bytes.subarray(start, start + 16))
      .toString('latin1')
      .trimStart();
    if (first.startsWith('<') || first.startsWith('%PDF') || first.startsWith('#!')) throw new SheetError('NOT_SHEET');
  }
  return 'csv';
}

// ── CSV ────────────────────────────────────────────────────────────────────────────────────────────────────────

function decoderFor(bytes: Uint8Array): { decoder: TextDecoder; skip: number } {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { decoder: new TextDecoder('utf-16le'), skip: 2 };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { decoder: new TextDecoder('utf-16be'), skip: 2 };
  const skip = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  // Spanish Excel saves "CSV" as Windows-1252 unless told otherwise: anything that is not valid UTF-8 is read as that.
  return { decoder: new TextDecoder(isUtf8(bytes) ? 'utf-8' : 'windows-1252'), skip };
}

const DELIMITERS = [',', ';', '\t', '|'] as const;

/** Picks the delimiter that occurs most (outside quotes) on the first line; a comma when there is none. */
function delimiterOf(firstText: string): string {
  const counts = new Map<string, number>(DELIMITERS.map((d) => [d, 0]));
  let quoted = false;
  for (const c of firstText) {
    if (c === '"') quoted = !quoted;
    else if (!quoted && (c === '\n' || c === '\r')) break;
    else if (!quoted && counts.has(c)) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  let best = ',';
  let max = 0;
  for (const [d, n] of counts) {
    if (n > max) {
      best = d;
      max = n;
    }
  }
  return best;
}

const CHUNK = 256 * 1024;

function* csvRows(bytes: Uint8Array, options: SheetReadOptions): Generator<SheetRow> {
  const { decoder, skip } = decoderFor(bytes);
  const stopAfter = options.stopAfter ?? Number.POSITIVE_INFINITY;
  let delimiter: string | undefined;
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let afterQuote = false; // the closing quote of a field was just read
  let started = false; // the current row has any character
  let index = 0;
  let emitted = 0;
  let sawCr = false;

  const addCell = () => {
    if (cells.length >= SHEET_LIMITS.maxColumns && cell !== '') throw new SheetError('TOO_MANY_COLUMNS');
    if (cells.length < SHEET_LIMITS.maxColumns) cells.push(cell);
    cell = '';
  };
  /** Ends the row: undefined when blank (no cell has a value). */
  const endRow = (): SheetRow | undefined => {
    addCell();
    const row = cells;
    cells = [];
    started = false;
    afterQuote = false;
    const at = index++;
    let last = row.length - 1;
    while (last >= 0 && row[last]?.trim() === '') last--;
    if (last < 0) return undefined;
    if (emitted >= SHEET_LIMITS.maxRows && emitted < stopAfter) throw new SheetError('TOO_MANY_ROWS');
    emitted++;
    return { index: at, cells: row.slice(0, last + 1) };
  };

  let quotePending = false; // a quote was read inside a quoted field: doubled (a literal quote) or the closing one

  for (let offset = skip; offset <= bytes.length; offset += CHUNK) {
    const last = offset + CHUNK >= bytes.length;
    const text = decoder.decode(bytes.subarray(offset, Math.min(bytes.length, offset + CHUNK)), { stream: !last });
    delimiter ??= delimiterOf(text);
    for (let i = 0; i < text.length; i++) {
      const c = text[i] as string;
      if (cell.length > SHEET_LIMITS.maxCellChars) throw new SheetError('CELL_TOO_LARGE');
      if (quotePending) {
        quotePending = false;
        if (c === '"') {
          cell += '"';
          continue;
        }
        quoted = false;
        afterQuote = true;
      }
      if (sawCr) {
        sawCr = false;
        if (c === '\n') continue; // the second half of CRLF
      }
      if (quoted) {
        if (c === '"') quotePending = true;
        else cell += c;
        continue;
      }
      if (c === '"' && cell === '' && !afterQuote) {
        quoted = true;
        started = true;
      } else if (c === delimiter) {
        addCell();
        afterQuote = false;
        started = true;
      } else if (c === '\n' || c === '\r') {
        if (c === '\r') sawCr = true;
        const row = endRow();
        if (row) {
          yield row;
          if (emitted >= stopAfter) return;
        }
      } else {
        cell += c;
        started = true;
        afterQuote = false;
      }
    }
  }
  if (started || cell !== '' || cells.length > 0) {
    const row = endRow();
    if (row) yield row;
  }
}

// ── XLSX: the zip container ────────────────────────────────────────────────────────────────────────────────────

interface ZipEntry {
  method: number;
  compressedSize: number;
  size: number;
  offset: number;
}

/** The central directory of a zip: entry name → where its data is. No zip64, no encryption. */
function readZip(bytes: Uint8Array): Map<string, ZipEntry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bad = (why: string) => new SheetError('BAD_ZIP', why);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65_535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw bad('no end of central directory');
  const count = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw bad('zip64 is not supported');
  if (count > SHEET_LIMITS.maxEntries) throw new SheetError('ZIP_BOMB', 'too many entries');
  if (cdOffset + cdSize > bytes.length) throw bad('central directory out of range');
  const entries = new Map<string, ZipEntry>();
  let p = cdOffset;
  let declared = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== 0x02014b50) throw bad('bad central directory entry');
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLength = view.getUint16(p + 28, true);
    const extraLength = view.getUint16(p + 30, true);
    const commentLength = view.getUint16(p + 32, true);
    const offset = view.getUint32(p + 42, true);
    if (p + 46 + nameLength > bytes.length) throw bad('entry name out of range');
    const name = Buffer.from(bytes.subarray(p + 46, p + 46 + nameLength)).toString('utf8');
    if (flags & 1) throw new SheetError('ENCRYPTED');
    if (compressedSize === 0xffffffff || size === 0xffffffff || offset === 0xffffffff)
      throw bad('zip64 is not supported');
    declared += size;
    if (declared > SHEET_LIMITS.maxArchiveBytes) throw new SheetError('ZIP_BOMB', 'declared size too large');
    entries.set(name, { method, compressedSize, size, offset });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** The inflated bytes of an entry in chunks, never more than `max` (declared size and real size both checked). */
async function* entryBytes(bytes: Uint8Array, entry: ZipEntry, max: number): AsyncGenerator<Uint8Array> {
  if (entry.size > max) throw new SheetError('ZIP_BOMB', 'entry too large');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (entry.offset + 30 > bytes.length || view.getUint32(entry.offset, true) !== 0x04034b50) {
    throw new SheetError('BAD_ZIP', 'bad local header');
  }
  const start = entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true);
  const end = start + entry.compressedSize;
  if (end > bytes.length) throw new SheetError('BAD_ZIP', 'entry data out of range');
  const data = bytes.subarray(start, end);
  let total = 0;
  if (entry.method === 0) {
    // Stored: the data is the entry. A stored entry whose data length is not its size (or is over the cap) lies about
    // what it holds and is refused (S7-F1, S6 review L1) — never streamed past the size that was checked.
    if (entry.compressedSize !== entry.size || entry.compressedSize > max) {
      throw new SheetError('ZIP_BOMB', 'stored entry size does not match');
    }
    for (let i = 0; i < data.length; i += CHUNK) yield data.subarray(i, i + CHUNK);
    return;
  }
  if (entry.method !== 8) throw new SheetError('BAD_ZIP', 'unsupported compression');
  const slices: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += 16 * 1024) slices.push(data.subarray(i, i + 16 * 1024));
  const inflate = createInflateRaw();
  const source = Readable.from(slices, { objectMode: false });
  source.pipe(inflate);
  try {
    for await (const chunk of inflate as AsyncIterable<Buffer>) {
      total += chunk.length;
      if (total > max || total > entry.size) throw new SheetError('ZIP_BOMB', 'entry inflates past its size');
      yield chunk;
    }
  } catch (err) {
    if (isSheetError(err)) throw err;
    throw new SheetError('BAD_ZIP', 'the archive is damaged');
  } finally {
    source.destroy();
    inflate.destroy();
  }
  if (total !== entry.size) throw new SheetError('BAD_ZIP', 'entry size does not match');
}

/** Small XML parts (workbook, relationships): bounded and read whole. */
async function xmlPart(
  bytes: Uint8Array,
  zip: Map<string, ZipEntry>,
  name: string,
  record: string,
): Promise<XmlElement[]> {
  const entry = zip.get(name);
  if (!entry) return [];
  const out: XmlElement[] = [];
  for await (const el of xmlRecords(entryBytes(bytes, entry, 5 * 1024 * 1024), record)) out.push(el);
  return out;
}

async function* xmlRecords(source: AsyncIterable<Uint8Array>, record: string): AsyncGenerator<XmlElement> {
  try {
    yield* streamXmlRecords(source, { recordElement: record, maxRecordBytes: SHEET_LIMITS.maxCellChars * 4 });
  } catch (err) {
    if (isSheetError(err)) throw err;
    throw new SheetError('MALFORMED', 'the worksheet XML is not valid');
  }
}

// ── XLSX: shared strings and cells ─────────────────────────────────────────────────────────────────────────────

/** The text of a `<si>` / `<is>`: its `<t>` and the `<t>` of its runs — phonetic runs (`rPh`) left out. */
function richText(el: XmlElement): string {
  let out = '';
  for (const child of el.children) {
    if (child.name === 't') out += child.text;
    else if (child.name === 'r')
      out += child.children
        .filter((c) => c.name === 't')
        .map((c) => c.text)
        .join('');
  }
  return out;
}

/** Shared strings in index order; with `upTo` it stops once that index is read (a preview needs a few). */
async function sharedStrings(
  bytes: Uint8Array,
  zip: Map<string, ZipEntry>,
  upTo = Number.POSITIVE_INFINITY,
  maxBytes: number = SHEET_LIMITS.maxSharedStringsBytes,
) {
  const entry = zip.get('xl/sharedStrings.xml');
  const strings: string[] = [];
  if (!entry || upTo < 0) return strings;
  const source = entryBytes(bytes, entry, maxBytes);
  let chars = 0;
  for await (const si of xmlRecords(source, 'si')) {
    const text = richText(si);
    if (text.length > SHEET_LIMITS.maxCellChars) throw new SheetError('CELL_TOO_LARGE');
    // The table lives in memory for the whole run: bounded by characters and by entries.
    chars += text.length;
    if (chars > SHEET_LIMITS.maxSharedStringChars || strings.length >= SHEET_LIMITS.maxSharedStrings) {
      throw new SheetError('ZIP_BOMB', 'shared strings too large');
    }
    strings.push(text);
    if (strings.length > upTo) break;
  }
  return strings;
}

/** `1250.5000000000002` → `1250.5`: Excel stores 17 significant digits; a price must not show the noise. */
function numberText(raw: string): string {
  const t = raw.trim();
  // Bounded and linear: a long run of digits is text, not a number (no backtracking on hostile input).
  if (t.length > 40 || !/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(t)) return t;
  const n = Number(t);
  if (!Number.isFinite(n)) return t;
  const rounded = Number(n.toPrecision(15));
  const s = String(rounded);
  return /e/i.test(s) ? rounded.toFixed(12).replace(/\.?0+$/, '') : s;
}

/** `B7` → 1; `AA1` → 26. */
function columnOf(ref: string | undefined): number | undefined {
  const m = /^([A-Z]{1,3})\d*$/i.exec(ref ?? '');
  if (!m) return undefined;
  let n = 0;
  for (const ch of (m[1] as string).toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

interface RawCell {
  col: number;
  /** A shared string index (resolved later) or the text itself. */
  shared: boolean;
  value: string;
}
interface RawRow {
  index: number;
  cells: RawCell[];
}

/** The worksheet's rows with their cells as written; the cached value of a formula (`<v>`) stands for the formula. */
async function* rawRows(
  bytes: Uint8Array,
  zip: Map<string, ZipEntry>,
  sheetPath: string,
  preview = false,
): AsyncGenerator<RawRow> {
  const entry = zip.get(sheetPath);
  if (!entry) throw new SheetError('NO_SHEET');
  let sequential = 0;
  let scanned = 0;
  const max = preview ? SHEET_LIMITS.previewSheetBytes : SHEET_LIMITS.maxEntryBytes;
  for await (const row of xmlRecords(entryBytes(bytes, entry, max), 'row')) {
    // A preview gives up on a sheet of empty rows instead of reading all of it.
    if (preview && ++scanned > SHEET_LIMITS.previewScanRows) return;
    const declared = Number(row.attributes.r);
    const index = Number.isInteger(declared) && declared > 0 ? declared - 1 : sequential;
    sequential = index + 1;
    const cells: RawCell[] = [];
    let next = 0;
    for (const c of row.children) {
      if (c.name !== 'c') continue;
      const col = columnOf(c.attributes.r) ?? next;
      next = col + 1;
      const type = c.attributes.t ?? 'n';
      const v = c.children.find((x) => x.name === 'v');
      const inline = c.children.find((x) => x.name === 'is');
      let value: string;
      let shared = false;
      if (type === 'inlineStr') value = inline ? richText(inline) : (v?.text ?? '');
      else if (!v) continue;
      else if (type === 's') {
        shared = true;
        value = v.text.trim();
      } else if (type === 'b') value = v.text.trim() === '1' ? 'TRUE' : 'FALSE';
      else if (type === 'str' || type === 'e' || type === 'd') value = v.text;
      else value = numberText(v.text);
      if (value === '') continue;
      if (col >= SHEET_LIMITS.maxColumns) throw new SheetError('TOO_MANY_COLUMNS');
      if (value.length > SHEET_LIMITS.maxCellChars) throw new SheetError('CELL_TOO_LARGE');
      cells.push({ col, shared, value });
    }
    if (cells.length > 0) yield { index, cells };
  }
}

/** First visible worksheet: workbook order, its relationship target. */
async function firstSheetPath(bytes: Uint8Array, zip: Map<string, ZipEntry>): Promise<string> {
  if (!zip.has('xl/workbook.xml')) throw new SheetError('NOT_SHEET', 'not a spreadsheet workbook');
  const sheets = await xmlPart(bytes, zip, 'xl/workbook.xml', 'sheet');
  const visible = sheets.find((s) => !s.attributes.state || s.attributes.state === 'visible');
  const rid = visible?.attributes['r:id'];
  if (!visible || !rid) throw new SheetError('NO_SHEET');
  const rels = await xmlPart(bytes, zip, 'xl/_rels/workbook.xml.rels', 'Relationship');
  const target = rels.find((r) => r.attributes.Id === rid)?.attributes.Target;
  if (!target) throw new SheetError('NO_SHEET');
  const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
  return path.replace(/\/\.\//g, '/');
}

async function* xlsxRows(bytes: Uint8Array, options: SheetReadOptions): AsyncGenerator<SheetRow> {
  const zip = readZip(bytes);
  const sheetPath = await firstSheetPath(bytes, zip);
  const stopAfter = options.stopAfter ?? Number.POSITIVE_INFINITY;
  const toRow = (raw: RawRow, strings: readonly string[]): SheetRow => {
    const cells: string[] = [];
    for (const c of raw.cells) {
      while (cells.length < c.col) cells.push('');
      cells[c.col] = c.shared ? (strings[Number(c.value)] ?? '') : c.value;
    }
    return { index: raw.index, cells };
  };
  let emitted = 0;
  const guard = () => {
    if (emitted >= SHEET_LIMITS.maxRows && emitted < stopAfter) throw new SheetError('TOO_MANY_ROWS');
  };
  if (Number.isFinite(stopAfter)) {
    // A preview: read the first rows, then only as many shared strings as they point to.
    const raw: RawRow[] = [];
    let highest = -1;
    for await (const row of rawRows(bytes, zip, sheetPath, true)) {
      raw.push(row);
      for (const c of row.cells) if (c.shared && Number(c.value) > highest) highest = Number(c.value);
      if (raw.length >= stopAfter) break;
    }
    // An index far beyond what the rows could use is not read for (a preview must stay small).
    const strings = await sharedStrings(
      bytes,
      zip,
      Math.min(highest, stopAfter * SHEET_LIMITS.maxColumns),
      SHEET_LIMITS.previewStringsBytes,
    );
    for (const row of raw) yield toRow(row, strings);
    return;
  }
  const strings = await sharedStrings(bytes, zip);
  for await (const row of rawRows(bytes, zip, sheetPath)) {
    guard();
    emitted++;
    yield toRow(row, strings);
  }
}

// ── Entry point ────────────────────────────────────────────────────────────────────────────────────────────────

/** Rows of a CSV or XLSX file, kind detected from the bytes (see the module comment for the bounds). */
export async function* readSheetRows(bytes: Uint8Array, options: SheetReadOptions = {}): AsyncGenerator<SheetRow> {
  const kind = detectSheetKind(bytes);
  if (kind === 'csv') yield* csvRows(bytes, options);
  else yield* xlsxRows(bytes, options);
}
