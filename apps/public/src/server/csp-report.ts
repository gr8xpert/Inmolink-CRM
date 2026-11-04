import { createLogger } from '@inmolink/platform/logger';
import { rateLimiter } from '@inmolink/platform/rate-limit';
import { clientAddress } from './embed';

/**
 * S16-F8: the portal's CSP violation reports (`report-uri /api/csp-report`). Browsers post them on their own; anyone
 * can post anything here, so: per-IP limited (`CSP_REPORT_LIMIT_PER_MINUTE`; fails open — dropped reports are only
 * lost logs), bodies read up to `MAX_REPORT_BYTES` through a counting reader (a declared length is never trusted), and
 * only three facts are logged — the violated directive, the blocked resource's origin (or `inline` / `eval`) and the
 * page's path. Never the query string, the referrer, the script sample, the client address or any other field.
 */

export const MAX_REPORT_BYTES = 8 * 1024;
export const CSP_REPORT_LIMIT_PER_MINUTE = 30;
const MAX_REPORTS_PER_POST = 10;
const TYPES = new Set(['application/csp-report', 'application/reports+json', 'application/json']);

const log = createLogger({ service: 'public', level: process.env.LOG_LEVEL ?? 'info' });

export interface CspViolation {
  directive: string;
  blocked: string;
  path: string;
}

const DIRECTIVE = /^[a-z-]{1,40}$/;

/** `inline`, `eval`, … or a URL's origin; anything else is `other` (a URL's path or query never leaves). */
function blockedOf(raw: unknown): string {
  if (typeof raw !== 'string' || raw === '') return 'none';
  if (/^(?:inline|eval|wasm-eval|trusted-types-[a-z]+|self)$/.test(raw)) return raw;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : `${u.protocol}`;
  } catch {
    return 'other';
  }
}

function pathOf(raw: unknown): string {
  if (typeof raw !== 'string') return 'unknown';
  try {
    return new URL(raw).pathname.slice(0, 200);
  } catch {
    return 'unknown';
  }
}

/** The violations in a report body (`report-uri`'s `{"csp-report": …}` or Reporting API's `[{type, body}]`). */
export function violationsOf(body: unknown): CspViolation[] {
  const reports: Record<string, unknown>[] = [];
  if (Array.isArray(body)) {
    for (const r of body.slice(0, MAX_REPORTS_PER_POST)) {
      const rec = r as { type?: unknown; body?: unknown };
      if (rec?.type === 'csp-violation' && rec.body && typeof rec.body === 'object') {
        const b = rec.body as Record<string, unknown>;
        reports.push({ directive: b.effectiveDirective, blocked: b.blockedURL, page: b.documentURL });
      }
    }
  } else if (body && typeof body === 'object' && 'csp-report' in body) {
    const b = (body as { 'csp-report': unknown })['csp-report'] as Record<string, unknown> | null;
    if (b && typeof b === 'object') {
      reports.push({
        directive: b['effective-directive'] ?? b['violated-directive'],
        blocked: b['blocked-uri'],
        page: b['document-uri'],
      });
    }
  }
  return reports.map((r) => {
    const directive = typeof r.directive === 'string' ? (r.directive.split(' ')[0] ?? '') : '';
    return {
      directive: DIRECTIVE.test(directive) ? directive : 'unknown',
      blocked: blockedOf(r.blocked),
      path: pathOf(r.page),
    };
  });
}

async function readCapped(request: Request): Promise<string | null> {
  const declared = request.headers.get('content-length');
  if (declared !== null && !(Number(declared) <= MAX_REPORT_BYTES)) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REPORT_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

const answer = (status: number) => new Response(null, { status, headers: { 'Cache-Control': 'no-store' } });

export async function cspReportResponse(
  request: Request,
  logViolation: (v: CspViolation) => void = (v) => log.warn({ csp: v }, 'csp violation'),
): Promise<Response> {
  const type = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (!TYPES.has(type)) return answer(415);
  const { bucket } = await clientAddress(request.headers.get('x-forwarded-for'));
  const limit = await rateLimiter().consume(
    { name: 'public.csp-report', scope: 'ip', limit: CSP_REPORT_LIMIT_PER_MINUTE, windowSeconds: 60 },
    bucket,
  );
  if (!limit.allowed) return answer(429);
  const text = await readCapped(request);
  if (text === null) return answer(413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return answer(400);
  }
  for (const v of violationsOf(body)) logViolation(v);
  return answer(204);
}
