import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { errors, jwtVerify, SignJWT } from 'jose';
import { type Clock, clock as processClock } from '../clock';
import { AppError } from '../errors';

/**
 * Short-lived access tokens (PLAN §3 #30, S0-09). The web app holds the Auth.js session and mints a
 * 15-minute JWT per audience (`api`, `realtime`); those apps only verify. Ed25519, so a verifier can
 * never mint. Keys carry IDs: rotate by publishing the new public key, switching the signer, then
 * dropping the old public key after one token lifetime.
 */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const ACCESS_TOKEN_ISSUER = 'inmolink-web';
export type Audience = 'api' | 'realtime';
export const AUDIENCES: readonly Audience[] = ['api', 'realtime'];

const ALG = 'EdDSA';
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Leeway for clock drift between web and api/realtime nodes. */
const CLOCK_TOLERANCE_SECONDS = 5;

export interface AccessClaims {
  /** User id. */
  sub: string;
  aud: Audience;
  /** `users.session_version` when minted; bumped by password reset (checked again at the next mint). */
  sv: number;
  /** Agency (tenant) once memberships exist (S1-01); absent before. */
  agency?: string;
  exp: number;
  iat: number;
}

export interface AccessTokenSigner {
  sign(claims: {
    sub: string;
    aud: Audience;
    sv: number;
    agency?: string;
  }): Promise<{ token: string; expiresAt: Date }>;
}

export interface AccessTokenVerifier {
  /** Throws `AppError('NOT_AUTHENTICATED')` for a missing, malformed, expired, wrong-audience or unknown-key token. */
  verify(token: string, audience: Audience): Promise<AccessClaims>;
}

function assertKeyId(id: string): void {
  if (!KEY_ID.test(id)) throw new TypeError(`invalid JWT key id ${JSON.stringify(id)}`);
}

/** `base64(PKCS#8 DER)` of an Ed25519 private key. */
export function privateKeyFromBase64(b64: string): KeyObject {
  const key = createPrivateKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'pkcs8' });
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('AUTH_JWT_PRIVATE_KEY must be an Ed25519 key');
  return key;
}

/** `kid:base64(SPKI DER)[,kid:base64…]` — every public key a verifier accepts. */
export function parsePublicKeys(list: string): Map<string, KeyObject> {
  const out = new Map<string, KeyObject>();
  for (const entry of list
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const at = entry.indexOf(':');
    if (at <= 0) throw new TypeError('AUTH_JWT_PUBLIC_KEYS entries must be kid:base64');
    const kid = entry.slice(0, at);
    assertKeyId(kid);
    if (out.has(kid)) throw new TypeError(`AUTH_JWT_PUBLIC_KEYS has key id ${kid} twice`);
    const key = createPublicKey({ key: Buffer.from(entry.slice(at + 1), 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519') throw new TypeError(`AUTH_JWT_PUBLIC_KEYS ${kid} is not an Ed25519 key`);
    out.set(kid, key);
  }
  if (out.size === 0) throw new TypeError('AUTH_JWT_PUBLIC_KEYS is empty');
  return out;
}

/** New key pair in env format (scripts, tests). */
export function generateAccessKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  };
}

export function createAccessTokenSigner(options: {
  privateKey: KeyObject;
  keyId: string;
  clock?: Clock;
  ttlSeconds?: number;
}): AccessTokenSigner {
  assertKeyId(options.keyId);
  const clock = options.clock ?? processClock;
  const ttl = options.ttlSeconds ?? ACCESS_TOKEN_TTL_SECONDS;
  return {
    async sign({ sub, aud, sv, agency }) {
      if (!UUID.test(sub)) throw new TypeError('access token subject must be a user id');
      const iat = Math.floor(clock.nowMs() / 1_000);
      const exp = iat + ttl;
      const token = await new SignJWT(agency ? { sv, agency } : { sv })
        .setProtectedHeader({ alg: ALG, kid: options.keyId, typ: 'at+jwt' })
        .setIssuer(ACCESS_TOKEN_ISSUER)
        .setSubject(sub)
        .setAudience(aud)
        .setIssuedAt(iat)
        .setExpirationTime(exp)
        .sign(options.privateKey);
      return { token, expiresAt: new Date(exp * 1_000) };
    },
  };
}

const notAuthenticated = (reason: string) => new AppError('NOT_AUTHENTICATED', { reason });

export function createAccessTokenVerifier(options: {
  publicKeys: Map<string, KeyObject>;
  clock?: Clock;
}): AccessTokenVerifier {
  const clock = options.clock ?? processClock;
  return {
    async verify(token, audience) {
      if (typeof token !== 'string' || token.length === 0 || token.length > 4_096) throw notAuthenticated('malformed');
      try {
        const { payload } = await jwtVerify(
          token,
          (header) => {
            const key = header.kid ? options.publicKeys.get(header.kid) : undefined;
            if (!key) throw notAuthenticated('unknown_key');
            return key;
          },
          {
            algorithms: [ALG],
            issuer: ACCESS_TOKEN_ISSUER,
            audience,
            typ: 'at+jwt',
            requiredClaims: ['sub', 'exp', 'iat'],
            clockTolerance: CLOCK_TOLERANCE_SECONDS,
            maxTokenAge: ACCESS_TOKEN_TTL_SECONDS + CLOCK_TOLERANCE_SECONDS,
            currentDate: new Date(clock.nowMs()),
          },
        );
        const { sub, sv, agency, exp, iat } = payload as Record<string, unknown>;
        if (typeof sub !== 'string' || !UUID.test(sub)) throw notAuthenticated('bad_subject');
        if (typeof sv !== 'number' || !Number.isInteger(sv)) throw notAuthenticated('bad_claims');
        if (agency !== undefined && (typeof agency !== 'string' || !UUID.test(agency))) {
          throw notAuthenticated('bad_claims');
        }
        return {
          sub,
          aud: audience,
          sv,
          ...(agency ? { agency } : {}),
          exp: exp as number,
          iat: iat as number,
        };
      } catch (err) {
        if (err instanceof AppError) throw err;
        if (err instanceof errors.JWTExpired) throw notAuthenticated('expired');
        if (err instanceof errors.JWTClaimValidationFailed) throw notAuthenticated(`claim_${err.claim}`);
        throw notAuthenticated('invalid');
      }
    },
  };
}
