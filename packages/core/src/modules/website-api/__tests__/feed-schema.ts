import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateXML } from 'xmllint-wasm';

/**
 * Schema checks of the per-site XML feeds (S7-07): the Kyero v3 and generic schema fixtures, validated by libxml2
 * compiled to WebAssembly (xmllint-wasm, dev dependency: no native build, no network).
 */
const FIXTURES = join(import.meta.dirname, '..', '..', '..', '..', '..', '..', 'tests', 'fixtures');
export const KYERO_XSD = readFileSync(join(FIXTURES, 'kyero', 'kyero-v3.xsd'), 'utf8');
export const GENERIC_XSD = readFileSync(join(FIXTURES, 'website-feed', 'inmolink-feed-v1.xsd'), 'utf8');

export async function schemaErrors(xml: string, xsd: string): Promise<string[]> {
  const result = await validateXML({
    xml: [{ fileName: 'feed.xml', contents: xml }],
    schema: [xsd],
    maxMemoryPages: 16 * 1024,
  });
  return result.valid ? [] : result.errors.map((e) => e.rawMessage);
}
