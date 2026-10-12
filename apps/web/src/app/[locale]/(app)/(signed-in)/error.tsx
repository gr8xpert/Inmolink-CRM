'use client';

import { ErrorPanel } from '@/components/shell/error-panel';

/** Error boundary for member pages (S1-10): the shell stays, the page shows what went wrong. */
export default function MemberPageError(props: { error: Error & { digest?: string }; retry: () => void }) {
  return <ErrorPanel {...props} />;
}
