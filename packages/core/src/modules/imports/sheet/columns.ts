import type { XmlElement } from '@inmolink/platform/xml';

/**
 * A spreadsheet row as the mapper sees any record (S6-05): an element `row` whose children are the columns, named by
 * a key made from the header. The profile's paths are those keys (`price`, `ciudad`), so the sample, the preview, the
 * dry run and the mapping rules of the XML mapper work on CSV and Excel files unchanged.
 */

/** Longest key: the contract's element names allow 64 characters, a duplicate gets a short suffix. */
const MAX_KEY = 56;

/**
 * Header texts → unique keys made of letters, digits, `_`, `.` and `-` (accents dropped, anything else `_`, a
 * leading digit gets `c_`, an empty header `col_<n>`, a repeated one `_2`, `_3`). Same header row, same keys: the
 * sample and every run derive them with this function.
 */
export function columnKeys(headers: readonly string[]): string[] {
  const used = new Set<string>();
  return headers.map((header, i) => {
    const base = header
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9_.-]+/g, '_')
      .replace(/^[_.-]+|[_.-]+$/g, '')
      .slice(0, MAX_KEY);
    let key = base === '' ? `col_${i + 1}` : /^[A-Za-z_]/.test(base) ? base : `c_${base}`;
    for (let n = 2; used.has(key.toLowerCase()); n++) key = `${key.replace(/_\d+$/, '')}_${n}`;
    used.add(key.toLowerCase());
    return key;
  });
}

/** One data row as a record node: a child per column that has a value (empty cells are absent, like a missing element). */
export function rowNode(
  keys: readonly string[],
  cells: readonly string[],
  clip = Number.POSITIVE_INFINITY,
): XmlElement {
  const children: XmlElement[] = [];
  for (let i = 0; i < keys.length; i++) {
    const text = cells[i]?.trim();
    if (text)
      children.push({
        name: keys[i] as string,
        attributes: {},
        text: text.length > clip ? text.slice(0, clip) : text,
        children: [],
      });
  }
  return { name: 'row', attributes: {}, text: '', children };
}
