// The cookie choice an e2e browser starts with (S16-04): the dashboard's cookie banner is a fixed bar at the bottom of
// every page until the visitor chooses, and it covers controls the flows click (Log out, Save, Draw area…). The flows
// test the product as a returning visitor would use it — choice already made ("essential") — and the banner itself is
// covered by apps/web's legal tests. Every context gets it: the `page` fixture through playwright.config's
// `storageState`, hand-made contexts by passing `storageState: consentState(url)`.
import { CONSENT_COOKIE, CONSENT_MAX_AGE, CONSENT_VERSION } from '../../apps/web/src/components/legal/cookie-consent';

type StorageState = {
  cookies: {
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'Lax';
  }[];
  origins: never[];
};

/** A storage state holding the "essential only" cookie choice for the hosts of `urls`. */
export function consentState(...urls: string[]): StorageState {
  const expires = Math.floor(Date.now() / 1000) + CONSENT_MAX_AGE;
  const hosts = [...new Set(urls.map((u) => new URL(u).hostname))];
  return {
    cookies: hosts.map((domain) => ({
      name: CONSENT_COOKIE,
      value: `v${CONSENT_VERSION}.essential`,
      domain,
      path: '/',
      expires,
      httpOnly: false,
      secure: false,
      sameSite: 'Lax',
    })),
    origins: [],
  };
}
