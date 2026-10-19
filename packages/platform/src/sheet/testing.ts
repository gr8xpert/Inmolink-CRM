import { crc32, deflateRawSync } from 'node:zlib';

/**
 * Test helpers for `platform/sheet` (S6-05): a zip writer and a minimal XLSX writer, so tests build their own
 * workbooks (a 5,000-row one costs a few milliseconds) and no binary fixture is committed.
 */

export interface ZipFile {
  name: string;
  data: Buffer | string;
  /** 0 = stored, 8 = deflated (default). */
  method?: 0 | 8;
  /** Written into the central directory instead of the real size (a lying archive). */
  declaredSize?: number;
  /** Sets the "encrypted" flag. */
  encrypted?: boolean;
}

export function buildZip(files: readonly ZipFile[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const data = Buffer.from(f.data);
    const method = f.method ?? 8;
    const body = method === 8 ? deflateRawSync(data) : data;
    const name = Buffer.from(f.name);
    const crc = crc32(data);
    const flags = f.encrypted ? 1 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, body);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(f.declaredSize ?? data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += local.length + name.length + body.length;
  }
  const cdBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuffer, end]);
}

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export type TestCell =
  | string
  | number
  | boolean
  | null
  /** A formula with the value Excel cached for it (a number or a string). */
  | { formula: string; value: string | number };

const columnName = (i: number): string => {
  let n = i + 1;
  let out = '';
  while (n > 0) {
    out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
};

/**
 * A workbook with one sheet (plus a hidden one when asked). Strings go to the shared-string table, as Excel writes
 * them, unless `inlineStrings`.
 */
export function buildXlsx(
  rows: readonly (readonly TestCell[])[],
  options: { inlineStrings?: boolean; hiddenFirstSheet?: boolean; extra?: readonly ZipFile[] } = {},
): Buffer {
  const strings: string[] = [];
  const stringIndex = new Map<string, number>();
  const shared = (s: string) => {
    let i = stringIndex.get(s);
    if (i === undefined) {
      i = strings.length;
      strings.push(s);
      stringIndex.set(s, i);
    }
    return i;
  };
  const sheetRows = rows.map((row, r) => {
    const cells = row.map((cell, c) => {
      const ref = `${columnName(c)}${r + 1}`;
      if (cell === null) return '';
      if (typeof cell === 'number') return `<c r="${ref}"><v>${cell}</v></c>`;
      if (typeof cell === 'boolean') return `<c r="${ref}" t="b"><v>${cell ? 1 : 0}</v></c>`;
      if (typeof cell === 'object') {
        const f = xmlEscape(cell.formula);
        return typeof cell.value === 'number'
          ? `<c r="${ref}"><f>${f}</f><v>${cell.value}</v></c>`
          : `<c r="${ref}" t="str"><f>${f}</f><v>${xmlEscape(cell.value)}</v></c>`;
      }
      return options.inlineStrings
        ? `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(cell)}</t></is></c>`
        : `<c r="${ref}" t="s"><v>${shared(cell)}</v></c>`;
    });
    return `<row r="${r + 1}">${cells.join('')}</row>`;
  });
  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const files: ZipFile[] = [
    {
      name: '[Content_Types].xml',
      data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
    },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${
        options.hiddenFirstSheet ? '<sheet name="Hidden" sheetId="2" state="hidden" r:id="rId2"/>' : ''
      }<sheet name="Properties" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="worksheet" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${ns}"><sheetData>${sheetRows.join('')}</sheetData></worksheet>`,
    },
    {
      name: 'xl/worksheets/sheet2.xml',
      data: `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${ns}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>hidden</t></is></c></row></sheetData></worksheet>`,
    },
    ...(options.inlineStrings || strings.length === 0
      ? []
      : [
          {
            name: 'xl/sharedStrings.xml',
            data: `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="${ns}" count="${strings.length}" uniqueCount="${strings.length}">${strings
              .map((s) => `<si><t xml:space="preserve">${xmlEscape(s)}</t></si>`)
              .join('')}</sst>`,
          },
        ]),
    ...(options.extra ?? []),
  ];
  return buildZip(files);
}
