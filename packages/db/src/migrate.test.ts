import { describe, expect, it } from 'vitest';
import { fixableProblems } from './migrate';
import type { TenantRegistry } from './tenancy/registry';

const reg: TenantRegistry = {
  tenant: { outbox_events: { kind: 'STRICT' } },
  global: { users: { reason: 'auth' } },
};

describe('fixableProblems', () => {
  it('[S0-14] keeps problems about registered tables and helper functions, drops the rest', () => {
    const problems = [
      'outbox_events: missing policy tenant_select',
      'users: app_user has unexpected SELECT',
      'app_agency(): executable by an app role but not a generated helper',
      'iso_fx_strict: not in the tenant registry (register it as tenant or global)',
      'other.view: accessible to an app role outside the tenant registry',
      'rogue(): SECURITY DEFINER outside the generated helpers',
    ];
    expect(fixableProblems(problems, reg)).toEqual(problems.slice(0, 3));
  });
});
