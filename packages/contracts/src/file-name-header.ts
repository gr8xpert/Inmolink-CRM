import { z } from 'zod';

/**
 * Upload routes take the file's name in this header, percent-encoded (headers are ASCII), and never in the
 * query: the Cloudflare zone challenges any request whose query contains `.pdf`, so the call would stop at
 * the edge with a 403 HTML page and never reach the API (S17-F6).
 */
export const FILE_NAME_HEADER = 'x-file-name';

export function fileNameHeader(fileName: string): Record<typeof FILE_NAME_HEADER, string> {
  return { [FILE_NAME_HEADER]: encodeURIComponent(fileName) };
}

/** The route's `headers` schema: decodes the name, then applies the route's own rules. Other headers stay. */
export function fileNameHeaders<S extends z.ZodType<string, string>>(name: S) {
  return z.looseObject({
    [FILE_NAME_HEADER]: z
      .string()
      .max(2048)
      .transform((value, ctx) => {
        try {
          return decodeURIComponent(value);
        } catch {
          ctx.issues.push({ code: 'custom', message: 'not percent-encoded', input: value });
          return z.NEVER;
        }
      })
      .pipe(name),
  });
}
