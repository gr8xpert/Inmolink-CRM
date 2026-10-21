import { describe, expect, it } from 'vitest';
import { isSheetError, readSheetRows, SHEET_LIMITS, type SheetRow } from './index';
import { buildXlsx, buildZip } from './testing';

const collect = async (bytes: Uint8Array, stopAfter?: number): Promise<SheetRow[]> => {
  const out: SheetRow[] = [];
  for await (const r of readSheetRows(bytes, stopAfter ? { stopAfter } : {})) out.push(r);
  return out;
};
const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (err) {
    return isSheetError(err) ? err.code : `other:${String(err)}`;
  }
  return 'no error';
};

describe('csv', () => {
  it('[S6-05] reads comma, semicolon and tab files, quotes, doubled quotes, quoted newlines and CRLF', async () => {
    expect((await collect(Buffer.from('a,b,c\r\n1,"x, y",3\r\n'))).map((r) => r.cells)).toEqual([
      ['a', 'b', 'c'],
      ['1', 'x, y', '3'],
    ]);
    expect((await collect(Buffer.from('ref;precio\nA1;1.250,50\n'))).map((r) => r.cells)).toEqual([
      ['ref', 'precio'],
      ['A1', '1.250,50'],
    ]);
    expect((await collect(Buffer.from('a\tb\n"say ""hi""\nthere"\tz'))).map((r) => r.cells)).toEqual([
      ['a', 'b'],
      ['say "hi"\nthere', 'z'],
    ]);
  });

  it('[S6-05] row indexes follow the lines: blank lines are skipped but counted', async () => {
    const rows = await collect(Buffer.from('a,b\n\n1,2\n,\n3,4\n'));
    expect(rows.map((r) => [r.index, r.cells])).toEqual([
      [0, ['a', 'b']],
      [2, ['1', '2']],
      [4, ['3', '4']],
    ]);
  });

  it('[S6-05] reads a byte-order mark, UTF-16 and Windows-1252 (Spanish Excel) as text', async () => {
    expect((await collect(Buffer.from('﻿ref,ciudad\nA1,Málaga\n')))[0]?.cells).toEqual(['ref', 'ciudad']);
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('ref;ciudad\nA1;Málaga\n', 'utf16le')]);
    expect((await collect(utf16)).map((r) => r.cells)).toEqual([
      ['ref', 'ciudad'],
      ['A1', 'Málaga'],
    ]);
    const latin = Buffer.from('ref;ciudad\nA1;M\xe1laga\n', 'latin1');
    expect((await collect(latin))[1]?.cells).toEqual(['A1', 'Málaga']);
  });

  it('[S6-05] values that start with = + - @ stay plain text, exactly as written', async () => {
    const rows = await collect(Buffer.from('a,b,c,d\n=1+1,+34 600,-5,@SUM(A1)\n'));
    expect(rows[1]?.cells).toEqual(['=1+1', '+34 600', '-5', '@SUM(A1)']);
  });

  it('[S6-05] a quote at a chunk boundary is read correctly (file larger than one decoding chunk)', async () => {
    const lines = Array.from({ length: 12_000 }, (_, i) => `${i},"he said ""hi"" to ${i}",x`);
    const rows = await collect(Buffer.from(`a,b,c\n${lines.join('\n')}\n`));
    expect(rows).toHaveLength(12_001);
    expect(rows.every((r, i) => i === 0 || r.cells[1] === `he said "hi" to ${i - 1}`)).toBe(true);
  });

  it('[S6-05] refuses binaries, markup, scripts, PDFs and legacy .xls', async () => {
    expect(await code(collect(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0])))).toBe(
      'NOT_TEXT',
    );
    expect(await code(collect(Buffer.from('<html><body>x</body></html>')))).toBe('NOT_SHEET');
    expect(await code(collect(Buffer.from('<?xml version="1.0"?><feed/>')))).toBe('NOT_SHEET');
    expect(await code(collect(Buffer.from('%PDF-1.7\n1 0 obj')))).toBe('NOT_SHEET');
    expect(await code(collect(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])))).toBe('UNSUPPORTED_XLS');
    expect(await code(collect(Buffer.alloc(0)))).toBe('EMPTY');
  });

  it('[S6-05] bounds: columns, rows, one cell', async () => {
    const wide = Array.from({ length: SHEET_LIMITS.maxColumns + 1 }, (_, i) => `c${i}`).join(',');
    expect(await code(collect(Buffer.from(`${wide}\n`)))).toBe('TOO_MANY_COLUMNS');
    expect(await code(collect(Buffer.from(`a\n"${'x'.repeat(SHEET_LIMITS.maxCellChars + 10)}"\n`)))).toBe(
      'CELL_TOO_LARGE',
    );
    const many = `a\n${'1\n'.repeat(SHEET_LIMITS.maxRows + 5)}`;
    expect(await code(collect(Buffer.from(many)))).toBe('TOO_MANY_ROWS');
    // a preview stops quietly
    expect(await collect(Buffer.from(many), 10)).toHaveLength(10);
  });
});

describe('xlsx', () => {
  it('[S6-05] reads shared and inline strings, numbers, booleans and gaps', async () => {
    const rows = [
      ['ref', 'type', 'price', 'pool'],
      ['A1', 'Villa', 250000, true],
      ['A2', null, 1250.5, false],
    ];
    for (const inlineStrings of [false, true]) {
      const out = await collect(buildXlsx(rows, { inlineStrings }));
      expect(out.map((r) => [r.index, r.cells])).toEqual([
        [0, ['ref', 'type', 'price', 'pool']],
        [1, ['A1', 'Villa', '250000', 'TRUE']],
        [2, ['A2', '', '1250.5', 'FALSE']],
      ]);
    }
  });

  it('[S6-05] a formula cell is read as the value Excel cached, never evaluated', async () => {
    const out = await collect(
      buildXlsx([
        ['ref', 'price', 'label'],
        ['A1', { formula: 'B3*2', value: 250000 }, { formula: 'CONCATENATE("Vi","lla")', value: 'Villa' }],
        ['A2', { formula: 'HYPERLINK("http://evil.example","x")', value: 'cached text' }, null],
      ]),
    );
    expect(out[1]?.cells).toEqual(['A1', '250000', 'Villa']);
    expect(out[2]?.cells).toEqual(['A2', 'cached text']);
  });

  it('[S6-05] floating-point noise from Excel does not reach the price', async () => {
    const noisy = await collect(buildXlsx([['p'], [1250.5000000000002], [0.1 + 0.2]]));
    expect(noisy.map((r) => r.cells[0])).toEqual(['p', '1250.5', '0.3']);
  });

  it('[S6-05] values starting with = + - @ are text in a spreadsheet too', async () => {
    const out = await collect(
      buildXlsx([
        ['a', 'b'],
        ['=cmd|calc', '@SUM(1)'],
      ]),
    );
    expect(out[1]?.cells).toEqual(['=cmd|calc', '@SUM(1)']);
  });

  it('[S6-05] reads the first visible sheet', async () => {
    const out = await collect(buildXlsx([['ref'], ['A1']], { hiddenFirstSheet: true }));
    expect(out[1]?.cells).toEqual(['A1']);
  });

  it('[S6-05] 5,000 rows stream through; a preview reads only the first rows and the strings they use', async () => {
    const rows: (string | number)[][] = [['ref', 'type', 'price']];
    for (let i = 0; i < 5_000; i++) rows.push([`R${i}`, i % 2 ? 'Villa' : 'Flat', 100_000 + i]);
    const file = buildXlsx(rows);
    const all = await collect(file);
    expect(all).toHaveLength(5_001);
    expect(all[5_000]?.cells).toEqual(['R4999', 'Villa', '104999']);
    const preview = await collect(file, 26);
    expect(preview).toHaveLength(26);
    expect(preview[25]?.cells).toEqual(['R24', 'Flat', '100024']);
  });

  it('[S6-05] refuses a zip bomb: a declared size over the cap, a lie about the size, too many entries', async () => {
    const big = Buffer.alloc(SHEET_LIMITS.maxEntryBytes + 1024, 0x20);
    const sheet = (declared?: number) =>
      buildXlsx([['a']], {
        extra: [{ name: 'xl/worksheets/sheet1.xml', data: big, ...(declared ? { declaredSize: declared } : {}) }],
      });
    // an honest oversize entry: the declared size is over the cap
    expect(await code(collect(sheet()))).toBe('ZIP_BOMB');
    // a lying one: declares 1 KB, inflates to more than that
    expect(await code(collect(sheet(1024)))).toBe('ZIP_BOMB');
    const manyEntries = buildZip(
      Array.from({ length: SHEET_LIMITS.maxEntries + 1 }, (_, i) => ({ name: `f${i}`, data: 'x' })),
    );
    expect(await code(collect(manyEntries))).toBe('ZIP_BOMB');
  });

  it('[S7-F1] refuses a stored entry whose data length is not its size, or over the entry cap', async () => {
    const stored = (data: Buffer | string, declaredSize?: number) =>
      buildXlsx([['a']], {
        extra: [
          {
            name: 'xl/worksheets/sheet1.xml',
            data,
            method: 0,
            ...(declaredSize !== undefined ? { declaredSize } : {}),
          },
        ],
      });
    const sheetXml =
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
      '<row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c></row></sheetData></worksheet>';
    // an honest stored entry is read
    expect(await collect(stored(sheetXml))).toEqual([{ index: 0, cells: ['a'] }]);
    // declares 16 bytes, holds the whole sheet: refused, not streamed
    expect(await code(collect(stored(sheetXml, 16)))).toBe('ZIP_BOMB');
    // a stored entry over the cap (declared honestly)
    expect(await code(collect(stored(Buffer.alloc(SHEET_LIMITS.maxEntryBytes + 1, 0x20))))).toBe('ZIP_BOMB');
  });

  it('[S6-05] refuses encrypted entries, damaged archives, other zips and zips without a workbook', async () => {
    expect(await code(collect(buildZip([{ name: 'xl/workbook.xml', data: 'x', encrypted: true }])))).toBe('ENCRYPTED');
    const good = buildXlsx([['a']]);
    expect(await code(collect(good.subarray(0, good.length - 40)))).toBe('BAD_ZIP');
    expect(await code(collect(buildZip([{ name: 'readme.txt', data: 'hello' }])))).toBe('NOT_SHEET');
  });

  it('[S6-05] refuses a worksheet with a DTD (entities are never expanded)', async () => {
    const evil = buildXlsx([['a']], {
      extra: [
        {
          name: 'xl/worksheets/sheet1.xml',
          data: '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e "boom">]><worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&e;</t></is></c></row></sheetData></worksheet>',
        },
      ],
    });
    expect(await code(collect(evil))).toBe('MALFORMED');
  });

  it('[S6-05] hostile cells stay cheap: a long digit run is text, a huge shared-string index is not followed in a preview', async () => {
    const digits = `${'9'.repeat(45_000)}x`;
    const started = Date.now();
    const out = await collect(buildXlsx([['p'], [{ formula: 'x', value: digits }]]));
    expect(out[1]?.cells[0]).toBe(digits);
    expect(Date.now() - started).toBeLessThan(2_000);
    const pointer = buildXlsx([['a'], ['b']], {
      extra: [
        {
          name: 'xl/worksheets/sheet1.xml',
          data: '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2" t="s"><v>99999999</v></c></row></sheetData></worksheet>',
        },
      ],
    });
    expect((await collect(pointer, 5)).map((r) => r.cells)).toEqual([['a'], ['']]);
  });

  it('[S6-05] shared strings have their own, smaller cap', async () => {
    const strings = Array.from({ length: 2_000 }, () => 'x'.repeat(20_000));
    const file = buildXlsx([['a'], ...strings.map((s) => [s])]);
    expect(await code(collect(file))).toBe('no error'); // 40 MB of text in 2,000 cells is under the cap
    const huge = Array.from({ length: 3_000 }, (_, i) => [`${i}${'y'.repeat(12_000)}`]);
    expect(await code(collect(buildXlsx([['a'], ...huge])))).toBe('ZIP_BOMB'); // 36 MB > 32 MB
  });

  it('[S6-05] bounds: rows and columns', async () => {
    const wide = [Array.from({ length: SHEET_LIMITS.maxColumns + 1 }, (_, i) => `c${i}`)];
    expect(await code(collect(buildXlsx(wide)))).toBe('TOO_MANY_COLUMNS');
    const tall = Array.from({ length: SHEET_LIMITS.maxRows + 1 }, (_, i) => [i]);
    expect(await code(collect(buildXlsx(tall)))).toBe('TOO_MANY_ROWS');
  });
});
