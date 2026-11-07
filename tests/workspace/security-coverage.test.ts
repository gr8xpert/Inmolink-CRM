import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');

/** Every Next route handler (`route.ts[x]`) of an app, as a repo-relative path with forward slashes. */
function routeHandlers(app: 'web' | 'public'): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/^route\.tsx?$/.test(name)) found.push(relative(ROOT, p).replaceAll('\\', '/'));
    }
  };
  walk(join(ROOT, 'apps', app, 'src', 'app'));
  return found.sort();
}

/**
 * S16-03 rate-limit coverage of the Next apps' route handlers (the Fastify apps have theirs in
 * `apps/{api,feed-api}/src/rate-limit-coverage.test.ts`). Each handler names how it is limited and a piece of its
 * source (or of the module it delegates to) that proves it; a new handler fails here until it is added.
 * Pages are limited by the proxies (portal page gate, embed gate) and server actions by the api they call.
 */
const HANDLER_LIMITS: Readonly<Record<string, { how: string; evidence: [file: string, text: string] }>> = {
  'apps/web/src/app/api/auth/[...nextauth]/route.ts': {
    how: 'Auth.js: credential logins limited per IP / email / IP+email before the password check (S1-F5)',
    evidence: ['apps/web/src/server/login.ts', 'checkLimits'],
  },
  'apps/web/src/app/api/contacts/import/route.ts': {
    how: 'session required; upload slots (1 per user, 4 per process), then the api upload route (its own rules)',
    evidence: ['apps/web/src/app/api/contacts/import/route.ts', 'createUploadSlots'],
  },
  'apps/web/src/app/api/deals/[id]/documents/route.ts': {
    how: 'R2-04c: session required; per-user upload slots, then the api upload route (its own rules)',
    evidence: ['apps/web/src/app/api/deals/[id]/documents/route.ts', 'upload-slots'],
  },
  'apps/web/src/app/api/forms/[id]/verify/route.ts': {
    how: 'R2-05c: session required; per-user upload slots, then the api verify route (its own rules)',
    evidence: ['apps/web/src/app/api/forms/[id]/verify/route.ts', 'upload-slots'],
  },
  'apps/web/src/app/api/developments/[id]/documents/route.ts': {
    how: 'session required; per-user upload slots, then the api upload route (its own rules)',
    evidence: ['apps/web/src/app/api/developments/[id]/documents/route.ts', 'upload-slots'],
  },
  'apps/web/src/app/api/developments/[id]/units/kyero/route.ts': {
    how: 'R2-07a: session required; per-user upload slots, then the api Kyero units route (its own rules)',
    evidence: ['apps/web/src/app/api/developments/[id]/units/kyero/route.ts', 'upload-slots'],
  },
  'apps/web/src/app/api/listings/[id]/documents/route.ts': {
    how: 'session required; per-user upload slots, then the api upload route',
    evidence: ['apps/web/src/app/api/listings/[id]/documents/route.ts', 'upload-slots'],
  },
  'apps/web/src/app/api/imports/mapper/sample/route.ts': {
    how: 'session required; own per-user rule (rateLimiter) before the api call',
    evidence: ['apps/web/src/app/api/imports/mapper/sample/route.ts', '@inmolink/platform/rate-limit'],
  },
  'apps/web/src/app/api/imports/sheet/route.ts': {
    how: 'session required; own per-user rule (rateLimiter) before the api upload',
    evidence: ['apps/web/src/app/api/imports/sheet/route.ts', '@inmolink/platform/rate-limit'],
  },
  'apps/web/src/app/api/support/tickets/[id]/attachments/route.ts': {
    how: 'session required; relays to the api upload route (its own rules)',
    evidence: ['apps/web/src/app/api/support/tickets/[id]/attachments/route.ts', 'uploadSupportAttachment'],
  },
  'apps/web/src/app/api/verification/documents/route.ts': {
    how: 'session required; relays to the api upload route (its own rules)',
    evidence: ['apps/web/src/app/api/verification/documents/route.ts', 'uploadVerificationDocument'],
  },
  'apps/web/src/app/healthz/route.ts': {
    how: 'exempt: liveness probe, no work',
    evidence: ['apps/web/src/app/healthz/route.ts', 'GET'],
  },
  'apps/web/src/app/session/expired/route.ts': {
    how: 'exempt: signs the browser out and redirects; no lookup',
    evidence: ['apps/web/src/app/session/expired/route.ts', 'GET'],
  },
  'apps/web/src/app/session/impersonation-ended/route.ts': {
    how: 'session required; one read through the api (its own per-user limit), then a cookie update and a redirect',
    evidence: ['apps/web/src/app/session/impersonation-ended/route.ts', 'fetchStaffMe'],
  },
  'apps/web/src/app/session/token/route.ts': {
    how: 'per-session token mint limits (checkLimits)',
    evidence: ['apps/web/src/app/session/token/route.ts', 'checkLimits'],
  },
  'apps/public/src/app/api/csp-report/route.ts': {
    how: 'S16-F8: per-IP report limit, body capped at 8 KB (CSP report service)',
    evidence: ['apps/public/src/server/csp-report.ts', 'rateLimiter'],
  },
  'apps/public/src/app/api/portal/enquiry/route.ts': {
    how: 'Turnstile + per-IP enquiry limits (portal enquiry service)',
    evidence: ['apps/public/src/portal/enquiry.ts', 'rateLimiter'],
  },
  'apps/public/src/app/embed/[site]/[lang]/listing/[ref]/route.ts': {
    how: 'embed gate in the proxy (per-client page limit) + per-IP lead limits in the handler',
    evidence: ['apps/public/src/embed/handlers.tsx', 'rateLimiter'],
  },
  'apps/public/src/app/embed/[site]/[lang]/route.ts': {
    how: 'embed gate in the proxy (per-client page limit); CDN-cached per URL',
    evidence: ['apps/public/src/proxy.ts', 'embedPath'],
  },
  'apps/public/src/app/embed-assets/[file]/route.ts': {
    how: 'exempt: two static files, immutable, served by the CDN',
    evidence: ['apps/public/src/app/embed-assets/[file]/route.ts', 'immutable'],
  },
  'apps/public/src/app/healthz/route.ts': {
    how: 'exempt: liveness probe, no work',
    evidence: ['apps/public/src/app/healthz/route.ts', 'GET'],
  },
  'apps/public/src/app/robots.txt/route.ts': {
    how: 'exempt: a constant text, CDN-cached',
    evidence: ['apps/public/src/portal/sitemaps.ts', 'robotsResponse'],
  },
  'apps/public/src/app/s/[token]/route.ts': {
    how: 'per-IP selection page / action limits (selections handlers)',
    evidence: ['apps/public/src/selections/handlers.ts', 'rateLimiter'],
  },
  'apps/public/src/app/u/[token]/route.ts': {
    how: 'per-IP and per-link unsubscribe limits (crm.checkUnsubscribeLimits, R2-02g)',
    evidence: ['apps/public/src/unsubscribe/handlers.ts', 'checkUnsubscribeLimits(rateLimiter()'],
  },
  'apps/public/src/app/sign/[token]/route.ts': {
    how: 'R2-05b: per-IP page views; per-link and per-IP code requests and signatures (documents.checkSigningLimits)',
    evidence: ['apps/public/src/signing/handlers.ts', 'checkSigningLimits(rateLimiter()'],
  },
  'apps/public/src/app/sign/[token]/document/route.ts': {
    how: 'R2-05b: per-IP view limits before the signed link (documents.checkSigningLimits)',
    evidence: ['apps/public/src/signing/handlers.ts', "action: 'view', token"],
  },
  'apps/public/src/app/sign/[token]/signed/route.ts': {
    how: 'R2-05b: per-IP view limits before the signed link (documents.checkSigningLimits)',
    evidence: ['apps/public/src/signing/handlers.ts', "action: 'view', token"],
  },
  'apps/public/src/app/sign-assets/[file]/route.ts': {
    how: 'exempt: one constant script, immutable and CDN-cached; any other name a 404',
    evidence: ['apps/public/src/app/sign-assets/[file]/route.ts', 'immutable'],
  },
  'apps/public/src/app/sitemap.xml/route.ts': {
    how: 'exempt: one stored file, CDN-cached an hour (SITEMAP_CACHE)',
    evidence: ['apps/public/src/portal/sitemaps.ts', 'SITEMAP_CACHE'],
  },
  'apps/public/src/app/sitemaps/[file]/route.ts': {
    how: 'exempt: stored files, CDN-cached an hour; unknown names a cached 404',
    evidence: ['apps/public/src/portal/sitemaps.ts', 'SITEMAP_CACHE'],
  },
};

describe('Next route handlers: rate limits and CORS (S16-03)', () => {
  it('[S16-03] every web / public route handler is mapped to its limiter (or an exemption with a reason)', () => {
    const handlers = [...routeHandlers('web'), ...routeHandlers('public')];
    expect(handlers.filter((h) => !(h in HANDLER_LIMITS))).toEqual([]);
    expect(Object.keys(HANDLER_LIMITS).filter((h) => !handlers.includes(h))).toEqual([]);
    for (const [handler, { evidence }] of Object.entries(HANDLER_LIMITS)) {
      const [file, text] = evidence;
      expect(readFileSync(join(ROOT, file), 'utf8'), `${handler}: ${file} should contain ${text}`).toContain(text);
    }
  });

  it('[S16-03] CORS: no Next handler or proxy opens cross-origin reads (no Access-Control-Allow-* anywhere)', () => {
    const files = [
      ...routeHandlers('web'),
      ...routeHandlers('public'),
      'apps/web/src/proxy.ts',
      'apps/public/src/proxy.ts',
      'apps/web/next.config.ts',
      'apps/public/next.config.ts',
      'apps/public/src/embed/handlers.tsx',
      'apps/public/src/selections/handlers.ts',
      'apps/public/src/portal/enquiry.ts',
      'apps/public/src/portal/sitemaps.ts',
    ];
    for (const file of files) {
      expect(readFileSync(join(ROOT, file), 'utf8'), file).not.toMatch(/access-control-allow/i);
    }
  });
});

describe('local load-test secrets never committed (S16 review)', () => {
  it('[S16 review] nothing under tests/load/.data is tracked (gitleaks scans it: no path allowlist)', () => {
    // The local stack's API keys, tokens and storm journals live there (gitignored). gitleaks no longer skips the
    // path, so a committed file is scanned too — this fails first, naming the file.
    const tracked = execFileSync('git', ['ls-files', '--', 'tests/load/.data'], { cwd: ROOT, encoding: 'utf8' }).trim();
    expect(tracked).toBe('');
    expect(readFileSync(join(ROOT, '.gitignore'), 'utf8')).toMatch(/^tests\/load\/\.data\/\r?$/m);
    expect(readFileSync(join(ROOT, '.gitleaks.toml'), 'utf8')).not.toMatch(/'''[^'\n]*tests\/load/);
  });
});
