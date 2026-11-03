import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The Cloudflare zone challenges any request whose query contains `.pdf` (rule "PDF Deny"), so a file name in a
 * query stops at the edge with a 403 HTML page. These clients and contracts send it in `x-file-name` instead.
 */
const FILES = [
  'apps/web/src/server/api.ts',
  'apps/web/src/server/support-api.ts',
  'packages/contracts/src/verification.ts',
  'packages/contracts/src/developments.ts',
  'packages/contracts/src/media.ts',
  'packages/contracts/src/support.ts',
];

describe('upload file names', () => {
  it('[S17-F6] no API call or upload query carries a file name', () => {
    for (const file of FILES) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/URLSearchParams\(\{[^}]*fileName/);
      expect(text, file).not.toMatch(/[?&]fileName=/);
      for (const block of text.match(/export const Upload\w+Query = z[\s\S]*?;\n/g) ?? []) {
        expect(block, file).not.toMatch(/fileName/);
      }
    }
  });
});
