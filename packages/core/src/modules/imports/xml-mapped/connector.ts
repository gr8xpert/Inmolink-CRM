import { type FeedListingInput, XML_MAPPED_CONNECTOR, XmlMapping } from '@inmolink/contracts';
import type { XmlElement } from '@inmolink/platform/xml';
import {
  type ConnectorContext,
  type FeedConnector,
  FeedMappingError,
  feedListingProblems,
  httpSource,
  registerConnector,
  XML_CONTENT_TYPES,
  xmlRecords,
} from '../connectors';
import { mapXmlRecord, xmlMappedSettings } from './mapping';

/**
 * The generic XML connector (S6-04): any XML feed, described by the connection's mapping profile (built in the
 * visual mapper). `safeFetch` the XML, stream one record element at a time (XXE-safe), map it by the profile, check
 * it against the `FeedListing` contract. No code per feed: the profile is data.
 */
const parsed = new WeakMap<ConnectorContext, XmlMapping>();

/** The profile of this run, validated once; a missing or malformed one fails the run, not each item. */
export function mappingOf(ctx: ConnectorContext): XmlMapping {
  const known = parsed.get(ctx);
  if (known) return known;
  const result = XmlMapping.safeParse(ctx.mapping);
  if (!result.success) throw new FeedMappingError();
  parsed.set(ctx, result.data);
  return result.data;
}

export const xmlMappedConnector: FeedConnector<XmlElement, FeedListingInput> = {
  key: XML_MAPPED_CONNECTOR,
  requiresMapping: true,
  fetch: (ctx) => {
    mappingOf(ctx); // fail before any download
    return httpSource(ctx, { contentTypes: XML_CONTENT_TYPES });
  },
  parse: (source, ctx) => xmlRecords(source, { recordElement: mappingOf(ctx).recordElement }),
  map: (raw, ctx) => mapXmlRecord(raw, mappingOf(ctx), xmlMappedSettings(ctx.settings)),
  validate: (item) => feedListingProblems(item),
};

registerConnector(xmlMappedConnector);
