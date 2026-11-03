/**
 * What to log about a refused API call, or null for an expected refusal. An answer without the API's error body
 * did not come from the API: it was stopped on the way, for instance by a Cloudflare rule, and nothing else would
 * record it. The query is left out: it can carry user input.
 */
export function refusalLogFields(
  path: string,
  res: { status: number; headers: Pick<Headers, 'get'> },
  isApiError: boolean,
): Record<string, string | number | boolean | null> | null {
  if (isApiError && res.status < 500 && res.status !== 401) return null;
  return {
    status: res.status,
    path: path.split('?')[0] ?? path,
    fromApi: isApiError,
    contentType: res.headers.get('content-type'),
    cfMitigated: res.headers.get('cf-mitigated'),
  };
}
