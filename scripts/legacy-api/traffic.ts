// pnpm legacy:traffic --logs <file|dir> [--logs …] [--out tests/golden/traffic.json] [--route-param action]
//                     [--prefix /api] [--secret-param key] [--max-cases 8]
//
// Legacy API traffic analysis (S8-01, PLAN §9.3, H2). Streams access logs (nginx/apache "combined" lines or JSON
// lines; `.gz` files too) and reports, per endpoint (method + path template), its request count and share of
// traffic, its parameters (how often each is sent, the most common values), the sites calling it and the
// representative requests the recorder (`pnpm legacy:record`) replays to build golden files.
//
// The report is written without anything identifying: no client IPs or user agents, API keys and other secret
// parameters only as a short hash per site (values never stored), personal fields (email, phone, name, message)
// replaced by `<redacted>`. Raw logs stay outside the repository.
import { createHash } from 'node:crypto';
import { createReadStream, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { createGunzip } from 'node:zlib';

/** One request as read from a log line. */
export interface LoggedRequest {
  method: string;
  /** Path and query as sent (`/api/properties?lang=en`). */
  target: string;
  status: number;
  referer?: string;
}

export interface TrafficOptions {
  /** A query parameter that selects the endpoint (`index.php?action=search`): its value joins the template. */
  routeParams?: string[];
  /** Only paths starting with this prefix count. */
  prefix?: string;
  /** Extra parameter names whose values are secret (API keys are matched by name already). */
  secretParams?: string[];
  /** Representative requests kept per endpoint (default 8). */
  maxCases?: number;
}

export interface ParamStats {
  count: number;
  /** Most frequent values (secret values never; personal values as `<redacted>`). */
  values: Record<string, number>;
  /** Requests whose value was not among the tracked ones. */
  otherValues: number;
}

export interface RepresentativeRequest {
  /** Stable id: hash of method, path and the sorted query. */
  id: string;
  method: string;
  path: string;
  /** Query without secret parameters; the recorder adds the test credentials. */
  query: Record<string, string>;
  /** Requests of the same parameter set (shape) this one stands for. */
  shapeCount: number;
  /** A personal value was redacted: replay needs a hand-made value. */
  redacted: boolean;
}

export interface EndpointReport {
  key: string;
  method: string;
  template: string;
  count: number;
  share: number;
  /** Responses by status class (`2xx`, `3xx`, `4xx`, `5xx`). */
  statuses: Record<string, number>;
  params: Record<string, ParamStats>;
  /** Requests per calling site (`key:<hash>` or the referring host). */
  sites: Record<string, number>;
  cases: RepresentativeRequest[];
}

export interface TrafficReport {
  generatedFrom: { files: number; lines: number; skipped: number };
  total: number;
  /** Parameter names that carry credentials (values never stored). */
  authParams: string[];
  sites: number;
  /** Endpoints by count, highest first. */
  endpoints: EndpointReport[];
  /** The smallest set of top endpoints whose traffic is ≥ 99% of the total. */
  coverage99: string[];
}

const SECRET = /^(api[_-]?key|apikey|key|token|access[_-]?token|auth|secret|password|pass|pwd|signature|sig)$/i;
const PERSONAL = /(e-?mail|phone|tel|mobile|name|message|comment|address|dni|nie)/i;
const VALUES_TRACKED = 30;
const SHAPES_TRACKED = 200;
const EXAMPLES_PER_SHAPE = 20;

const COMBINED = /^\S+ \S+ \S+ \[[^\]]+\] "([A-Z]+) (\S+)(?: [^"]*)?" (\d{3}) \S+(?: "([^"]*)")?/;

/** Parses one access log line: combined format, or a JSON object (`method`, `uri`/`path`/`url`, `status`). */
export function parseLogLine(line: string): LoggedRequest | null {
  const text = line.trim();
  if (text === '') return null;
  if (text.startsWith('{')) {
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return null;
    }
    const method = String(row.method ?? row.request_method ?? '').toUpperCase();
    const target = row.uri ?? row.request_uri ?? row.url ?? row.path;
    const status = Number(row.status ?? row.status_code);
    if (!/^[A-Z]+$/.test(method) || typeof target !== 'string' || !Number.isInteger(status)) return null;
    const referer = row.referer ?? row.http_referer;
    return { method, target, status, ...(typeof referer === 'string' && referer ? { referer } : {}) };
  }
  const m = COMBINED.exec(text);
  if (!m?.[1] || !m[2] || !m[3]) return null;
  const referer = m[4] && m[4] !== '-' ? m[4] : undefined;
  return { method: m[1], target: m[2], status: Number(m[3]), ...(referer ? { referer } : {}) };
}

/** A path segment that is an id, a reference or a hash becomes a placeholder. */
function templateSegment(segment: string): string {
  if (/^\d+$/.test(segment)) return '{id}';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return '{uuid}';
  if (/^[0-9a-f]{16,}$/i.test(segment)) return '{hash}';
  if (/^[a-z]{1,4}-?\d{3,}$/i.test(segment)) return '{ref}';
  return segment;
}

/** The endpoint template of a path (`/api/properties/123` → `/api/properties/{id}`). */
export function pathTemplate(path: string, query: URLSearchParams, routeParams: readonly string[] = []): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    decoded = path;
  }
  const template = decoded
    .replace(/\/{2,}/g, '/')
    .split('/')
    .map(templateSegment)
    .join('/');
  const route = routeParams
    .filter((p) => query.has(p))
    .map((p) => `${p}=${query.get(p)}`)
    .join('&');
  return route ? `${template}?${route}` : template;
}

const shortHash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 10);

function refererHost(referer: string | undefined): string | null {
  if (!referer) return null;
  try {
    return new URL(referer).host.toLowerCase() || null;
  } catch {
    return null;
  }
}

interface Example {
  method: string;
  path: string;
  query: Record<string, string>;
  redacted: boolean;
  n: number;
}

interface ShapeAcc {
  count: number;
  examples: Map<string, Example>;
}

interface EndpointAcc {
  method: string;
  template: string;
  count: number;
  statuses: Record<string, number>;
  params: Map<string, { count: number; values: Map<string, number>; otherValues: number }>;
  sites: Map<string, number>;
  shapes: Map<string, ShapeAcc>;
  otherShapes: number;
}

/** Aggregates requests into a traffic report. Feed it with `add`, read it with `report`. */
export class TrafficAnalyzer {
  private readonly endpoints = new Map<string, EndpointAcc>();
  private readonly authParams = new Set<string>();
  private readonly allSites = new Set<string>();
  private readonly secret: (name: string) => boolean;
  private total = 0;
  lines = 0;
  skipped = 0;
  files = 0;

  constructor(private readonly opts: TrafficOptions = {}) {
    const extra = new Set((opts.secretParams ?? []).map((p) => p.toLowerCase()));
    this.secret = (name) => SECRET.test(name) || extra.has(name.toLowerCase());
  }

  addLine(line: string): void {
    this.lines++;
    const req = parseLogLine(line);
    if (req) this.add(req);
    else if (line.trim() !== '') this.skipped++;
  }

  add(req: LoggedRequest): void {
    let url: URL;
    try {
      url = new URL(req.target, 'http://legacy.invalid');
    } catch {
      this.skipped++;
      return;
    }
    if (this.opts.prefix && !url.pathname.startsWith(this.opts.prefix)) return;
    this.total++;
    const template = pathTemplate(url.pathname, url.searchParams, this.opts.routeParams);
    const key = `${req.method} ${template}`;
    let ep = this.endpoints.get(key);
    if (!ep) {
      ep = {
        method: req.method,
        template,
        count: 0,
        statuses: {},
        params: new Map(),
        sites: new Map(),
        shapes: new Map(),
        otherShapes: 0,
      };
      this.endpoints.set(key, ep);
    }
    ep.count++;
    const statusClass = `${Math.floor(req.status / 100)}xx`;
    ep.statuses[statusClass] = (ep.statuses[statusClass] ?? 0) + 1;

    let site: string | null = null;
    let redacted = false;
    const query: Record<string, string> = {};
    for (const [name, raw] of url.searchParams) {
      let param = ep.params.get(name);
      if (!param) {
        param = { count: 0, values: new Map(), otherValues: 0 };
        ep.params.set(name, param);
      }
      param.count++;
      if (this.secret(name)) {
        this.authParams.add(name);
        site ??= `key:${shortHash(raw)}`;
        continue;
      }
      const personal = PERSONAL.test(name) && raw !== '';
      const value = personal ? '<redacted>' : raw;
      redacted ||= personal;
      query[name] = value;
      const seen = param.values.get(value);
      if (seen !== undefined) param.values.set(value, seen + 1);
      else if (param.values.size < VALUES_TRACKED) param.values.set(value, 1);
      else param.otherValues++;
    }
    site ??= refererHost(req.referer) ?? 'unknown';
    this.allSites.add(site);
    ep.sites.set(site, (ep.sites.get(site) ?? 0) + 1);

    // Representative requests: one shape per parameter set, a few distinct examples each (2xx answers only:
    // an error answer of the legacy API is not a query worth recording).
    const shapeKey = Object.keys(query).sort().join('&');
    let shape = ep.shapes.get(shapeKey);
    if (!shape) {
      if (ep.shapes.size >= SHAPES_TRACKED) {
        ep.otherShapes++;
        return;
      }
      shape = { count: 0, examples: new Map() };
      ep.shapes.set(shapeKey, shape);
    }
    shape.count++;
    if (req.status < 200 || req.status >= 300) return;
    const sorted = Object.fromEntries(Object.entries(query).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    const exampleKey = new URLSearchParams(sorted).toString();
    const example = shape.examples.get(exampleKey);
    if (example) example.n++;
    else if (shape.examples.size < EXAMPLES_PER_SHAPE)
      shape.examples.set(exampleKey, { method: req.method, path: url.pathname, query: sorted, redacted, n: 1 });
  }

  report(): TrafficReport {
    const maxCases = this.opts.maxCases ?? 8;
    const endpoints = [...this.endpoints.entries()]
      .map(([key, ep]): EndpointReport => {
        const params: Record<string, ParamStats> = {};
        for (const [name, p] of [...ep.params.entries()].sort((a, b) => b[1].count - a[1].count)) {
          const secret = this.secret(name);
          params[name] = {
            count: p.count,
            values: secret ? {} : Object.fromEntries([...p.values.entries()].sort((a, b) => b[1] - a[1])),
            otherValues: secret ? 0 : p.otherValues,
          };
        }
        return {
          key,
          method: ep.method,
          template: ep.template,
          count: ep.count,
          share: this.total === 0 ? 0 : ep.count / this.total,
          statuses: ep.statuses,
          params,
          sites: Object.fromEntries([...ep.sites.entries()].sort((a, b) => b[1] - a[1])),
          cases: pickCases(ep, maxCases),
        };
      })
      .sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1));
    return {
      generatedFrom: { files: this.files, lines: this.lines, skipped: this.skipped },
      total: this.total,
      authParams: [...this.authParams].sort(),
      sites: this.allSites.size,
      endpoints,
      coverage99: coverageSet(endpoints, 0.99),
    };
  }
}

/** Shapes by traffic until 99% of the endpoint's requests are stood for (or `max` cases): each shape's commonest
 * example; remaining room goes to more examples of the top shape. */
function pickCases(ep: EndpointAcc, max: number): RepresentativeRequest[] {
  const shapes = [...ep.shapes.values()].filter((s) => s.examples.size > 0).sort((a, b) => b.count - a.count);
  const picked: { ex: Example; shapeCount: number }[] = [];
  let stood = 0;
  for (const shape of shapes) {
    if (picked.length >= max || stood >= ep.count * 0.99) break;
    const best = [...shape.examples.values()].sort((a, b) => b.n - a.n)[0];
    if (best) picked.push({ ex: best, shapeCount: shape.count });
    stood += shape.count;
  }
  const top = shapes[0];
  if (top) {
    for (const ex of [...top.examples.values()].sort((a, b) => b.n - a.n).slice(1)) {
      if (picked.length >= max) break;
      picked.push({ ex, shapeCount: top.count });
    }
  }
  return picked.map(({ ex, shapeCount }) => ({
    id: caseId(ex.method, ex.path, ex.query),
    method: ex.method,
    path: ex.path,
    query: ex.query,
    shapeCount,
    redacted: ex.redacted,
  }));
}

export function caseId(method: string, path: string, query: Record<string, string>): string {
  const sorted = Object.entries(query).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return shortHash(`${method} ${path}?${new URLSearchParams(sorted).toString()}`).slice(0, 12);
}

/** The top endpoints (by count) whose traffic together reaches `share` of the total. */
export function coverageSet(endpoints: readonly { key: string; count: number }[], share: number): string[] {
  const total = endpoints.reduce((n, e) => n + e.count, 0);
  const out: string[] = [];
  let sum = 0;
  for (const e of [...endpoints].sort((a, b) => b.count - a.count)) {
    if (total === 0 || sum >= total * share) break;
    out.push(e.key);
    sum += e.count;
  }
  return out;
}

function logFiles(paths: readonly string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    if (statSync(p).isDirectory()) {
      for (const name of readdirSync(p).sort()) {
        const full = join(p, name);
        if (statSync(full).isFile()) out.push(full);
      }
    } else out.push(p);
  }
  return out;
}

/** Streams every log file (`.gz` decompressed) through an analyzer. */
export async function analyzeLogs(paths: readonly string[], opts: TrafficOptions = {}): Promise<TrafficReport> {
  const analyzer = new TrafficAnalyzer(opts);
  for (const file of logFiles(paths)) {
    analyzer.files++;
    const raw = createReadStream(file);
    const input = file.endsWith('.gz') ? raw.pipe(createGunzip()) : raw;
    for await (const line of createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })) analyzer.addLine(line);
  }
  return analyzer.report();
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      logs: { type: 'string', multiple: true },
      out: { type: 'string', default: join(import.meta.dirname, '..', '..', 'tests', 'golden', 'traffic.json') },
      'route-param': { type: 'string', multiple: true },
      'secret-param': { type: 'string', multiple: true },
      prefix: { type: 'string' },
      'max-cases': { type: 'string', default: '8' },
    },
  });
  if (!values.logs?.length) throw new TypeError('pass --logs <file|dir> (raw logs stay outside the repository)');
  const report = await analyzeLogs(values.logs, {
    routeParams: values['route-param'] ?? [],
    secretParams: values['secret-param'] ?? [],
    ...(values.prefix ? { prefix: values.prefix } : {}),
    maxCases: Number(values['max-cases']),
  });
  writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `${report.total} requests, ${report.endpoints.length} endpoints, ${report.sites} sites; ` +
      `${report.coverage99.length} endpoint(s) carry 99% → ${values.out}`,
  );
  if (report.generatedFrom.skipped > 0) console.warn(`warning: ${report.generatedFrom.skipped} unreadable line(s)`);
  console.log(`next: LEGACY_API_BASE_URL=… LEGACY_API_KEY=… pnpm legacy:record --traffic ${values.out}`);
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
