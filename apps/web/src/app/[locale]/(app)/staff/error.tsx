'use client';

import { ErrorPanel } from '@/components/shell/error-panel';

/** Error boundary for staff console pages (S1-10). */
export default function StaffPageError(props: { error: Error & { digest?: string }; retry: () => void }) {
  return <ErrorPanel {...props} />;
}
