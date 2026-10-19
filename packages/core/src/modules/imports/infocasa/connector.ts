import { registerConnector } from '../connectors';
import { xmlFormatConnector } from '../xml-format';
import { mapInfocasaPropiedad } from './mapping';

/** The Infocasa XML connector (S6-07, [H14]): one `<propiedad>` per listing. */
export const infocasaConnector = xmlFormatConnector({
  key: 'infocasa',
  recordElement: 'propiedad',
  map: mapInfocasaPropiedad,
});

registerConnector(infocasaConnector);
