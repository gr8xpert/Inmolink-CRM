import { childText, type XmlElement } from '@inmolink/platform/xml';
import { type FeedConnector, type FeedSource, httpSource, XML_CONTENT_TYPES, xmlRecords } from '../connectors';

/**
 * Trivial connectors for the framework's tests (S6-01). `test-xml` is the shape every real XML connector takes
 * (S6-03+): HTTP through `safeFetch`, XXE-safe streaming parse, map, validate.
 */
export interface TestItem {
  ref: string;
  priceCents: number;
}

export const testXmlConnector: FeedConnector<XmlElement, TestItem> = {
  key: 'test-xml',
  fetch: (ctx) => httpSource(ctx, { contentTypes: XML_CONTENT_TYPES }),
  parse: (source) => xmlRecords(source, { recordElement: 'property' }),
  map(raw) {
    const ref = childText(raw, 'ref');
    if (!ref) return { ok: false, problems: [{ code: 'MISSING_FIELD', field: 'ref' }] };
    return { ok: true, ref, item: { ref, priceCents: Number(childText(raw, 'price') ?? Number.NaN) * 100 } };
  },
  validate(item) {
    return Number.isInteger(item.priceCents) && item.priceCents > 0
      ? []
      : [{ code: 'INVALID_PRICE', field: 'price', message: 'price must be a positive number' }];
  },
};

/** A gate a test opens to let a parked connector continue. */
export function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  let entered!: () => void;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  return { open, opened, entered, reached };
}

/**
 * `test-gated`: an in-memory feed of `count` items that parks after its first batch until the test opens the gate
 * (simulates a worker that stalls mid-run). Batches are 500 items, so `count` > 500 parks once.
 */
export function gatedConnector(
  key: string,
  count: number,
  g: ReturnType<typeof gate>,
): FeedConnector<string, TestItem> {
  return {
    key,
    async fetch(): Promise<FeedSource> {
      return { body: (async function* () {})(), bytesRead: () => 0, contentType: 'application/xml' };
    },
    async *parse() {
      for (let i = 0; i < count; i++) {
        if (i === 501) {
          g.entered();
          await g.opened;
        }
        yield { position: i, raw: `R${i}` };
      }
    },
    map: (raw) => ({ ok: true, ref: raw, item: { ref: raw, priceCents: 100 } }),
    validate: () => [],
  };
}
