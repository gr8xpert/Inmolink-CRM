import { TextDecoder } from 'node:util';
import { SaxesParser, type SaxesTagPlain } from 'saxes';

/**
 * @inmolink/platform/xml — the only XML parser for untrusted input (PLAN §3 #64, PATTERNS §16, security.md).
 *
 * `streamXmlRecords(source, { recordElement })` reads a byte (or string) stream with saxes and yields one plain
 * element tree per `recordElement` (e.g. every `<property>` of a Kyero feed) as soon as it closes, so a 100 MB+
 * feed never sits in memory: only the record being built and one input chunk do.
 *
 * XXE / entity safety: any `<!DOCTYPE` fails the stream (`DOCTYPE_NOT_ALLOWED`) — a document without a DTD cannot
 * declare entities, and saxes never fetches external ones. Undeclared entity references (`&xxe;`) are a
 * well-formedness error (`MALFORMED`); only the five predefined entities and character references are decoded.
 * Bounds: document depth (`maxDepth`), a record's size (`maxRecordBytes`, counted on names, attributes and
 * text) and element count (`maxRecordElements`), and the size of any single token the parser buffers between
 * two events (`maxTokenChars`: a 1 GB text node or comment outside a record cannot grow unchecked).
 */

export interface XmlElement {
  name: string;
  attributes: Record<string, string>;
  /** Text and CDATA directly inside this element, concatenated (untrimmed). */
  text: string;
  children: XmlElement[];
}

export interface XmlStreamOptions {
  /** Element name(s) that delimit a record, as written in the document (prefix included, e.g. `g:item`). */
  recordElement: string | readonly string[];
  maxDepth?: number;
  maxRecordBytes?: number;
  maxRecordElements?: number;
  maxTokenChars?: number;
}

export type XmlStreamErrorCode =
  | 'DOCTYPE_NOT_ALLOWED'
  | 'MALFORMED'
  | 'DEPTH_EXCEEDED'
  | 'RECORD_TOO_LARGE'
  | 'TOKEN_TOO_LARGE'
  | 'UNSUPPORTED_ENCODING';

export class XmlStreamError extends Error {
  override readonly name = 'XmlStreamError';
  constructor(
    readonly code: XmlStreamErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function isXmlStreamError(err: unknown): err is XmlStreamError {
  return err instanceof XmlStreamError;
}

const DEFAULTS = {
  maxDepth: 64,
  maxRecordBytes: 2 * 1024 * 1024,
  maxRecordElements: 20_000,
  maxTokenChars: 8 * 1024 * 1024,
};

/** Bytes buffered before the encoding is decided (enough for any XML declaration). */
const SNIFF_BYTES = 512;
const ENCODING_ALIASES: Record<string, string> = {
  'utf-8': 'utf-8',
  utf8: 'utf-8',
  'us-ascii': 'utf-8',
  ascii: 'utf-8',
  'iso-8859-1': 'windows-1252',
  iso_8859_1: 'windows-1252',
  'iso8859-1': 'windows-1252',
  latin1: 'windows-1252',
  'latin-1': 'windows-1252',
  'windows-1252': 'windows-1252',
  cp1252: 'windows-1252',
  'iso-8859-15': 'iso-8859-15',
  'utf-16': 'utf-16le',
  'utf-16le': 'utf-16le',
  'utf-16be': 'utf-16be',
};

/** Picks the text decoding from a byte-order mark or the XML declaration (UTF-8 when neither says). */
export function sniffEncoding(head: Uint8Array): { encoding: string; bomBytes: number } {
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return { encoding: 'utf-8', bomBytes: 3 };
  if (head[0] === 0xff && head[1] === 0xfe) return { encoding: 'utf-16le', bomBytes: 2 };
  if (head[0] === 0xfe && head[1] === 0xff) return { encoding: 'utf-16be', bomBytes: 2 };
  const ascii = Buffer.from(head.subarray(0, SNIFF_BYTES)).toString('latin1');
  const declared = /^\s*<\?xml[^>]*?\sencoding\s*=\s*["']([A-Za-z0-9._-]+)["']/.exec(ascii)?.[1]?.toLowerCase();
  if (!declared) return { encoding: 'utf-8', bomBytes: 0 };
  const encoding = ENCODING_ALIASES[declared];
  if (!encoding) throw new XmlStreamError('UNSUPPORTED_ENCODING', `unsupported encoding "${declared.slice(0, 40)}"`);
  return { encoding, bomBytes: 0 };
}

/** Text chunks from a byte stream, decoded by the sniffed encoding (multi-byte sequences split across chunks kept). */
async function* decode(source: AsyncIterable<Uint8Array | string>): AsyncGenerator<string> {
  let decoder: TextDecoder | undefined;
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  for await (const chunk of source) {
    if (typeof chunk === 'string') {
      yield chunk;
      continue;
    }
    if (!decoder) {
      pending.push(Buffer.from(chunk));
      pendingBytes += chunk.length;
      if (pendingBytes < SNIFF_BYTES) continue;
      const head = Buffer.concat(pending);
      pending = [];
      const { encoding, bomBytes } = sniffEncoding(head);
      decoder = new TextDecoder(encoding);
      const text = decoder.decode(head.subarray(bomBytes), { stream: true });
      if (text) yield text;
      continue;
    }
    const text = decoder.decode(chunk, { stream: true });
    if (text) yield text;
  }
  if (!decoder && pending.length) {
    const head = Buffer.concat(pending);
    const { encoding, bomBytes } = sniffEncoding(head);
    decoder = new TextDecoder(encoding);
    const text = decoder.decode(head.subarray(bomBytes), { stream: true });
    if (text) yield text;
  }
  const rest = decoder?.decode();
  if (rest) yield rest;
}

/**
 * Streams `source` and yields one element tree per record element (see the module comment). Throws
 * `XmlStreamError` on a DOCTYPE, malformed XML or a bound passed; stop iterating to stop reading `source`.
 */
export async function* streamXmlRecords(
  source: AsyncIterable<Uint8Array | string>,
  options: XmlStreamOptions,
): AsyncGenerator<XmlElement> {
  const records = new Set(typeof options.recordElement === 'string' ? [options.recordElement] : options.recordElement);
  const maxDepth = options.maxDepth ?? DEFAULTS.maxDepth;
  const maxRecordBytes = options.maxRecordBytes ?? DEFAULTS.maxRecordBytes;
  const maxRecordElements = options.maxRecordElements ?? DEFAULTS.maxRecordElements;
  const maxTokenChars = options.maxTokenChars ?? DEFAULTS.maxTokenChars;

  const parser = new SaxesParser({ xmlns: false, position: true });
  const done: XmlElement[] = [];
  /** Open elements of the record being built (empty outside a record). */
  const stack: XmlElement[] = [];
  let depth = 0;
  let recordBytes = 0;
  let recordElements = 0;
  /** Characters written since the parser last emitted an event (what it is buffering). */
  let sinceEvent = 0;

  const grow = (n: number) => {
    recordBytes += n;
    if (recordBytes > maxRecordBytes) {
      throw new XmlStreamError('RECORD_TOO_LARGE', `a record exceeds ${maxRecordBytes} bytes`);
    }
  };

  parser.on('doctype', () => {
    throw new XmlStreamError('DOCTYPE_NOT_ALLOWED', 'documents with a DOCTYPE (DTD, entities) are refused');
  });
  parser.on('opentag', (tag: SaxesTagPlain) => {
    sinceEvent = 0;
    depth++;
    if (depth > maxDepth) throw new XmlStreamError('DEPTH_EXCEEDED', `elements nest deeper than ${maxDepth}`);
    if (stack.length === 0 && !records.has(tag.name)) return;
    if (stack.length === 0) {
      recordBytes = 0;
      recordElements = 0;
    }
    recordElements++;
    if (recordElements > maxRecordElements) {
      throw new XmlStreamError('RECORD_TOO_LARGE', `a record has more than ${maxRecordElements} elements`);
    }
    const attributes: Record<string, string> = {};
    let size = tag.name.length;
    for (const [k, v] of Object.entries(tag.attributes)) {
      attributes[k] = v;
      size += k.length + v.length;
    }
    grow(size);
    const el: XmlElement = { name: tag.name, attributes, text: '', children: [] };
    stack.at(-1)?.children.push(el);
    stack.push(el);
  });
  const onText = (text: string) => {
    sinceEvent = 0;
    const el = stack.at(-1);
    if (!el) return;
    grow(text.length);
    el.text += text;
  };
  parser.on('text', onText);
  parser.on('cdata', onText);
  parser.on('comment', () => {
    sinceEvent = 0;
  });
  parser.on('processinginstruction', () => {
    sinceEvent = 0;
  });
  parser.on('closetag', () => {
    sinceEvent = 0;
    depth--;
    const el = stack.pop();
    if (el && stack.length === 0) done.push(el);
  });

  const write = (text: string) => {
    sinceEvent += text.length;
    try {
      parser.write(text);
    } catch (err) {
      throw err instanceof XmlStreamError ? err : new XmlStreamError('MALFORMED', malformed(err));
    }
    if (sinceEvent > maxTokenChars) {
      throw new XmlStreamError('TOKEN_TOO_LARGE', `a single token exceeds ${maxTokenChars} characters`);
    }
  };

  for await (const text of decode(source)) {
    // Feed in slices so the token bound is checked often, whatever size the source's chunks are.
    for (let i = 0; i < text.length; i += 64 * 1024) {
      write(text.slice(i, i + 64 * 1024));
      while (done.length) yield done.shift() as XmlElement;
    }
  }
  try {
    parser.close();
  } catch (err) {
    throw err instanceof XmlStreamError ? err : new XmlStreamError('MALFORMED', malformed(err));
  }
  while (done.length) yield done.shift() as XmlElement;
}

/** saxes messages are `line:column: what` — no document content beyond that. Capped anyway. */
function malformed(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, 200);
}

/** The first child element named `name`, or undefined. */
export function childOf(el: XmlElement, name: string): XmlElement | undefined {
  return el.children.find((c) => c.name === name);
}

/** The trimmed text of the first child named `name`, or undefined (missing or empty). */
export function childText(el: XmlElement, name: string): string | undefined {
  const text = childOf(el, name)?.text.trim();
  return text ? text : undefined;
}
