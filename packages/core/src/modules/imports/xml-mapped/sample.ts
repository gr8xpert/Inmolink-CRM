import {
  AppError,
  type FeedCredentials,
  MAPPER_SAMPLE,
  type MapperPathDto,
  type MapperSampleDto,
  type XmlRecordNode,
} from '@inmolink/contracts';
import { safeFetch } from '@inmolink/platform/safe-fetch';
import { isXmlStreamError, scanXmlStructure, streamXmlRecords, type XmlElement } from '@inmolink/platform/xml';
import { FEED_FETCH } from '../config';
import { credentialHeaders, credentialUrl, FeedHttpStatusError, XML_CONTENT_TYPES } from '../connectors';
import { suggestPaths } from './suggest';

/**
 * Samples for the visual mapper (S6-04): the first bytes of an upload or a URL, the repeating record element, a few
 * records and every path that carries a value. All bounded: `MAPPER_SAMPLE.maxBytes` of input, `maxRecords`
 * records, `maxPaths` paths. Nothing here writes; the parser is the XXE-safe one of `platform/xml`.
 */

const invalid = (reason: string) => new AppError('FEED_SAMPLE_INVALID', { reason });

/**
 * Magic-byte check of an upload (security.md): text XML starts with `<` after an optional byte-order mark and white
 * space, and has no NUL byte except in UTF-16 (which has a byte-order mark). A zip, PDF, image or script is refused
 * before any parser sees it.
 */
export function assertXmlBytes(bytes: Uint8Array): void {
  if (bytes.length === 0) throw invalid('EMPTY');
  const le = bytes[0] === 0xff && bytes[1] === 0xfe;
  const be = bytes[0] === 0xfe && bytes[1] === 0xff;
  let head: string;
  if (le || be) {
    // Wide characters (a byte-order mark says so): decode the start and apply the same test to the text.
    head = new TextDecoder(le ? 'utf-16le' : 'utf-16be').decode(bytes.subarray(2, 130));
  } else {
    const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
    if (bytes.subarray(0, 512).includes(0)) throw invalid('NOT_XML');
    head = Buffer.from(bytes.subarray(start, start + 128)).toString('latin1');
  }
  if (!/^[ \t\r\n]*<[?!A-Za-z_]/.test(head)) throw invalid('NOT_XML');
}

const clipText = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n));

/** A record as plain data within the contract's limits (names 64, attribute values 2,000, text 20,000, 4,000 nodes); null when too big. */
function toNode(el: XmlElement, budget: { nodes: number }, depth = 0): XmlRecordNode | null {
  if (depth > 12 || --budget.nodes < 0) return null;
  const children: XmlRecordNode[] = [];
  for (const c of el.children) {
    const node = toNode(c, budget, depth + 1);
    if (!node) return null;
    children.push(node);
  }
  return {
    name: clipText(el.name, 64),
    attributes: Object.fromEntries(
      Object.entries(el.attributes)
        .slice(0, 50)
        .map(([k, v]) => [clipText(k, 64), clipText(v, 2_000)]),
    ),
    text: clipText(el.text, 20_000),
    children,
  };
}

/** Paths below the record with a value, how many records have them, and a few distinct values. */
export function collectPaths(records: readonly XmlRecordNode[]): MapperPathDto[] {
  const stats = new Map<string, { count: number; repeated: boolean; samples: string[] }>();
  for (const record of records) {
    const perRecord = new Map<string, number>();
    const add = (path: string, value: string) => {
      const v = value.trim();
      if (!v || !path) return;
      let s = stats.get(path);
      if (!s) {
        if (stats.size >= MAPPER_SAMPLE.maxPaths) return;
        s = { count: 0, repeated: false, samples: [] };
        stats.set(path, s);
      }
      perRecord.set(path, (perRecord.get(path) ?? 0) + 1);
      const clipped = clipText(v, 120);
      if (s.samples.length < 3 && !s.samples.includes(clipped)) s.samples.push(clipped);
    };
    const walk = (n: XmlRecordNode, prefix: string, depth: number) => {
      for (const [k, v] of Object.entries(n.attributes)) add(prefix ? `${prefix}/@${k}` : `@${k}`, v);
      add(prefix, n.text);
      if (depth >= 8) return;
      for (const c of n.children) walk(c, prefix ? `${prefix}/${c.name}` : c.name, depth + 1);
    };
    walk(record, '', 0);
    for (const [path, n] of perRecord) {
      const s = stats.get(path);
      if (!s) continue;
      s.count++;
      if (n > 1) s.repeated = true;
    }
  }
  return [...stats].map(([path, s]) => ({ path, ...s }));
}

async function* once(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

/**
 * Reads the sample: the repeating element (the shallowest one that occurs more than once and has children, unless
 * `recordElement` says which), the first records and their paths. `truncated`: the input was cut at the size limit.
 */
export async function analyzeSample(
  bytes: Uint8Array,
  opts: { recordElement?: string; truncated?: boolean } = {},
): Promise<MapperSampleDto> {
  assertXmlBytes(bytes);
  try {
    const stats = await scanXmlStructure(once(bytes));
    const byShape = (a: { depth: number; count: number }, b: { depth: number; count: number }) =>
      a.depth - b.depth || b.count - a.count;
    let candidates = stats.filter((s) => s.count >= 2 && s.childNames >= 1).sort(byShape);
    if (candidates.length === 0) candidates = stats.filter((s) => s.depth >= 1 && s.childNames >= 2).sort(byShape);
    const names = candidates.slice(0, MAPPER_SAMPLE.maxCandidates).map((s) => ({ name: s.name, count: s.count }));
    const recordElement = opts.recordElement ?? names[0]?.name;
    if (!recordElement) throw invalid('NO_RECORDS');

    const nodes: XmlRecordNode[] = [];
    let size = 0;
    try {
      for await (const el of streamXmlRecords(once(bytes), { recordElement })) {
        const node = toNode(el, { nodes: 4_000 });
        if (!node) continue; // a record too large to preview is left out
        size += JSON.stringify(node).length;
        if (size > 400_000) break; // the client sends the records back (server action body limit 1 MB)
        nodes.push(node);
        if (nodes.length >= MAPPER_SAMPLE.maxRecords) break;
      }
    } catch (err) {
      // A cut-off sample ends mid-record: what came before is the sample.
      if (!(opts.truncated && isXmlStreamError(err) && err.code === 'MALFORMED' && nodes.length > 0)) throw err;
    }
    if (nodes.length === 0) throw invalid('NO_RECORDS');
    const paths = collectPaths(nodes);
    return {
      recordElement,
      candidates: names,
      recordCount: nodes.length,
      truncated: opts.truncated ?? false,
      bytes: bytes.length,
      paths,
      suggested: suggestPaths(paths),
      records: nodes,
    };
  } catch (err) {
    if (isXmlStreamError(err)) throw invalid(err.code);
    throw err;
  }
}

/**
 * The first `MAPPER_SAMPLE.maxBytes` of a feed URL, through `safeFetch` (SSRF checks on every hop, deadline). The
 * rest of the body is never read. Credentials go as for a run (header, Basic, or a query parameter).
 */
export async function fetchSampleBytes(
  url: string,
  credentials: FeedCredentials | null,
  signal?: AbortSignal,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const res = await safeFetch(credentialUrl(url, credentials), {
    headers: credentialHeaders(credentials),
    timeoutMs: FEED_FETCH.SAMPLE_TIMEOUT_MS,
    maxBytes: FEED_FETCH.MAX_BYTES,
    allowedContentTypes: XML_CONTENT_TYPES,
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) {
    res.body.destroy();
    throw new FeedHttpStatusError(res.status);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  try {
    for await (const chunk of res.body) {
      const buf = Buffer.from(chunk);
      const room = MAPPER_SAMPLE.maxBytes - total;
      if (buf.length > room) {
        chunks.push(buf.subarray(0, room));
        total += room;
        truncated = true;
        break;
      }
      chunks.push(buf);
      total += buf.length;
    }
  } finally {
    res.body.destroy();
  }
  return { bytes: Buffer.concat(chunks), truncated };
}
