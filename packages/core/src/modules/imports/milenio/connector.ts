import { registerConnector } from '../connectors';
import { xmlFormatConnector } from '../xml-format';
import { mapMilenioInmueble } from './mapping';

/** The Milenio+ XML connector (S6-07, [H14]): one `<inmueble>` per listing. */
export const milenioConnector = xmlFormatConnector({
  key: 'milenio-plus',
  recordElement: 'inmueble',
  map: mapMilenioInmueble,
});

registerConnector(milenioConnector);
