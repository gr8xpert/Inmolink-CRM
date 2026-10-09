import { type Algorithm, hash, parseOptions, type Version, verify } from '@node-rs/argon2';

/**
 * Argon2id password hashing. Parameters are fixed by ADR 0003; changing them makes
 * `needsRehash()` true for older hashes, which identity upgrades on next login.
 * Never log or return the hash.
 */
// `Algorithm` / `Version` are ambient const enums, which isolatedModules cannot inline.
const ARGON2ID = 2 as Algorithm;
const V0X13 = 1 as Version;

export const PASSWORD_POLICY = {
  algorithm: ARGON2ID,
  version: V0X13,
  memoryCost: 19_456, // KiB (19 MiB)
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

/** Upper bound on input size, so a huge body cannot pin a CPU. */
export const PASSWORD_MAX_BYTES = 1024;

export class PasswordTooLongError extends Error {
  override readonly name = 'PasswordTooLongError';
}

function assertLength(password: string): void {
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) {
    throw new PasswordTooLongError(`Password exceeds ${PASSWORD_MAX_BYTES} bytes`);
  }
}

export async function hashPassword(password: string): Promise<string> {
  assertLength(password);
  return hash(password, PASSWORD_POLICY);
}

/** Stored hashes above these costs are refused, so a tampered hash cannot pin memory or CPU. */
const COST_CEILING = {
  memoryCost: PASSWORD_POLICY.memoryCost * 4,
  timeCost: PASSWORD_POLICY.timeCost * 4,
  parallelism: 4,
};

/** False for a wrong password, an over-long input, or a malformed or over-costly stored hash. */
export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) return false;
  try {
    const p = parseOptions(storedHash);
    if (
      p.memoryCost > COST_CEILING.memoryCost ||
      p.timeCost > COST_CEILING.timeCost ||
      p.parallelism > COST_CEILING.parallelism
    ) {
      return false;
    }
    return await verify(storedHash, password);
  } catch {
    return false;
  }
}

export function needsRehash(storedHash: string): boolean {
  try {
    const p = parseOptions(storedHash);
    return (
      p.algorithm !== PASSWORD_POLICY.algorithm ||
      p.version !== PASSWORD_POLICY.version ||
      p.memoryCost !== PASSWORD_POLICY.memoryCost ||
      p.timeCost !== PASSWORD_POLICY.timeCost ||
      p.parallelism !== PASSWORD_POLICY.parallelism ||
      p.outputLen !== PASSWORD_POLICY.outputLen ||
      p.saltLen < 16
    );
  } catch {
    return true;
  }
}

/** Precomputed with PASSWORD_POLICY; regenerate when the policy changes (ADR 0003). */
const DUMMY_HASH = '$argon2id$v=19$m=19456,t=2,p=1$kSbNzQY3beVrSOBzQ+h8bg$ozAr0LLSh8Ay4w6FuVV1qHD1WwaD0rbpN1ZkT57fy5I';

/**
 * Burns the same time as a real verify. Call it when the account does not exist,
 * so login timing does not reveal which emails are registered.
 */
export async function dummyVerify(password: string): Promise<false> {
  await verifyPassword(DUMMY_HASH, password);
  return false;
}

/** Test hook: the dummy hash must keep matching the policy. */
export const _dummyHashForTests = DUMMY_HASH;
