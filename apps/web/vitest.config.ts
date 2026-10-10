import { inmolinkProject } from '@inmolink/config/vitest';
import { mergeConfig } from 'vitest/config';

export default mergeConfig(inmolinkProject(), {
  // next-intl's ESM imports `next/server` without an extension, which Node's resolver rejects:
  // let Vite resolve it instead.
  test: { server: { deps: { inline: ['next-intl'] } } },
});
