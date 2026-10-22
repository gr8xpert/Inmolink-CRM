import { fileURLToPath } from 'node:url';
import { inmolinkProject } from '@inmolink/config/vitest';
import { mergeConfig } from 'vitest/config';

export default mergeConfig(inmolinkProject(), {
  // `@/…` as in tsconfig, so tests can import (and mock) app modules (S7-F8).
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  // next-intl's ESM imports `next/server` without an extension, which Node's resolver rejects:
  // let Vite resolve it instead.
  test: { server: { deps: { inline: ['next-intl'] } } },
});
