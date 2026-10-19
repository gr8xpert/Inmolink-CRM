import type { FeedListingInput } from '@inmolink/contracts';
import type { XmlElement } from '@inmolink/platform/xml';
import {
  type FeedConnector,
  feedListingProblems,
  httpSource,
  registerConnector,
  XML_CONTENT_TYPES,
  xmlRecords,
} from '../connectors';
import { kyeroSettings, mapKyeroProperty } from './mapping';

/**
 * The Kyero v3 connector (S6-03): `safeFetch` the XML, stream one `<property>` at a time (XXE-safe), map it to a
 * `FeedListing`, check it against the contract. The loader (S6-02) resolves the taxonomy and writes.
 */
export const kyeroConnector: FeedConnector<XmlElement, FeedListingInput> = {
  key: 'kyero',
  fetch: (ctx) => httpSource(ctx, { contentTypes: XML_CONTENT_TYPES }),
  parse: (source) => xmlRecords(source, { recordElement: 'property' }),
  map: (raw, ctx) => mapKyeroProperty(raw, kyeroSettings(ctx.settings)),
  validate: (item) => feedListingProblems(item),
};

registerConnector(kyeroConnector);
