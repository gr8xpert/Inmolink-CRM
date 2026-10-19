import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  childText,
  scanXmlStructure,
  sniffEncoding,
  streamXmlRecords,
  type XmlElement,
  XmlStreamError,
  type XmlStreamOptions,
} from './index';

const collect = async (source: AsyncIterable<Uint8Array | string>, options: XmlStreamOptions) => {
  const out: XmlElement[] = [];
  for await (const r of streamXmlRecords(source, options)) out.push(r);
  return out;
};
const bytes = (...parts: (string | Buffer)[]) =>
  Readable.from(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'utf8') : p)));
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'resolved',
    (err: unknown) => (err instanceof XmlStreamError ? err.code : `other: ${String(err)}`),
  );

describe('streamXmlRecords', () => {
  it('[S6-01] yields one record per record element with attributes, text and children', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <root><kyero><feed_version>3</feed_version></kyero>
        <property id="1"><ref>A&amp;1</ref><price>250000</price><desc><![CDATA[<b>Sea</b> view]]></desc></property>
        <property id="2"><ref>B2</ref><images><image><url>https://x/1.jpg</url></image></images></property>
      </root>`;
    const records = await collect(bytes(xml), { recordElement: 'property' });
    expect(records).toHaveLength(2);
    expect(records[0]?.attributes).toEqual({ id: '1' });
    expect(childText(records[0] as XmlElement, 'ref')).toBe('A&1');
    expect(childText(records[0] as XmlElement, 'desc')).toBe('<b>Sea</b> view');
    expect(records[1]?.children[1]?.children[0]?.children[0]?.text).toBe('https://x/1.jpg');
  });

  it('[S6-01] XML with a DOCTYPE is rejected (internal subset, external DTD, billion laughs)', async () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><r><property>&xxe;</property></r>`;
    const external = `<?xml version="1.0"?><!DOCTYPE r SYSTEM "http://169.254.169.254/x.dtd"><r/>`;
    const laughs = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;">]><lolz>&lol2;</lolz>`;
    for (const doc of [xxe, external, laughs]) {
      expect(await code(collect(bytes(doc), { recordElement: 'property' }))).toBe('DOCTYPE_NOT_ALLOWED');
    }
  });

  it('[S6-01] an entity declaration outside a DOCTYPE or an undeclared entity reference is rejected, never expanded', async () => {
    const declaration = `<r><!ENTITY x "y"><property>a</property></r>`;
    const reference = `<r><property>&xxe;</property></r>`;
    expect(await code(collect(bytes(declaration), { recordElement: 'property' }))).toBe('MALFORMED');
    expect(await code(collect(bytes(reference), { recordElement: 'property' }))).toBe('MALFORMED');
  });

  it('[S6-01] a DOCTYPE split across chunks is still rejected before any record of it is used', async () => {
    const parts = ['<?xml version="1.0"?><!DOC', 'TYPE r [<!ENT', 'ITY a "b">]><r><property>x</property></r>'];
    expect(await code(collect(bytes(...parts), { recordElement: 'property' }))).toBe('DOCTYPE_NOT_ALLOWED');
  });

  it('[S6-01] streams: records arrive before the document ends, chunk boundaries anywhere', async () => {
    const one = '<property><ref>R</ref></property>';
    const doc = `<root>${one.repeat(1000)}</root>`;
    const chunks: string[] = [];
    for (let i = 0; i < doc.length; i += 7) chunks.push(doc.slice(i, i + 7));
    let yielded = 0;
    async function* slow() {
      for (const [i, c] of chunks.entries()) {
        // after half the input, at least some records were already handed out
        if (i === Math.floor(chunks.length / 2)) expect(yielded).toBeGreaterThan(100);
        yield Buffer.from(c);
      }
    }
    for await (const r of streamXmlRecords(slow(), { recordElement: 'property' })) {
      expect(childText(r, 'ref')).toBe('R');
      yielded++;
    }
    expect(yielded).toBe(1000);
  });

  it('[S6-01] bounds depth, record size, element count and single tokens', async () => {
    const deep = `<r>${'<a>'.repeat(100)}${'</a>'.repeat(100)}</r>`;
    expect(await code(collect(bytes(deep), { recordElement: 'p', maxDepth: 50 }))).toBe('DEPTH_EXCEEDED');
    const big = `<r><p>${'x'.repeat(5000)}</p></r>`;
    expect(await code(collect(bytes(big), { recordElement: 'p', maxRecordBytes: 1000 }))).toBe('RECORD_TOO_LARGE');
    const many = `<r><p>${'<i/>'.repeat(200)}</p></r>`;
    expect(await code(collect(bytes(many), { recordElement: 'p', maxRecordElements: 100 }))).toBe('RECORD_TOO_LARGE');
    const hugeComment = `<r><!--${'x'.repeat(300_000)}--></r>`;
    expect(await code(collect(bytes(hugeComment), { recordElement: 'p', maxTokenChars: 100_000 }))).toBe(
      'TOKEN_TOO_LARGE',
    );
  });

  it('rejects malformed XML', async () => {
    expect(await code(collect(bytes('<r><p>a</r>'), { recordElement: 'p' }))).toBe('MALFORMED');
    expect(await code(collect(bytes('<r><p>a</p>'), { recordElement: 'p' }))).toBe('MALFORMED');
  });

  it('decodes ISO-8859-1 feeds and BOMs', async () => {
    const latin = Buffer.concat([
      Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><r><p>M'),
      Buffer.from([0xe1]),
      Buffer.from('laga</p></r>'),
    ]);
    const [rec] = await collect(Readable.from([latin]), { recordElement: 'p' });
    expect(rec?.text).toBe('Málaga');
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<r><p>ñ</p></r>')]);
    const [b] = await collect(Readable.from([bom]), { recordElement: 'p' });
    expect(b?.text).toBe('ñ');
    expect(() => sniffEncoding(Buffer.from('<?xml version="1.0" encoding="EBCDIC-XYZ"?>'))).toThrow(XmlStreamError);
  });
});

describe('scanXmlStructure', () => {
  it('[S6-04] counts elements per name with their depth and distinct child names, without building records', async () => {
    const stats = await scanXmlStructure(
      bytes('<feed><meta><v>1</v></meta><item id="1"><a>1</a><b>2</b></item><item id="2"><a>3</a></item></feed>'),
    );
    const by = new Map(stats.map((s) => [s.name, s]));
    expect(by.get('feed')).toMatchObject({ count: 1, depth: 0, childNames: 2 });
    expect(by.get('item')).toMatchObject({ count: 2, depth: 1, childNames: 2 });
    expect(by.get('a')).toMatchObject({ count: 2, depth: 2, childNames: 0 });
  });

  it('[S6-04] is as strict as the record parser: a DOCTYPE is refused, a cut-off document is not an error', async () => {
    expect(await code(scanXmlStructure(bytes('<?xml version="1.0"?><!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>')))).toBe(
      'DOCTYPE_NOT_ALLOWED',
    );
    expect(await code(scanXmlStructure(bytes('<a><b>&nope;</b></a>')))).toBe('MALFORMED');
    const cut = await scanXmlStructure(bytes('<a><b>1</b><b>2</b><b>par'));
    expect(cut.find((s) => s.name === 'b')?.count).toBe(3); // the third was opened before the cut
    expect(await code(scanXmlStructure(bytes('<a><b><c><d/></c></b></a>'), { maxDepth: 3 }))).toBe('DEPTH_EXCEEDED');
  });
});
