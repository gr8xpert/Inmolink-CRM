import type { FeedListingInput } from '@inmolink/contracts';
import type { XmlElement } from '@inmolink/platform/xml';
import { type FormatSettings, formatSettings } from './assemble';
import {
  type FeedConnector,
  feedListingProblems,
  httpSource,
  type MapResult,
  XML_CONTENT_TYPES,
  xmlRecords,
} from './connectors';

/**
 * The connector of a fixed-format XML feed (Milenio+, Infocasa, Inmoba, thinkSPAIN; S6-07): `safeFetch` the XML
 * (credentials only as `httpSource` allows: header, query or basic, never over plain http), stream one record
 * element at a time (XXE-safe), map it with the format's mapper, check it against the listing contract. The loader
 * (S6-02) resolves the taxonomy and writes.
 */
export function xmlFormatConnector(options: {
  key: string;
  recordElement: string;
  map: (raw: XmlElement, settings: FormatSettings) => MapResult<FeedListingInput>;
}): FeedConnector<XmlElement, FeedListingInput> {
  return {
    key: options.key,
    fetch: (ctx) => httpSource(ctx, { contentTypes: XML_CONTENT_TYPES }),
    parse: (source) => xmlRecords(source, { recordElement: options.recordElement }),
    map: (raw, ctx) => options.map(raw, formatSettings(ctx.settings)),
    validate: (item) => feedListingProblems(item),
  };
}
