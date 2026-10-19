import { registerConnector } from '../connectors';
import { xmlFormatConnector } from '../xml-format';
import { mapThinkSpainProperty } from './mapping';

/** The thinkSPAIN XML connector (S6-07, [H14]): one `<property>` per listing. */
export const thinkspainConnector = xmlFormatConnector({
  key: 'thinkspain',
  recordElement: 'property',
  map: mapThinkSpainProperty,
});

registerConnector(thinkspainConnector);
