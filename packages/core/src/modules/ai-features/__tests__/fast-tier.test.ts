import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * S13-F17 (Shahzaib, 2026-10-25): every per-agency AI feature runs on the FAST tier (the cheapest configured model); a
 * SMART-tier prompt needs a recorded decision first. Every version of each feature's prompt is checked.
 */
const PROMPTS_DIR = fileURLToPath(new URL('../../../../prompts', import.meta.url));
/** The prompts behind the toggles: website AI search, white-label pass, Listing Studio (and its translations), captions. */
const TOGGLED_PROMPTS = ['search-ai', 'white-label', 'listing-studio', 'social-captions'];

describe('AI feature tiers (S13-F17)', () => {
  it('[S13-F17] every toggled AI feature stays on the FAST tier', () => {
    for (const id of TOGGLED_PROMPTS) {
      const versions = readdirSync(`${PROMPTS_DIR}/${id}`).filter((f) => /^v\d+\.md$/.test(f));
      expect(versions.length).toBeGreaterThan(0);
      for (const v of versions) {
        const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(`${PROMPTS_DIR}/${id}/${v}`, 'utf8'))?.[1] ?? '';
        expect(`${id}/${v}: ${/^tier:\s*(\S+)/m.exec(front)?.[1]}`).toBe(`${id}/${v}: FAST`);
      }
    }
  });
});
