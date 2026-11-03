import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A server action that redirects to another host leaves Next's router pointing at that host, so when the page stays
 * open (a file download) the next action is posted to the file store and fails silently. File links go through
 * `OpenFileForm`. Stripe and social sign-in may redirect, because they replace the page.
 */
const LEAVES_THE_PAGE = new Set(['billing/actions.ts', 'social/actions.ts']);

function actionFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return actionFiles(path);
    return name === 'actions.ts' ? [path] : [];
  });
}

describe('file links from server actions', () => {
  it('[S17-F12] no server action redirects to a minted link when the page stays open', () => {
    const files = actionFiles('apps/web/src/app');
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const short = file.replaceAll('\\', '/');
      if ([...LEAVES_THE_PAGE].some((allowed) => short.endsWith(allowed))) continue;
      expect(readFileSync(file, 'utf8'), short).not.toMatch(/redirect\([\w.]*\.url\)/);
    }
  });
});
