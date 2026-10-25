import {
  CLIENT_MODE_REVIEWED_FIELDS,
  CLIENT_MODE_SENSITIVE_FIELD,
  CLIENT_MODE_STRIPPED_FIELDS,
} from '@inmolink/contracts';
import {
  createAccessTokenSigner,
  createAccessTokenVerifier,
  generateAccessKeyPair,
  parsePublicKeys,
  privateKeyFromBase64,
} from '@inmolink/platform/jwt';
import { createLogger } from '@inmolink/platform/logger';
import type { RateLimiter } from '@inmolink/platform/rate-limit';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app';

/**
 * Client Mode over every dashboard route (S12-06), without a database: each route's declared response schema is
 * walked for sensitive-looking field names — every one must be stripped by the Client Mode net or reviewed — and the
 * net itself replaces what a route still returns to a Client Mode token. `client-mode.int.test.ts` calls the routes.
 */

const allowAll = {
  consume: async () => ({ allowed: true, limit: 1, remaining: 1, retryAfterSeconds: 0 }),
  consumeMany: async (checks: unknown[]) =>
    checks.map(() => ({ allowed: true, limit: 1, remaining: 1, retryAfterSeconds: 0 })),
} as unknown as RateLimiter;

const USER = '0192a0b4-0000-7000-8000-000000000001';
const AGENCY = '0192a0b4-0000-7000-8000-000000000004';
const pair = generateAccessKeyPair();
const signer = createAccessTokenSigner({ privateKey: privateKeyFromBase64(pair.privateKey), keyId: 'k1' });
const verifier = createAccessTokenVerifier({ publicKeys: parsePublicKeys(`k1:${pair.publicKey}`) });

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

async function app() {
  const a = await buildApp({
    logger: createLogger({ level: 'silent' }),
    trustProxy: false,
    docsUi: false,
    limiter: allowAll,
    checks: { db: async () => {} },
    verifier,
  });
  apps.push(a);
  return a;
}

type JsonSchema = Record<string, unknown>;

/** Every property name a JSON schema (with `$ref`s into `components`) can produce. */
function propertyNames(schema: unknown, components: Record<string, JsonSchema>, out = new Set<string>()): Set<string> {
  const seen = new Set<string>();
  const walk = (s: unknown): void => {
    if (!s || typeof s !== 'object') return;
    const node = s as JsonSchema;
    if (typeof node.$ref === 'string') {
      const name = node.$ref.split('/').pop() as string;
      if (seen.has(name)) return;
      seen.add(name);
      walk(components[name]);
      return;
    }
    if (node.properties && typeof node.properties === 'object') {
      for (const [key, value] of Object.entries(node.properties as Record<string, unknown>)) {
        out.add(key);
        walk(value);
      }
    }
    for (const key of ['items', 'anyOf', 'oneOf', 'allOf', 'additionalProperties', 'prefixItems']) {
      const child = node[key];
      if (Array.isArray(child)) child.forEach(walk);
      else walk(child);
    }
  };
  walk(schema);
  return out;
}

describe('Client Mode contract (S12-06)', () => {
  it('[S12-06] every route: each sensitive response field is stripped in Client Mode or reviewed', async () => {
    const a = await app();
    await a.ready();
    const doc = (
      a as unknown as {
        swagger(): {
          paths: Record<string, Record<string, unknown>>;
          components?: { schemas?: Record<string, JsonSchema> };
        };
      }
    ).swagger();
    const components = doc.components?.schemas ?? {};
    // The route list is complete: every registered dashboard route is in the OpenAPI document, so walking the
    // document's response schemas walks every route's.
    const documented = new Set(
      Object.entries(doc.paths).flatMap(([path, ops]) =>
        Object.keys(ops).map((m) => `${m.toUpperCase()} ${path.replace(/\{([^}]+)\}/g, ':$1')}`),
      ),
    );
    const routes = a.registeredRoutes.filter(
      (r) => r.url.startsWith('/v1/') && r.method !== 'HEAD' && r.method !== 'OPTIONS',
    );
    expect(routes.length).toBeGreaterThan(200);
    expect(routes.filter((r) => !documented.has(`${r.method} ${r.url}`))).toEqual([]);

    const unreviewed: string[] = [];
    let walked = 0;
    for (const [path, ops] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        const responses = (op as { responses?: Record<string, { content?: Record<string, { schema?: unknown }> }> })
          .responses;
        for (const [status, response] of Object.entries(responses ?? {})) {
          if (!status.startsWith('2')) continue;
          walked += 1;
          for (const name of propertyNames(response.content?.['application/json']?.schema, components)) {
            if (!CLIENT_MODE_SENSITIVE_FIELD.test(name)) continue;
            if (CLIENT_MODE_STRIPPED_FIELDS.has(name) || name in CLIENT_MODE_REVIEWED_FIELDS) continue;
            unreviewed.push(`${method.toUpperCase()} ${path}: ${name}`);
          }
        }
      }
    }
    expect(walked).toBeGreaterThan(200);
    expect(unreviewed).toEqual([]);
  });

  it('[S12-06] the net replaces stripped fields in answers to Client Mode tokens only, and drops the ETag', async () => {
    const a = await app();
    const leak = () => ({
      id: 'x',
      commission: { total: { kind: 'PERCENT', bp: 300 } },
      items: [{ name: 'Villa', ownerAgencyId: AGENCY, internalNotes: 'needs to sell fast', tags: ['vip'] }],
      allowedAgencyIds: [AGENCY],
      note: null,
    });
    a.get('/leaky', { onRequest: [a.requireSession] }, async (_req, reply) => {
      reply.header('etag', '"v1"');
      return leak();
    });
    await a.ready();
    const call = async (cm: boolean) => {
      const { token } = await signer.sign({ sub: USER, aud: 'api', sv: 1, agency: AGENCY, cm });
      return a.inject({ method: 'GET', url: '/leaky', headers: { authorization: `Bearer ${token}` } });
    };
    const shown = await call(true);
    expect(shown.statusCode).toBe(200);
    expect(shown.json()).toEqual({
      id: 'x',
      commission: null,
      items: [{ name: 'Villa', ownerAgencyId: null, internalNotes: null, tags: [] }],
      allowedAgencyIds: [],
      note: null,
    });
    expect(shown.headers.etag).toBeUndefined();
    const plain = await call(false);
    expect(plain.json()).toEqual(leak());
    expect(plain.headers.etag).toBe('"v1"');
  });

  it('[S12-06] fail closed: a body the net cannot read is refused in Client Mode; error bodies are scanned too', async () => {
    const a = await app();
    a.get('/raw', { onRequest: [a.requireSession] }, async (_req, reply) =>
      reply.type('text/plain').send(`owner: ${AGENCY}`),
    );
    a.get('/oops', { onRequest: [a.requireSession] }, async (_req, reply) =>
      reply.code(409).send({ error: { code: 'VERSION_CONFLICT', message: 'x', details: { ownerAgencyId: AGENCY } } }),
    );
    a.get('/empty', { onRequest: [a.requireSession] }, async (_req, reply) => reply.code(204).send());
    await a.ready();
    const call = async (url: string, cm: boolean) => {
      const { token } = await signer.sign({ sub: USER, aud: 'api', sv: 1, agency: AGENCY, cm });
      return a.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
    };
    const raw = await call('/raw', true);
    expect(raw.statusCode).toBe(403);
    expect(raw.body).not.toContain(AGENCY);
    expect(raw.json().error).toMatchObject({ code: 'FORBIDDEN', details: { reason: 'client_mode' } });
    expect((await call('/raw', false)).body).toContain(AGENCY);
    const oops = await call('/oops', true);
    expect(oops.statusCode).toBe(409);
    expect(oops.json().error.details).toEqual({ ownerAgencyId: null });
    expect((await call('/empty', true)).statusCode).toBe(204);
  });
});
