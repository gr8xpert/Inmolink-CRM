import { crc32, inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { CsvWriter, escapeFormula, readSheetRows, type SheetRow, XlsxWriter, ZipWriter } from './index';

/** Collects what a writer sends to its sink, counting the chunks. */
function memorySink() {
  const chunks: Buffer[] = [];
  return {
    sink: async (chunk: Uint8Array) => {
      chunks.push(Buffer.from(chunk));
    },
    chunks,
    bytes: () => Buffer.concat(chunks),
  };
}

const collect = async (bytes: Uint8Array): Promise<string[][]> => {
  const out: SheetRow[] = [];
  for await (const r of readSheetRows(bytes)) out.push(r);
  return out.map((r) => r.cells);
};

/** The entries of a ZIP read through its central directory, inflated (or stored) and CRC-checked. */
function unzip(zip: Buffer): Map<string, Buffer> {
  const eocd = zip.length - 22;
  expect(zip.readUInt32LE(eocd)).toBe(0x06054b50);
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i += 1) {
    expect(zip.readUInt32LE(p)).toBe(0x02014b50);
    const method = zip.readUInt16LE(p + 10);
    const crc = zip.readUInt32LE(p + 16);
    const compressed = zip.readUInt32LE(p + 20);
    const size = zip.readUInt32LE(p + 24);
    const nameLength = zip.readUInt16LE(p + 28);
    const offset = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLength).toString('utf8');
    const local = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    const raw = zip.subarray(local, local + compressed);
    const data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw);
    expect(data.length).toBe(size);
    expect(crc32(data) >>> 0).toBe(crc >>> 0);
    out.set(name, data);
    p += 46 + nameLength;
  }
  return out;
}

describe('escapeFormula', () => {
  it('[S10-08] cells starting with = + - @ are escaped', () => {
    for (const risky of ['=1+2', '+34600123456', '-2+3', '@SUM(A1)', '=HYPERLINK("http://x","y")']) {
      expect(escapeFormula(risky)).toBe(`'${risky}`);
    }
  });

  it('[S10-08] a leading tab, CR or LF, whitespace before = + - @ and full-width, small and minus forms are escaped too', () => {
    const risky = ['\t=1', '\r=1', '\nx', '  =1', ' +1', '＝1+1', '＠x', '﹢x', '﹣x', '−1'];
    for (const text of risky) expect(escapeFormula(text)).toBe(`'${text}`);
  });

  it('[S10-08] ordinary text is unchanged', () => {
    for (const plain of ['Ana', 'a=b', 'ana@example.com', '1-2', '', ' leading space', "'quoted"]) {
      expect(escapeFormula(plain)).toBe(plain);
    }
  });
});

describe('CsvWriter', () => {
  it('[S10-08] writes RFC 4180 CSV with a BOM, escaping formula cells, typed numbers and booleans as such', async () => {
    const out = memorySink();
    const csv = await CsvWriter.start(out.sink, ['name', 'note', 'n', 'ok']);
    await csv.row(['Ana, "La" Ruiz', '=cmd|" /C calc"!A0', -5, true]);
    await csv.row(['@x', 'line\nbreak', null, false]);
    await csv.finish();
    const bytes = out.bytes();
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.toString('utf8')).toContain('\r\n');
    expect(await collect(bytes)).toEqual([
      ['name', 'note', 'n', 'ok'],
      ['Ana, "La" Ruiz', '\'=cmd|" /C calc"!A0', '-5', 'true'],
      ["'@x", 'line\nbreak', '', 'false'],
    ]);
  });

  it('[S10-08] a cell holding a semicolon or a tab is quoted, so a Spanish Excel never splits off a formula cell', async () => {
    const out = memorySink();
    const csv = await CsvWriter.start(out.sink, ['a', 'b']);
    await csv.row(['a;=1+1', 'z']);
    await csv.row(['a\t=1+1', 'z']);
    await csv.row([new Date('2026-10-24T08:30:00.123Z'), 'z']);
    await csv.finish();
    const text = out.bytes().toString('utf8');
    const lines = text.replace(/^﻿/, '').split('\r\n');
    expect(lines.slice(1, 4)).toEqual(['"a;=1+1",z', '"a\t=1+1",z', '2026-10-24T08:30:00.123Z,z']);
    // read as a semicolon file (a Spanish Excel's separator): the quoted cell stays one cell
    expect(await collect(Buffer.from(`x;y\r\n${lines[1]?.replace(',z', ';z')}\r\n`))).toEqual([
      ['x', 'y'],
      ['a;=1+1', 'z'],
    ]);
    // and as a tab file
    expect(await collect(Buffer.from(`x\ty\r\n${lines[2]?.replace(',z', '\tz')}\r\n`))).toEqual([
      ['x', 'y'],
      ['a\t=1+1', 'z'],
    ]);
  });
});

describe('XlsxWriter', () => {
  it('[S10-08] formula-like text keeps its value and is shown as text (quotePrefix style), never a formula', async () => {
    const out = memorySink();
    const xlsx = await XlsxWriter.start(out.sink, ['ref', 'price', 'note'], { sheetName: 'Listings' });
    await xlsx.row(['A-1', 250000, '=1+2']);
    await xlsx.row(['<b>&', null, '+34600123456']);
    await xlsx.row(['ctrl\u0001char', 1.5, true]);
    await xlsx.finish();
    const bytes = out.bytes();
    expect(await collect(bytes)).toEqual([
      ['ref', 'price', 'note'],
      ['A-1', '250000', '=1+2'],
      ['<b>&', '', '+34600123456'],
      ['ctrlchar', '1.5', 'TRUE'],
    ]);
    const entries = unzip(bytes);
    const sheet = entries.get('xl/worksheets/sheet1.xml')?.toString('utf8') ?? '';
    expect(sheet).not.toContain('<f>');
    expect(sheet).not.toContain("'");
    expect(sheet).toContain('<c r="C2" s="2" t="inlineStr"><is><t xml:space="preserve">=1+2</t></is></c>');
    expect(sheet).toContain('<c r="C3" s="2" t="inlineStr"><is><t xml:space="preserve">+34600123456</t></is></c>');
    expect(sheet).toContain('<c r="A2" t="inlineStr">');
    expect(entries.get('xl/styles.xml')?.toString('utf8')).toContain('quotePrefix="1"');
  });

  it('[S10-08] dates are serial numbers with a date format', async () => {
    const out = memorySink();
    const xlsx = await XlsxWriter.start(out.sink, ['at']);
    await xlsx.row([new Date('2026-10-24T12:00:00.000Z')]);
    await xlsx.finish();
    const entries = unzip(out.bytes());
    expect(entries.get('xl/worksheets/sheet1.xml')?.toString('utf8')).toContain('<c r="A2" s="3"><v>46319.5</v></c>');
    expect(entries.get('xl/styles.xml')?.toString('utf8')).toContain('formatCode="yyyy-mm-dd hh:mm:ss"');
  });

  it('[S10-08] a large sheet goes to the sink in chunks, never as one buffer', async () => {
    const out = memorySink();
    const xlsx = await XlsxWriter.start(out.sink, ['id', 'text']);
    for (let i = 0; i < 20_000; i += 1) await xlsx.row([i, `row ${i} ${'x'.repeat(40)}`]);
    await xlsx.finish();
    expect(out.chunks.length).toBeGreaterThan(10);
    const rows = await collect(out.bytes());
    expect(rows).toHaveLength(20_001);
    expect(rows[20_000]).toEqual(['19999', `row 19999 ${'x'.repeat(40)}`]);
  });
});

describe('ZipWriter', () => {
  it('[S10-08] writes entries in deflated chunks with data descriptors; any unzip reads them back', async () => {
    const out = memorySink();
    const zip = new ZipWriter(out.sink);
    await zip.add('manifest.json', '{"ok":true}');
    await zip.begin('data/contacts.csv');
    const big: string[] = [];
    for (let i = 0; i < 30_000; i += 1) big.push(`${i},contact ${i},ñandú ${i % 7}\r\n`);
    // one reused buffer: the writer copies what it keeps
    const reused = Buffer.alloc(64);
    for (const line of big) {
      const n = reused.write(line, 'utf8');
      await zip.write(reused.subarray(0, n));
    }
    await zip.end();
    // a nested workbook is stored as is (already compressed)
    await zip.begin('listings.xlsx', { store: true });
    const inner = await XlsxWriter.start((c) => zip.write(c), ['ref']);
    await inner.row(['R1']);
    await inner.finish();
    await zip.end();
    const { bytes } = await zip.finish();
    const archive = out.bytes();
    expect(bytes).toBe(archive.length);
    const entries = unzip(archive);
    expect([...entries.keys()]).toEqual(['manifest.json', 'data/contacts.csv', 'listings.xlsx']);
    expect(entries.get('manifest.json')?.toString()).toBe('{"ok":true}');
    expect(entries.get('data/contacts.csv')?.toString('utf8')).toBe(big.join(''));
    expect(await collect(entries.get('listings.xlsx') as Buffer)).toEqual([['ref'], ['R1']]);
    const local = archive.indexOf(Buffer.from('listings.xlsx')) - 30;
    expect(archive.readUInt32LE(local)).toBe(0x04034b50);
    expect(archive.readUInt16LE(local + 8)).toBe(0); // stored
  });
});
