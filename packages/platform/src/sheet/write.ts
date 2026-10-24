import { constants, crc32, deflateRawSync } from 'node:zlib';

/**
 * Streaming writers for exported tables (S10-08 data export): CSV, XLSX and the ZIP container both XLSX and the
 * account archive are made of. Each writes into an async `ByteSink` (an object upload's `write`) as it goes: memory
 * holds one buffered chunk (`FLUSH_BYTES`) and its compressed form, never the file. No archive library: the ZIP is
 * written here (deflate, data descriptors, UTF-8 names; no zip64 — an entry or archive past 4 GiB is refused).
 *
 * Text cells are data, never formulas (formula injection, OWASP "CSV injection"). `isFormulaLike`: text a spreadsheet
 * would read as a formula or a DDE call — a leading `=`, `+`, `-` or `@` (also after leading whitespace, and their
 * full-width, small and minus-sign forms), or a leading tab, carriage return or line feed.
 *  - CSV: such a cell gets a leading `'` (`escapeFormula`), and every cell holding a delimiter a spreadsheet may split
 *    on (`,` `;` tab), a quote or a line break is quoted — a Spanish Excel splits on `;`, so `a;=1+1` stays one quoted
 *    cell, never a second cell starting with `=`.
 *  - XLSX: text is an inline string (`t="inlineStr"`), never a formula element, and a formula-like one is shown as
 *    text by a `quotePrefix` style with its value unchanged (a phone `+34…` stays `+34…`).
 * Dates: ISO 8601 in CSV; date-time serial numbers (UTC) with a date format in XLSX.
 */

export type ByteSink = (chunk: Uint8Array) => Promise<void>;

export type ExportCell = string | number | boolean | Date | null | undefined;

/** A table writer: one header, then rows; `finish` writes what is buffered (and the container's directory). */
export interface TableWriter {
  row(cells: readonly ExportCell[]): Promise<void>;
  finish(): Promise<void>;
}

export class ExportTooLargeError extends Error {
  override readonly name = 'ExportTooLargeError';
}

/** Uncompressed bytes gathered before a chunk is deflated / handed to the sink. */
const FLUSH_BYTES = 256 * 1024;
const ZIP_MAX = 0xffff_ffff;

const RISKY = /^(?:[\t\r\n]|[\s 　]*[=+\-@＝＋－＠﹢﹣−])/u;

/** Whether a spreadsheet would evaluate this text (a formula or a DDE call). */
export function isFormulaLike(text: string): boolean {
  return RISKY.test(text);
}

/** CSV: text a spreadsheet would evaluate gets a leading `'` (shown as text, never run). Other text is unchanged. */
export function escapeFormula(text: string): string {
  return RISKY.test(text) ? `'${text}` : text;
}

const encoder = new TextEncoder();

// ── ZIP ────────────────────────────────────────────────────────────────────────────────────────────────────────

interface EntryRecord {
  name: Uint8Array;
  /** 0 stored, 8 deflated. */
  method: 0 | 8;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
}

/** DOS date and time of `d` (UTC), as a ZIP header holds them. */
function dosTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getUTCFullYear());
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

/**
 * A ZIP archive written entry by entry into a sink. Each entry is deflated in independent chunks (each flushed to a
 * byte boundary, `Z_SYNC_FLUSH`, the last one finished): a valid deflate stream that never holds more than one chunk.
 * Sizes and CRC follow the data (general purpose bit 3, a data descriptor) and are repeated in the central directory.
 */
export class ZipWriter {
  readonly #entries: EntryRecord[] = [];
  readonly #stamp: { time: number; date: number };
  #offset = 0;
  #current: EntryRecord | null = null;
  #pending: Buffer[] = [];
  #pendingBytes = 0;
  #finished = false;

  constructor(
    private readonly sink: ByteSink,
    options: { now?: Date } = {},
  ) {
    this.#stamp = dosTime(options.now ?? new Date());
  }

  /** Bytes handed to the sink so far. */
  get bytes(): number {
    return this.#offset;
  }

  async #emit(chunk: Uint8Array): Promise<void> {
    if (chunk.length === 0) return;
    if (this.#offset + chunk.length > ZIP_MAX) throw new ExportTooLargeError('zip: archive past 4 GiB');
    this.#offset += chunk.length;
    await this.sink(chunk);
  }

  /**
   * Starts an entry (the previous one must be ended). Names are relative paths written by the caller, never input.
   * `store`: kept as is, not deflated again (an entry that is itself compressed, e.g. a workbook).
   */
  async begin(name: string, options: { store?: boolean } = {}): Promise<void> {
    if (this.#current || this.#finished) throw new Error('zip: an entry is open or the archive is finished');
    if (this.#entries.length >= 0xffff) throw new ExportTooLargeError('zip: too many entries');
    const nameBytes = encoder.encode(name);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0808, 6); // data descriptor + UTF-8 names
    const method = options.store ? 0 : 8;
    header.writeUInt16LE(method, 8); // stored or deflated
    header.writeUInt16LE(this.#stamp.time, 10);
    header.writeUInt16LE(this.#stamp.date, 12);
    header.writeUInt16LE(nameBytes.length, 26);
    this.#current = { name: nameBytes, method, crc: 0, compressed: 0, size: 0, offset: this.#offset };
    await this.#emit(header);
    await this.#emit(nameBytes);
  }

  /** Adds data to the open entry. */
  async write(data: Uint8Array | string): Promise<void> {
    const entry = this.#current;
    if (!entry) throw new Error('zip: no open entry');
    // A copy: the caller may reuse its buffer once `write` returns, while this chunk still waits in `#pending`.
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    if (bytes.length === 0) return;
    entry.crc = crc32(bytes, entry.crc);
    entry.size += bytes.length;
    if (entry.size > ZIP_MAX) throw new ExportTooLargeError('zip: entry past 4 GiB');
    this.#pending.push(bytes);
    this.#pendingBytes += bytes.length;
    if (this.#pendingBytes >= FLUSH_BYTES) await this.#deflate(false);
  }

  async #deflate(last: boolean): Promise<void> {
    const entry = this.#current;
    if (!entry) return;
    const input = Buffer.concat(this.#pending, this.#pendingBytes);
    this.#pending = [];
    this.#pendingBytes = 0;
    if (entry.method === 0 && input.length === 0) return;
    const out = entry.method === 0 ? input : deflateRawSync(input, last ? {} : { finishFlush: constants.Z_SYNC_FLUSH });
    entry.compressed += out.length;
    await this.#emit(out);
  }

  /** Ends the open entry: the last deflate chunk and the data descriptor. */
  async end(): Promise<void> {
    const entry = this.#current;
    if (!entry) throw new Error('zip: no open entry');
    await this.#deflate(true);
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(entry.crc >>> 0, 4);
    descriptor.writeUInt32LE(entry.compressed, 8);
    descriptor.writeUInt32LE(entry.size, 12);
    await this.#emit(descriptor);
    this.#entries.push(entry);
    this.#current = null;
  }

  /** A whole small entry (a manifest, a workbook part). */
  async add(name: string, data: Uint8Array | string): Promise<void> {
    await this.begin(name);
    await this.write(data);
    await this.end();
  }

  /** Writes the central directory. Returns the archive's size. */
  async finish(): Promise<{ bytes: number }> {
    if (this.#current) await this.end();
    if (this.#finished) return { bytes: this.#offset };
    this.#finished = true;
    const start = this.#offset;
    const parts: Buffer[] = [];
    for (const e of this.#entries) {
      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0);
      cd.writeUInt16LE(20, 4);
      cd.writeUInt16LE(20, 6);
      cd.writeUInt16LE(0x0808, 8);
      cd.writeUInt16LE(e.method, 10);
      cd.writeUInt16LE(this.#stamp.time, 12);
      cd.writeUInt16LE(this.#stamp.date, 14);
      cd.writeUInt32LE(e.crc >>> 0, 16);
      cd.writeUInt32LE(e.compressed, 20);
      cd.writeUInt32LE(e.size, 24);
      cd.writeUInt16LE(e.name.length, 28);
      cd.writeUInt32LE(e.offset, 42);
      parts.push(cd, Buffer.from(e.name));
    }
    const directory = Buffer.concat(parts);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(this.#entries.length, 8);
    eocd.writeUInt16LE(this.#entries.length, 10);
    eocd.writeUInt32LE(directory.length, 12);
    eocd.writeUInt32LE(start, 16);
    await this.#emit(directory);
    await this.#emit(eocd);
    return { bytes: this.#offset };
  }
}

// ── CSV ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Quoted: a quote, a line break, any delimiter a spreadsheet may split on (`,`, `;` in Spanish Excel, tab). */
const CSV_QUOTE = /[",;\t\r\n]|^\s|\s$/;

function csvField(cell: ExportCell): string {
  if (cell === null || cell === undefined) return '';
  if (typeof cell === 'number') return Number.isFinite(cell) ? String(cell) : '';
  if (typeof cell === 'boolean') return cell ? 'true' : 'false';
  if (cell instanceof Date) return Number.isNaN(cell.getTime()) ? '' : cell.toISOString();
  const text = escapeFormula(cell);
  return CSV_QUOTE.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * RFC 4180 CSV (comma, CRLF, quotes doubled) in UTF-8 with a byte-order mark, so Excel opens accents correctly.
 * Text cells are formula-escaped.
 */
export class CsvWriter implements TableWriter {
  #buffer = '';

  private constructor(private readonly sink: ByteSink) {}

  static async start(sink: ByteSink, header: readonly string[]): Promise<CsvWriter> {
    const writer = new CsvWriter(sink);
    writer.#buffer = '﻿';
    await writer.row(header);
    return writer;
  }

  async row(cells: readonly ExportCell[]): Promise<void> {
    this.#buffer += `${cells.map(csvField).join(',')}\r\n`;
    if (this.#buffer.length >= FLUSH_BYTES) await this.#flush();
  }

  async #flush(): Promise<void> {
    if (this.#buffer.length === 0) return;
    const chunk = Buffer.from(this.#buffer, 'utf8');
    this.#buffer = '';
    await this.sink(chunk);
  }

  async finish(): Promise<void> {
    await this.#flush();
  }
}

// ── XLSX ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Excel's limit on one cell's text. */
export const XLSX_MAX_CELL_CHARS = 32_767;
/** Excel's last row. */
export const XLSX_MAX_ROWS = 1_048_576;
/** `cellXfs` indexes: 1 bold (the header), 2 text shown as typed (`quotePrefix`), 3 date-time. */
const STYLE_TEXT = 2;
const STYLE_DATE = 3;
/** Days from Excel's epoch (1899-12-30, as Excel counts) to the Unix epoch. Times are written in UTC. */
const EXCEL_EPOCH_DAYS = 25_569;

/**
 * Drops what XML 1.0 cannot hold: control characters other than tab and line breaks, lone surrogates, U+FFFE and
 * U+FFFF. Text without any is returned as is.
 */
function xmlClean(text: string): string {
  let out = '';
  let dirty = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    let keep = true;
    if (c < 0x20) keep = c === 0x09 || c === 0x0a || c === 0x0d;
    else if (c === 0xfffe || c === 0xffff) keep = false;
    else if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        if (dirty) out += text.slice(i, i + 2);
        i += 1;
        continue;
      }
      keep = false;
    } else if (c >= 0xdc00 && c <= 0xdfff) keep = false;
    if (!keep && !dirty) {
      out = text.slice(0, i);
      dirty = true;
    } else if (keep && dirty) out += text[i];
  }
  return dirty ? out : text;
}

function xmlText(text: string): string {
  return xmlClean(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function columnName(i: number): string {
  let n = i + 1;
  let out = '';
  while (n > 0) {
    out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function sheetName(name: string): string {
  const clean = name.replace(/[[\]:*?/\\]/g, ' ').trim();
  return xmlText((clean || 'Sheet1').slice(0, 31));
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

/**
 * A one-sheet workbook (Office Open XML) streamed into a sink: the package parts first, then the worksheet row by
 * row. Text cells are inline strings (clipped to Excel's 32,767 characters; formula-like ones styled `quotePrefix`),
 * numbers, booleans and dates typed cells; the header row is bold. Past Excel's 1,048,576 rows the writer refuses (`ExportTooLargeError`).
 */
export class XlsxWriter implements TableWriter {
  readonly #zip: ZipWriter;
  readonly #columns: string[] = [];
  #rows = 0;
  #buffer = '';

  private constructor(sink: ByteSink, now?: Date) {
    this.#zip = new ZipWriter(sink, now ? { now } : {});
  }

  static async start(
    sink: ByteSink,
    header: readonly string[],
    options: { sheetName?: string; now?: Date } = {},
  ): Promise<XlsxWriter> {
    const writer = new XlsxWriter(sink, options.now);
    const zip = writer.#zip;
    await zip.add(
      '[Content_Types].xml',
      `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    );
    await zip.add(
      '_rels/.rels',
      `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    );
    await zip.add(
      'xl/workbook.xml',
      `${XML_HEAD}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><sheets><sheet name="${sheetName(options.sheetName ?? 'Sheet1')}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    );
    await zip.add(
      'xl/_rels/workbook.xml.rels',
      `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    );
    await zip.add(
      'xl/styles.xml',
      `${XML_HEAD}<styleSheet xmlns="${NS_MAIN}"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm:ss"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" quotePrefix="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`,
    );
    await zip.begin('xl/worksheets/sheet1.xml');
    await zip.write(
      `${XML_HEAD}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>`,
    );
    await writer.#row(header, true);
    return writer;
  }

  #column(i: number): string {
    while (this.#columns.length <= i) this.#columns.push(columnName(this.#columns.length));
    return this.#columns[i] as string;
  }

  async #row(cells: readonly ExportCell[], bold: boolean): Promise<void> {
    if (this.#rows >= XLSX_MAX_ROWS) throw new ExportTooLargeError('xlsx: more rows than a worksheet holds');
    this.#rows += 1;
    const r = this.#rows;
    const style = bold ? ' s="1"' : '';
    let xml = `<row r="${r}">`;
    cells.forEach((cell, i) => {
      if (cell === null || cell === undefined || cell === '') return;
      const ref = `${this.#column(i)}${r}`;
      if (typeof cell === 'number') {
        if (Number.isFinite(cell)) xml += `<c r="${ref}"${style}><v>${cell}</v></c>`;
      } else if (typeof cell === 'boolean') {
        xml += `<c r="${ref}"${style} t="b"><v>${cell ? 1 : 0}</v></c>`;
      } else if (cell instanceof Date) {
        const ms = cell.getTime();
        if (!Number.isNaN(ms)) {
          xml += `<c r="${ref}" s="${STYLE_DATE}"><v>${ms / 86_400_000 + EXCEL_EPOCH_DAYS}</v></c>`;
        }
      } else {
        // the value as written; a formula-like one is shown as text by its style (`quotePrefix`), never evaluated
        const text = cell.slice(0, XLSX_MAX_CELL_CHARS);
        const shown = bold ? style : isFormulaLike(text) ? ` s="${STYLE_TEXT}"` : '';
        xml += `<c r="${ref}"${shown} t="inlineStr"><is><t xml:space="preserve">${xmlText(text)}</t></is></c>`;
      }
    });
    this.#buffer += `${xml}</row>`;
    if (this.#buffer.length >= FLUSH_BYTES) await this.#flush();
  }

  async #flush(): Promise<void> {
    if (this.#buffer.length === 0) return;
    const text = this.#buffer;
    this.#buffer = '';
    await this.#zip.write(text);
  }

  async row(cells: readonly ExportCell[]): Promise<void> {
    await this.#row(cells, false);
  }

  async finish(): Promise<void> {
    this.#buffer += '</sheetData></worksheet>';
    await this.#flush();
    await this.#zip.end();
    await this.#zip.finish();
  }
}

/** A table writer of either kind. */
export function startTableWriter(
  format: 'csv' | 'xlsx',
  sink: ByteSink,
  header: readonly string[],
  options: { sheetName?: string; now?: Date } = {},
): Promise<TableWriter> {
  return format === 'csv' ? CsvWriter.start(sink, header) : XlsxWriter.start(sink, header, options);
}
