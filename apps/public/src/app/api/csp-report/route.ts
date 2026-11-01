import { cspReportResponse } from '@/server/csp-report';

/** S16-F8: browsers' CSP violation reports (`report-uri`): limited, size-capped, logged without personal data. */
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return cspReportResponse(request);
}
