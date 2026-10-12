import { fileURLToPath } from 'node:url';
import { inmolinkProject } from '@inmolink/config/vitest';
import { mergeConfig } from 'vitest/config';

export default mergeConfig(inmolinkProject(), {
  // `@/…` as in tsconfig, so unit tests can import (and mock) app modules (S1-09).
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  // next-intl's ESM imports `next/server` without an extension, which Node's resolver rejects:
  // let Vite resolve it instead.
  test: { server: { deps: { inline: ['next-intl'] } } },
});
