import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import {
  endpointSlug,
  type GoldenFile,
  goldenCoverage,
  keyForms,
  normalizeJson,
  normalizeText,
  recordGolden,
} from '../../scripts/legacy-api/record';
import { formatFinding, scanPaths, scanValue } from '../../scripts/legacy-api/scan';
import { analyzeLogs, parseLogLine, pathTemplate } from '../../scripts/legacy-api/traffic';

// Synthetic legacy traffic (H2 logs not provided yet): 2 sites by API key, 1 by referer only, 5 endpoints, the
// last one 0.5% of the traffic. Lines carry client IPs, user agents, keys and an email the report must not keep.
const KEY_A = 'a1b2c3d4e5f6secretA';
const KEY_B = 'zz99secretB';
const line = (ip: string, method: string, target: string, status: number, referer = '-') =>
  `${ip} - - [21/Oct/2026:10:00:00 +0200] "${method} ${target} HTTP/1.1" ${status} 512 "${referer}" "Mozilla/5.0 (X11)"`;

function syntheticLog(): string[] {
  const lines: string[] = [];
  for (let i = 0; i < 1000; i++) {
    const key = i % 3 === 0 ? KEY_B : KEY_A;
    const ip = `203.0.113.${i % 250}`;
    const r = i % 200;
    if (r < 110) {
      const lang = ['en', 'es', 'de'][i % 3];
      const extra = i % 2 === 0 ? `&price_max=${300000 + (i % 4) * 100000}` : '';
      lines.push(line(ip, 'GET', `/api/properties?lang=${lang}&page=${(i % 5) + 1}${extra}&api_key=${key}`, 200));
    } else if (r < 170) lines.push(line(ip, 'GET', `/api/properties/${1000 + (i % 40)}?lang=en&api_key=${key}`, 200));
    else if (r < 186) lines.push(line(ip, 'GET', `/api/locations?lang=es&api_key=${key}`, 200));
    else if (r < 199) {
      // A site that sends no key: attributed by its referring host.
      lines.push(line(ip, 'GET', '/api/types?lang=en', 200, 'https://www.villas-example.es/buscar'));
    } else lines.push(line(ip, 'POST', `/api/contact?email=buyer%40example.com&api_key=${key}`, 200));
  }
  lines.push('not a log line', '');
  return lines;
}

const dir = mkdtempSync(join(tmpdir(), 'legacy-api-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function fixtureReport() {
  const logs = join(dir, 'logs');
  const all = syntheticLog();
  rmSync(logs, { recursive: true, force: true });
  const half = Math.floor(all.length / 2);
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(logs, 'access.log'), all.slice(0, half).join('\n'));
  writeFileSync(join(logs, 'access.log.1.gz'), gzipSync(all.slice(half).join('\r\n')));
  return analyzeLogs([logs]);
}

/** A stand-in legacy API: JSON for properties, XML for types, a timestamp and the base URL in every JSON body. */
const legacyFetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.searchParams.get('api_key') !== 'test-key') return new Response('forbidden', { status: 403 });
  if (url.pathname === '/api/types')
    return new Response('<types>\r\n  <type id="1">Villa</type>   \r\n</types>\r\n', {
      headers: { 'content-type': 'application/xml; charset=utf-8' },
    });
  return Response.json({
    took: Math.random(),
    path: url.pathname,
    image: 'https://legacy.example.test/img/1.jpg',
    z: 1,
    a: [{ b: 2, a: 1 }],
  });
}) as typeof fetch;

describe('legacy API capture and golden files (S8-01)', () => {
  it('[S8-01] traffic analysis reports endpoints, parameters and frequencies per site', async () => {
    const report = await fixtureReport();
    expect(report.total).toBe(1000);
    expect(report.generatedFrom).toEqual({ files: 2, lines: 1001, skipped: 1 });
    expect(report.authParams).toEqual(['api_key']);
    expect(report.endpoints.map((e) => [e.key, e.count])).toEqual([
      ['GET /api/properties', 550],
      ['GET /api/properties/{id}', 300],
      ['GET /api/locations', 80],
      ['GET /api/types', 65],
      ['POST /api/contact', 5],
    ]);
    const list = report.endpoints[0];
    expect(list?.share).toBeCloseTo(0.55);
    expect(list?.params.lang?.count).toBe(550);
    expect(Object.keys(list?.params.lang?.values ?? {}).sort()).toEqual(['de', 'en', 'es']);
    expect(list?.params.price_max?.count).toBe(275);
    // Three sites: two by key hash, one by referer.
    expect(report.sites).toBe(3);
    expect(Object.keys(report.endpoints[3]?.sites ?? {})).toEqual(['www.villas-example.es']);
    expect(Object.keys(list?.sites ?? {}).every((s) => /^key:[0-9a-f]{10}$/.test(s))).toBe(true);
    // Both parameter shapes of the list endpoint are represented.
    const shapes = new Set(list?.cases.map((c) => Object.keys(c.query).sort().join('&')));
    expect(shapes).toEqual(new Set(['lang&page', 'lang&page&price_max']));
    // The 0.5% endpoint is outside the 99% set.
    expect(report.coverage99).toEqual([
      'GET /api/properties',
      'GET /api/properties/{id}',
      'GET /api/locations',
      'GET /api/types',
    ]);
  });

  it('[S8-01] the report keeps no client IP, user agent, API key or personal value', async () => {
    const text = JSON.stringify(await fixtureReport());
    for (const leak of [KEY_A, KEY_B, '203.0.113.', 'Mozilla', 'buyer@example.com', 'buyer%40example.com'])
      expect(text).not.toContain(leak);
    expect(text).toContain('<redacted>');
  });

  it('[S8-01] the endpoints covering ≥ 99% of legacy traffic have golden files', async () => {
    const report = await fixtureReport();
    const out = join(dir, 'golden');
    expect(goldenCoverage(report, out).missing).toHaveLength(4);
    const result = await recordGolden(report, {
      baseUrl: 'https://legacy.example.test/',
      apiKey: 'test-key',
      keyParam: 'api_key',
      outDir: out,
      fetch: legacyFetch,
    });
    expect(result.failed).toEqual([]);
    // The POST with an email is not replayed: its golden file is written by hand.
    expect(result.manual).toEqual([expect.stringMatching(/^POST \/api\/contact /)]);
    const coverage = goldenCoverage(report, out);
    expect(coverage.missing).toEqual([]);
    expect(coverage.coveredShare).toBeGreaterThanOrEqual(0.99);

    const files = readdirSync(join(out, endpointSlug('GET /api/properties/{id}')));
    const golden = JSON.parse(readFileSync(join(out, 'get_api_properties_id', files[0] ?? ''), 'utf8')) as GoldenFile;
    expect(golden.response).toMatchObject({ status: 200, contentType: 'application/json' });
    expect(golden.response.json).toEqual({
      a: [{ a: 1, b: 2 }],
      image: '{LEGACY_BASE}/img/1.jpg',
      path: golden.request.path,
      took: '<volatile>',
      z: 1,
    });
    expect(Object.keys(golden.request.query)).not.toContain('api_key');
    const xml = JSON.parse(
      readFileSync(join(out, 'get_api_types', readdirSync(join(out, 'get_api_types'))[0] ?? ''), 'utf8'),
    ) as GoldenFile;
    expect(xml.response.text).toBe('<types>\n  <type id="1">Villa</type>\n</types>');
    // Recording twice gives byte-identical files (stable ids, normalized volatile fields).
    const before = readFileSync(join(out, 'get_api_properties_id', files[0] ?? ''), 'utf8');
    await recordGolden(report, {
      baseUrl: 'https://legacy.example.test',
      apiKey: 'test-key',
      keyParam: 'api_key',
      outDir: out,
      fetch: legacyFetch,
    });
    expect(readFileSync(join(out, 'get_api_properties_id', files[0] ?? ''), 'utf8')).toBe(before);
    expect(readdirSync(out).join()).not.toContain('test-key');
  });

  it('[S8-01] log lines, templates and normalization', () => {
    expect(parseLogLine('{"method":"get","uri":"/api/x?a=1","status":200,"http_referer":"https://s.es/"}')).toEqual({
      method: 'GET',
      target: '/api/x?a=1',
      status: 200,
      referer: 'https://s.es/',
    });
    expect(parseLogLine('{"broken"')).toBeNull();
    const q = new URLSearchParams('action=search&lang=en');
    expect(pathTemplate('/index.php', q, ['action'])).toBe('/index.php?action=search');
    expect(pathTemplate('//api/properties/R1234567/photos/550e8400-e29b-41d4-a716-446655440000', q)).toBe(
      '/api/properties/{ref}/photos/{uuid}',
    );
    expect(normalizeJson({ request_id: 'x', b: null, generated_at: null }, '')).toEqual({
      b: null,
      generated_at: null,
      request_id: '<volatile>',
    });
  });
});

describe('legacy recordings carry no key or personal data (S9-F1)', () => {
  // A key with characters that URL-encode differently (`+`, `/`, `=`), as legacy keys often are.
  const KEY = 'k3y+S9/f1=';
  const encoded = encodeURIComponent(KEY);
  /** A stub legacy API echoing the key back: in a paging link (encoded), raw in XML, and — planted — as a JSON key. */
  const echoingFetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.searchParams.get('api_key') !== KEY) return new Response('forbidden', { status: 403 });
    if (url.pathname === '/api/properties')
      return Response.json({
        next: `https://legacy.example.test/api/properties?page=2&api_key=${encoded}`,
        raw: `key=${KEY}`,
        items: [{ id: 1 }],
      });
    if (url.pathname === '/api/types')
      return new Response(`<types next="/api/types?api_key=${url.searchParams.toString().split('api_key=')[1]}"/>`, {
        headers: { 'content-type': 'application/xml' },
      });
    if (url.pathname.startsWith('/api/properties/')) return Response.json({ [KEY]: true, id: 7 });
    return Response.json({ ok: true });
  }) as typeof fetch;

  it('[S9-F1] a stub API echoing the key in a paging link records <key>, and a planted leftover fails the recording', async () => {
    const report = await fixtureReport();
    const out = join(dir, 'recorded-key');
    const result = await recordGolden(report, {
      baseUrl: 'https://legacy.example.test',
      apiKey: KEY,
      keyParam: 'api_key',
      outDir: out,
      fetch: echoingFetch,
    });
    const list = JSON.parse(
      readFileSync(join(out, 'get_api_properties', readdirSync(join(out, 'get_api_properties'))[0] ?? ''), 'utf8'),
    ) as GoldenFile;
    expect(list.response.json).toMatchObject({
      next: '{LEGACY_BASE}/api/properties?page=2&api_key=<key>',
      raw: 'key=<key>',
    });
    const types = JSON.parse(
      readFileSync(join(out, 'get_api_types', readdirSync(join(out, 'get_api_types'))[0] ?? ''), 'utf8'),
    ) as GoldenFile;
    expect(types.response.text).toBe('<types next="/api/types?api_key=<key>"/>');
    // The detail stub echoes the key as an object key, which normalization does not rewrite: nothing is written.
    expect(result.failed.length).toBeGreaterThan(0);
    for (const f of result.failed) {
      expect(f.case).toMatch(/^GET \/api\/properties\/\{id\} /);
      expect(f.error).toBe('the API key survived normalization: not written');
    }
    expect(readdirSync(out)).not.toContain('get_api_properties_id');
    const written = readdirSync(out, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.json'))
      .map((f) => readFileSync(join(out, f), 'utf8'))
      .join('\n');
    for (const form of keyForms(KEY)) expect(written).not.toContain(form);
    expect(normalizeText(`a ${encoded} b`, '', keyForms(KEY))).toBe('a <key> b');
  });

  it('[S9-F1] a recorded body with an e-mail or phone fails the scan', () => {
    const out = join(dir, 'scan');
    const golden = (name: string, response: GoldenFile['response']) => {
      mkdirSync(join(out, 'get_api_properties_id'), { recursive: true });
      const file: GoldenFile = {
        endpoint: 'GET /api/properties/{id}',
        case: name,
        request: { method: 'GET', path: '/api/properties/1', query: { lang: 'en' } },
        response,
      };
      writeFileSync(join(out, 'get_api_properties_id', `${name}.json`), JSON.stringify(file));
    };
    golden('clean', {
      status: 200,
      contentType: 'application/json',
      json: {
        id: 1234567,
        ref: 'R987654321',
        price: 695000,
        phone_visible: false,
        email: '<redacted>',
        size: '120 m2',
      },
    });
    expect(scanPaths([out])).toEqual([]);

    golden('email', { status: 200, contentType: 'application/json', json: { agent: { note: 'mail ana.p@mail.es' } } });
    golden('phone', { status: 200, contentType: 'application/json', json: { contact: { telefono: '952 123 456' } } });
    golden('xml', {
      status: 200,
      contentType: 'application/xml',
      text: '<p><desc>Call +34 600 11 22 33</desc><ref_catastral>9872023VH5797S0001WX</ref_catastral></p>',
    });
    const findings = scanPaths([out]);
    expect(findings.map((f) => [basename(f.file ?? ''), f.kind, f.path])).toEqual([
      ['email.json', 'email', '$.response.json.agent.note'],
      ['phone.json', 'phone', '$.response.json.contact.telefono'],
      ['xml.json', 'phone', '$.response.text'],
      ['xml.json', 'cadastral', '$.response.text'],
      ['xml.json', 'cadastral', '$.response.text<ref_catastral>'],
    ]);
    // The report masks each value; an allowed public value (the agency's office) is not a finding.
    expect(findings.map(formatFinding).join()).not.toContain('ana.p@mail.es');
    expect(scanPaths([out], ['ANA.P@mail.es']).map((f) => f.kind)).not.toContain('email');
    expect(scanValue({ phones: ['+44 20 7946 0958'] }).map((f) => f.kind)).toEqual(['phone']);
  });
});
