import { describe, expect, it } from 'vitest';
import { childText, streamXmlRecords, type XmlElement } from './index';
import { escapeXmlAttribute, escapeXmlText, XmlWriter } from './writer';

async function parse(xml: string, record: string): Promise<XmlElement[]> {
  const out: XmlElement[] = [];
  const source = (async function* () {
    yield xml;
  })();
  for await (const r of streamXmlRecords(source, { recordElement: record })) out.push(r);
  return out;
}

describe('XmlWriter', () => {
  it('[S7-07] escapes user text and attributes so nothing breaks out of its element', async () => {
    const hostile = `</desc><script>alert(1)</script>]]>&amp; "q" 'a' \u0000\u0007￾\uD800 ok`;
    const w = new XmlWriter();
    w.open('root').open('property', { id: hostile }).leaf('desc', hostile).close().close();
    const xml = w.end();
    expect(xml).not.toContain('<script>');
    expect(xml).not.toContain(']]>');
    const [record] = await parse(xml, 'property');
    // Round trip: the text reads back as written, minus the characters XML 1.0 cannot carry.
    const clean = `</desc><script>alert(1)</script>]]>&amp; "q" 'a'  ok`;
    expect(childText(record as XmlElement, 'desc')).toBe(clean);
    expect(record?.attributes.id).toBe(clean);
  });

  it('[S7-07] refuses names that are not plain XML names, and unbalanced documents', () => {
    expect(() => new XmlWriter().open('a b')).toThrow(TypeError);
    expect(() => new XmlWriter().leaf('x', 'y', { 'on"click': 'z' })).toThrow(TypeError);
    expect(() => new XmlWriter().open('root').end()).toThrow(/unclosed/);
    expect(() => new XmlWriter().close()).toThrow(/nothing to close/);
  });

  it('[S7-07] skips null values, writes numbers and booleans, and streams through take()', () => {
    const w = new XmlWriter({ declaration: false });
    w.open('r').leaf('a', null).leaf('b', undefined).leaf('c', 3).leaf('d', true).leaf('e', '');
    expect(w.pending).toBeGreaterThan(0);
    const first = w.take();
    expect(w.pending).toBe(0);
    w.leaf('f', Number.NaN).close();
    expect(first + w.end()).toBe('<r><c>3</c><d>true</d><e/><f/></r>');
  });

  it('[S7-07] escape helpers keep line breaks in attributes as references', () => {
    expect(escapeXmlText('a<b>&c')).toBe('a&lt;b&gt;&amp;c');
    expect(escapeXmlAttribute('x\ny"')).toBe('x&#10;y&quot;');
  });
});
