import { describe, expect, it } from 'vitest';
import type { Clock } from '../clock';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  createAccessTokenSigner,
  createAccessTokenVerifier,
  generateAccessKeyPair,
  parsePublicKeys,
  privateKeyFromBase64,
} from './index';

const USER = '0192a0b4-0000-7000-8000-000000000001';

function fakeClock(start = Date.UTC(2026, 9, 10, 12)): Clock & { advance(ms: number): void } {
  let now = start;
  return { nowMs: () => now, now: () => new Date(now), advance: (ms) => (now += ms) };
}

function setup() {
  const pair = generateAccessKeyPair();
  const clock = fakeClock();
  const signer = createAccessTokenSigner({ privateKey: privateKeyFromBase64(pair.privateKey), keyId: 'k1', clock });
  const verifier = createAccessTokenVerifier({ publicKeys: parsePublicKeys(`k1:${pair.publicKey}`), clock });
  return { pair, clock, signer, verifier };
}

describe('access tokens', () => {
  it('[S0-09] a fresh token verifies for its audience and carries the claims', async () => {
    const { signer, verifier } = setup();
    const { token, expiresAt } = await signer.sign({ sub: USER, aud: 'api', sv: 3 });
    const claims = await verifier.verify(token, 'api');
    expect(claims).toMatchObject({ sub: USER, aud: 'api', sv: 3 });
    expect(claims.exp - claims.iat).toBe(ACCESS_TOKEN_TTL_SECONDS);
    expect(expiresAt.getTime()).toBe(claims.exp * 1_000);
  });

  it('[S0-09] an expired token is rejected with NOT_AUTHENTICATED', async () => {
    const { signer, verifier, clock } = setup();
    const { token } = await signer.sign({ sub: USER, aud: 'api', sv: 1 });
    clock.advance((ACCESS_TOKEN_TTL_SECONDS + 6) * 1_000);
    await expect(verifier.verify(token, 'api')).rejects.toMatchObject({
      code: 'NOT_AUTHENTICATED',
      details: { reason: 'expired' },
    });
  });

  it('[S0-09] a token for another audience is rejected with NOT_AUTHENTICATED', async () => {
    const { signer, verifier } = setup();
    const { token } = await signer.sign({ sub: USER, aud: 'realtime', sv: 1 });
    await expect(verifier.verify(token, 'api')).rejects.toMatchObject({ code: 'NOT_AUTHENTICATED' });
    await expect(verifier.verify(token, 'realtime')).resolves.toMatchObject({ aud: 'realtime' });
  });

  it('[S0-09] tokens from an unknown key, a tampered payload or garbage are rejected', async () => {
    const { signer, verifier } = setup();
    const other = generateAccessKeyPair();
    const foreign = createAccessTokenSigner({ privateKey: privateKeyFromBase64(other.privateKey), keyId: 'k1' });
    const { token: forged } = await foreign.sign({ sub: USER, aud: 'api', sv: 1 });
    await expect(verifier.verify(forged, 'api')).rejects.toMatchObject({ code: 'NOT_AUTHENTICATED' });

    const { token } = await signer.sign({ sub: USER, aud: 'api', sv: 1 });
    const [h, , s] = token.split('.');
    const body = Buffer.from(JSON.stringify({ sub: USER, aud: 'api', sv: 99, iss: 'inmolink-web' })).toString(
      'base64url',
    );
    await expect(verifier.verify(`${h}.${body}.${s}`, 'api')).rejects.toMatchObject({ code: 'NOT_AUTHENTICATED' });
    await expect(verifier.verify('not-a-jwt', 'api')).rejects.toMatchObject({ code: 'NOT_AUTHENTICATED' });
    await expect(verifier.verify('', 'api')).rejects.toMatchObject({ code: 'NOT_AUTHENTICATED' });
  });

  it('[S0-09] a rotated key keeps verifying while both public keys are listed', async () => {
    const { pair, clock } = setup();
    const next = generateAccessKeyPair();
    const oldSigner = createAccessTokenSigner({
      privateKey: privateKeyFromBase64(pair.privateKey),
      keyId: 'k1',
      clock,
    });
    const newSigner = createAccessTokenSigner({
      privateKey: privateKeyFromBase64(next.privateKey),
      keyId: 'k2',
      clock,
    });
    const verifier = createAccessTokenVerifier({
      publicKeys: parsePublicKeys(`k1:${pair.publicKey},k2:${next.publicKey}`),
      clock,
    });
    for (const s of [oldSigner, newSigner]) {
      const { token } = await s.sign({ sub: USER, aud: 'api', sv: 1 });
      await expect(verifier.verify(token, 'api')).resolves.toMatchObject({ sub: USER });
    }
  });

  it('[S0-09] key parsing refuses non-Ed25519 keys, duplicates and bad ids; subjects must be user ids', async () => {
    const { pair, signer } = setup();
    expect(() => parsePublicKeys('')).toThrow(/empty/);
    expect(() => parsePublicKeys(`k1:${pair.publicKey},k1:${pair.publicKey}`)).toThrow(/twice/);
    expect(() => parsePublicKeys(`bad id:${pair.publicKey}`)).toThrow(/key id/);
    expect(() => privateKeyFromBase64(pair.publicKey)).toThrow();
    await expect(signer.sign({ sub: 'admin', aud: 'api', sv: 1 })).rejects.toThrow(/user id/);
  });
});
