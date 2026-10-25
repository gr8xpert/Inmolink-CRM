import { ONBOARDING_STEPS } from '@inmolink/contracts';
import { describe, expect, it } from 'vitest';
import { helpLink, STEP_LINKS, stepHref } from './onboarding-api';

describe('onboarding links (S13-04)', () => {
  it('[S13-04] contextual help links point into the configured help centre, per locale; none without one', () => {
    for (const step of ONBOARDING_STEPS) expect(STEP_LINKS[step].href).toMatch(/^\/[a-z-]+$/);
    expect(helpLink('https://help.example', 'es', 'INVITE_TEAM')).toBe('https://help.example/es/invite-your-team');
    expect(helpLink(undefined, 'en', 'INVITE_TEAM')).toBeNull();
  });

  it('[S13-04] developers bring in their inventory under developments, agencies under listings', () => {
    expect(stepHref('IMPORT_LISTINGS', 'DEVELOPER_ADMIN')).toBe('/developments');
    expect(stepHref('IMPORT_LISTINGS', 'DEVELOPER_AGENT')).toBe('/developments');
    expect(stepHref('IMPORT_LISTINGS', 'AGENT')).toBe('/listings');
    expect(stepHref('INVITE_TEAM', 'DEVELOPER_ADMIN')).toBe('/team');
  });
});
