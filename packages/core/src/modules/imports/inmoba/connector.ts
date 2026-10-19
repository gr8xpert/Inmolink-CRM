import { registerConnector } from '../connectors';
import { xmlFormatConnector } from '../xml-format';
import { mapInmobaProperty } from './mapping';

/** The Inmoba (Inmobalia CRM) XML connector (S6-07, [H14]): `<properties><property>…`. */
export const inmobaConnector = xmlFormatConnector({
  key: 'inmoba',
  recordElement: 'property',
  map: mapInmobaProperty,
});

registerConnector(inmobaConnector);
