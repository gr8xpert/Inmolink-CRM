import { describe, expect, it } from 'vitest';
import { credentialFromUrl, databaseStatements, partmanStatements, roleStatements, scramVerifier } from './bootstrap';
import type { DbRoleName } from './roles';

const esc = { literal: (v: string) => `'${v.replaceAll("'", "''")}'`, ident: (v: string) => `"${v}"` };
const stmts = (role: DbRoleName) => roleStatements('inmolink', role, 'SCRAM-SHA-256$verifier', esc).join('\n');

describe('role bootstrap', () => {
  it('[S0-04] only app_system bypasses RLS', () => {
    expect(stmts('app_system')).toContain(' bypassrls ');
    for (const role of ['app_owner', 'app_user', 'app_public'] as const) expect(stmts(role)).toContain('nobypassrls');
  });

  it('[S0-04] role-level statement timeouts: feed 2 s, dashboard 5 s, worker 60 s', () => {
    expect(stmts('app_public')).toContain(`set statement_timeout = '2s'`);
    expect(stmts('app_user')).toContain(`set statement_timeout = '5s'`);
    expect(stmts('app_system')).toContain(`set statement_timeout = '60s'`);
    expect(stmts('app_owner')).toContain('reset statement_timeout');
    // [S7-F6] public reads are never JIT-compiled; other roles keep the server default.
    expect(stmts('app_public')).toContain('alter role "app_public" set jit = off');
    expect(stmts('app_user')).toContain('alter role "app_user" reset jit');
  });

  it('[S1-F6] request roles cut off idle transactions after 15 s; owner and workers keep the server default', () => {
    for (const role of ['app_user', 'app_auth', 'app_staff', 'app_public'] as const) {
      expect(stmts(role)).toContain(`set idle_in_transaction_session_timeout = '15s'`);
    }
    for (const role of ['app_owner', 'app_system'] as const) {
      expect(stmts(role)).toContain('reset idle_in_transaction_session_timeout');
    }
    // S3-F4: the media worker's row locks are released within 60 s
    expect(stmts('app_media')).toContain(`set idle_in_transaction_session_timeout = '60s'`);
  });

  it('[S0-04] app_public is read-only and gets no default table grants', () => {
    const sql = stmts('app_public');
    expect(sql).toContain('default_transaction_read_only = on');
    expect(sql).not.toMatch(/default privileges .* grant/);
    expect(sql).not.toContain('grant create');
  });

  it('[S0-05] no role gets default table or function grants: access fails closed until pnpm db:rls grants it', () => {
    for (const role of ['app_user', 'app_system', 'app_public'] as const) {
      expect(stmts(role)).not.toMatch(/grant [^\n]* on (tables|functions)/);
      expect(stmts(role)).toContain('revoke all on tables');
      expect(stmts(role)).toContain('revoke all on functions');
    }
  });

  it('[S0-04] only app_owner can create objects; nobody gets TEMPORARY or a "$user" search_path', () => {
    expect(stmts('app_owner')).toContain('grant create on schema public');
    for (const role of ['app_user', 'app_system', 'app_public'] as const) {
      expect(stmts(role)).not.toContain('grant create');
      expect(stmts(role)).not.toContain('grant temporary');
      expect(stmts(role)).toContain('set search_path = public');
    }
    expect(databaseStatements('inmolink', esc).join('\n')).toContain('revoke execute on functions from public');
  });

  it('[S1-08] pg_partman is reachable by app_owner only (migrations, partition maintenance)', () => {
    const sql = partmanStatements().join('\n');
    expect(databaseStatements('inmolink', esc).join('\n')).toContain(sql);
    expect(sql).toContain("where extname = 'pg_partman'");
    expect(sql).toMatch(/grant usage, create on schema %I to app_owner/);
    expect(sql).not.toMatch(/to app_(?:user|system|public|auth|staff)/);
  });

  it('[S0-04] passwords reach the server only as a SCRAM verifier', () => {
    expect(stmts('app_user')).toContain(`password 'SCRAM-SHA-256$verifier'`);
    const v = scramVerifier('change-me', Buffer.alloc(16, 1));
    expect(v).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(v).not.toContain('change-me');
    expect(() => scramVerifier('contraseña')).toThrow(/ASCII/);
  });

  it('[S0-04] credentials come from the role URL and must match the role', () => {
    expect(credentialFromUrl('app_user', 'postgres://app_user:p%40ss@localhost:6432/inmolink')).toEqual({
      role: 'app_user',
      password: 'p@ss',
    });
    expect(() => credentialFromUrl('app_user', 'postgres://postgres:x@localhost/inmolink')).toThrow(
      /expected "app_user"/,
    );
    expect(() => credentialFromUrl('app_user', 'postgres://app_user@localhost/inmolink')).toThrow(/no password/);
  });

  it('[S0-04] local default passwords are refused for a non-local database', () => {
    expect(() => credentialFromUrl('app_system', 'postgres://app_system:change-me@db.internal/inmolink')).toThrow(
      /local default password/,
    );
    expect(() => credentialFromUrl('app_system', 'not a url with secret')).toThrow(/not a valid URL$/);
  });
});
