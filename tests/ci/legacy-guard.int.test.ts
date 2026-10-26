import { describe, expect, it, vi } from 'vitest';
import {
  assertTargetDatabase,
  assertTestRunIsLocal,
  prepareLegacyScriptEnv,
  TargetGuardError,
} from '../../scripts/legacy-migration/guard';

/** Production guard of the legacy migration operator scripts (S14 review). Pure: no database. */

const PROD = {
  DATABASE_URL_APP_SYSTEM: 'postgres://app_system:x@db.prod.internal:5432/inmolink',
  DATABASE_URL_APP_USER: 'postgres://app_user:x@db.prod.internal:6432/inmolink',
};

describe('legacy script target guard', () => {
  it('[S14-review] --test is refused next to real credentials or in production', () => {
    expect(() => assertTestRunIsLocal({ test: true, env: PROD })).toThrow(/--test refused: DATABASE_URL_APP_SYSTEM/);
    expect(() => assertTestRunIsLocal({ test: true, env: { NODE_ENV: 'production' } })).toThrow(
      /NODE_ENV is production/,
    );
    expect(() => assertTestRunIsLocal({ test: true, env: {} })).not.toThrow();
    expect(() => assertTestRunIsLocal({ test: false, env: PROD })).not.toThrow();
  });

  it('[S14-review] a non-test run needs --target matching every database URL host', () => {
    expect(() => assertTargetDatabase({ test: false, env: PROD })).toThrow(
      /--target <database host> is required.*db\.prod\.internal/,
    );
    expect(() => assertTargetDatabase({ test: false, target: 'db.staging.internal', env: PROD })).toThrow(
      /refused: --target is db\.staging\.internal, but DATABASE_URL_APP_SYSTEM points at db\.prod\.internal:5432/,
    );
    expect(assertTargetDatabase({ test: false, target: 'DB.prod.internal', env: PROD })).toBe('db.prod.internal');
    // a port in --target must match every URL's port
    expect(() => assertTargetDatabase({ test: false, target: 'db.prod.internal:5432', env: PROD })).toThrow(
      /DATABASE_URL_APP_USER points at db\.prod\.internal:6432/,
    );
    // two hosts in the env: whichever --target names, the other refuses
    const mixed = { ...PROD, DATABASE_URL_APP_PUBLIC: 'postgres://p:x@other.internal/inmolink' };
    expect(() => assertTargetDatabase({ test: false, target: 'db.prod.internal', env: mixed })).toThrow(
      /DATABASE_URL_APP_PUBLIC points at other\.internal/,
    );
    expect(() => assertTargetDatabase({ test: false, target: 'x', env: {} })).toThrow(/no DATABASE_URL_\* is set/);
    expect(() =>
      assertTargetDatabase({ test: false, target: 'x', env: { DATABASE_URL_APP_SYSTEM: 'not a url' } }),
    ).toThrow(TargetGuardError);
  });

  it('[S14-review] the preamble reads the local stack env, prints the host and exits 1 on a refusal', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    try {
      const stack = () => ({ DATABASE_URL_APP_SYSTEM: 'postgres://s:x@localhost:5433/inmolink_test' });
      // --test: the test stack's env is read, no --target needed
      const testEnv: NodeJS.ProcessEnv = {};
      expect(prepareLegacyScriptEnv({ test: true, script: 'legacy:load' }, testEnv, stack)).toBe('localhost');
      expect(testEnv.DATABASE_URL_APP_SYSTEM).toContain('localhost');
      expect(write).toHaveBeenCalledWith('legacy:load: database host localhost (test stack)\n');
      // dev stack: --target is still required
      expect(() => prepareLegacyScriptEnv({ test: false, script: 'legacy:load' }, {}, stack)).toThrow('exit 1');
      expect(prepareLegacyScriptEnv({ test: false, target: 'localhost', script: 'legacy:load' }, {}, stack)).toBe(
        'localhost',
      );
      // real credentials: --test refused before anything is read
      const read = vi.fn(stack);
      expect(() => prepareLegacyScriptEnv({ test: true, script: 'legacy:cutover' }, { ...PROD }, read)).toThrow(
        'exit 1',
      );
      expect(read).not.toHaveBeenCalled();
      expect(write).toHaveBeenCalledWith(expect.stringMatching(/^legacy:cutover: --test refused/));
    } finally {
      write.mockRestore();
      exit.mockRestore();
    }
  });
});
