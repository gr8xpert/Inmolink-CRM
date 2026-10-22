// pnpm legacy:record [--traffic tests/golden/traffic.json] [--out tests/golden] [--volatile <key>] [--delay-ms 250]
// pnpm legacy:record --check [--traffic …] [--out …]
//
// Legacy API golden files (S8-01, PLAN §9.3, H2). Replays the representative requests of the traffic report
// (`pnpm legacy:traffic`) against the legacy API, one at a time, and stores each normalized answer as
// `<out>/<endpoint>/<case>.json` — the parity target of the v1 shim (S8-02). Normalized: JSON objects with sorted
// keys and volatile fields (server time, request ids, timings, `--volatile`) replaced by `<volatile>`; the legacy
// base URL replaced by `{LEGACY_BASE}`; text answers with LF line ends and no trailing spaces.
// --check: exits 1 unless every endpoint of the report's 99% set has at least one golden file.
//
// Only GET/HEAD cases are replayed; another method, or a case with a redacted personal value, is listed as manual
// (write its golden file by hand from a test account). Records from the H2 test account only.
//
// Env: LEGACY_API_BASE_URL (https), LEGACY_API_KEY (test credentials; sent as the report's auth parameter, or
// LEGACY_API_KEY_PARAM). The key is never written to a golden file or printed.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import type { EndpointReport, RepresentativeRequest, TrafficReport } from './traffic';

const ROOT = join(import.meta.dirname, '..', '..');
const VOLATILE =
  /^(time|timestamp|server_?time|now|generated(_?at)?|request_?id|trace_?id|took|elapsed|duration|query_?time|cached_?at|expires)$/i;

export interface GoldenFile {
  endpoint: string;
  case: string;
  request: { method: string; path: string; query: Record<string, string> };
  response: { status: number; contentType: string; json?: unknown; text?: string };
}

/** The directory name of an endpoint (`GET /api/properties/{id}` → `get_api_properties_id`). */
export function endpointSlug(key: string): string {
  return key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Sorted keys, volatile fields masked, the legacy base URL replaced. Arrays keep their order (parity cares). */
export function normalizeJson(value: unknown, base: string, volatile: RegExp = VOLATILE): unknown {
  if (Array.isArray(value)) return value.map((v) => normalizeJson(v, base, volatile));
  if (typeof value === 'string') return base ? value.replaceAll(base, '{LEGACY_BASE}') : value;
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const v = (value as Record<string, unknown>)[key];
    out[key] = volatile.test(key) && v !== null ? '<volatile>' : normalizeJson(v, base, volatile);
  }
  return out;
}

export function normalizeText(text: string, base: string): string {
  const replaced = base ? text.replaceAll(base, '{LEGACY_BASE}') : text;
  return replaced
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .trimEnd();
}

export interface RecordOptions {
  baseUrl: string;
  apiKey: string;
  keyParam: string;
  outDir: string;
  volatile?: RegExp;
  delayMs?: number;
  fetch?: typeof fetch;
}

export interface RecordResult {
  recorded: string[];
  manual: string[];
  failed: { case: string; error: string }[];
}

const replayable = (c: RepresentativeRequest) => (c.method === 'GET' || c.method === 'HEAD') && !c.redacted;

/** Replays each endpoint's cases and writes their golden files (an existing file is overwritten). */
export async function recordGolden(report: TrafficReport, opts: RecordOptions): Promise<RecordResult> {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const doFetch = opts.fetch ?? fetch;
  const result: RecordResult = { recorded: [], manual: [], failed: [] };
  for (const ep of report.endpoints) {
    for (const c of ep.cases) {
      const label = `${ep.key} ${c.id}`;
      if (!replayable(c)) {
        result.manual.push(label);
        continue;
      }
      const url = new URL(base + c.path);
      for (const [k, v] of Object.entries(c.query)) url.searchParams.set(k, v);
      url.searchParams.set(opts.keyParam, opts.apiKey);
      try {
        const res = await doFetch(url, {
          method: c.method,
          headers: { accept: 'application/json, application/xml;q=0.9, */*;q=0.5' },
          redirect: 'manual',
          signal: AbortSignal.timeout(30_000),
        });
        const contentType = (res.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
        const body = await res.text();
        const response: GoldenFile['response'] = { status: res.status, contentType };
        let json: unknown;
        if (contentType.includes('json')) {
          try {
            json = JSON.parse(body);
          } catch {
            json = undefined;
          }
        }
        if (json !== undefined) response.json = normalizeJson(json, base, opts.volatile);
        else response.text = normalizeText(body, base);
        const file: GoldenFile = {
          endpoint: ep.key,
          case: c.id,
          request: { method: c.method, path: c.path, query: c.query },
          response,
        };
        const dir = join(opts.outDir, endpointSlug(ep.key));
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${c.id}.json`), `${JSON.stringify(file, null, 2)}\n`);
        result.recorded.push(label);
      } catch (err) {
        // The URL carries the key: report only the case and the error's class/message without it.
        const message = err instanceof Error ? err.message : String(err);
        result.failed.push({ case: label, error: message.replaceAll(opts.apiKey, '<key>') });
      }
      if (opts.delayMs) await sleep(opts.delayMs);
    }
  }
  return result;
}

export interface CoverageResult {
  /** Share of all traffic whose endpoint has at least one golden file. */
  coveredShare: number;
  /** Endpoints of the 99% set without a golden file. */
  missing: string[];
}

/** Which endpoints of the report have golden files in `outDir`. */
export function goldenCoverage(report: TrafficReport, outDir: string): CoverageResult {
  const has = (ep: EndpointReport) => {
    const dir = join(outDir, endpointSlug(ep.key));
    return existsSync(dir) && readdirSync(dir).some((f) => f.endsWith('.json'));
  };
  const required = new Set(report.coverage99);
  let covered = 0;
  const missing: string[] = [];
  for (const ep of report.endpoints) {
    if (has(ep)) covered += ep.count;
    else if (required.has(ep.key)) missing.push(ep.key);
  }
  return { coveredShare: report.total === 0 ? 0 : covered / report.total, missing };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      traffic: { type: 'string', default: join(ROOT, 'tests', 'golden', 'traffic.json') },
      out: { type: 'string', default: join(ROOT, 'tests', 'golden') },
      volatile: { type: 'string', multiple: true },
      'delay-ms': { type: 'string', default: '250' },
      check: { type: 'boolean', default: false },
    },
  });
  const report = JSON.parse(readFileSync(values.traffic, 'utf8')) as TrafficReport;
  if (values.check) {
    const { coveredShare, missing } = goldenCoverage(report, values.out);
    console.log(`golden files cover ${(coveredShare * 100).toFixed(2)}% of legacy traffic`);
    if (missing.length > 0) {
      console.error(`missing golden files for the 99% set:\n- ${missing.join('\n- ')}`);
      process.exit(1);
    }
    return;
  }
  const baseUrl = process.env.LEGACY_API_BASE_URL ?? '';
  const apiKey = process.env.LEGACY_API_KEY ?? '';
  if (!/^https:\/\//.test(baseUrl) || !apiKey)
    throw new TypeError('set LEGACY_API_BASE_URL (https) and LEGACY_API_KEY');
  const keyParam = process.env.LEGACY_API_KEY_PARAM ?? report.authParams[0];
  if (!keyParam) throw new TypeError('the report found no auth parameter: set LEGACY_API_KEY_PARAM');
  const extra = values.volatile ?? [];
  const volatile = extra.length
    ? new RegExp(`${VOLATILE.source}|^(${extra.map((v) => v.replace(/[^\w-]/g, '')).join('|')})$`, 'i')
    : VOLATILE;
  const result = await recordGolden(report, {
    baseUrl,
    apiKey,
    keyParam,
    outDir: values.out,
    volatile,
    delayMs: Number(values['delay-ms']),
  });
  console.log(`recorded ${result.recorded.length}, manual ${result.manual.length}, failed ${result.failed.length}`);
  for (const m of result.manual) console.log(`manual: ${m}`);
  for (const f of result.failed) console.error(`failed: ${f.case}: ${f.error}`);
  const { coveredShare, missing } = goldenCoverage(report, values.out);
  console.log(`golden files cover ${(coveredShare * 100).toFixed(2)}% of legacy traffic`);
  if (missing.length > 0) console.warn(`99% set still missing:\n- ${missing.join('\n- ')}`);
  if (result.failed.length > 0 || missing.length > 0) process.exit(1);
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
