import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  WebsiteChangesPage,
  WebsiteDetail,
  WebsiteDevelopmentDetail,
  WebsiteDevelopmentPage,
  WebsiteListingPage,
  WebsiteSitemapPage,
  WebsiteTypesDto,
  WebsiteUnitPage,
} from '@inmolink/contracts';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

/**
 * The WordPress plugin's PHPUnit suite (S8-03, S8-04) mocks the website API with these JSON files; this test keeps them
 * exactly in the v2 contract shapes, so a contract change that breaks the plugin's assumptions fails here.
 */
const DIR = join(import.meta.dirname, '../../apps/wp-plugin/tests/fixtures');

const SCHEMA_BY_PREFIX: [string, z.ZodType][] = [
  ['changes.', WebsiteChangesPage],
  ['listing.', WebsiteDetail],
  ['listings.', WebsiteListingPage],
  ['sitemap.', WebsiteSitemapPage],
  // S8-04
  ['developments.', WebsiteDevelopmentPage],
  ['development.', WebsiteDevelopmentDetail],
  ['units.', WebsiteUnitPage],
  ['taxonomy.types.', WebsiteTypesDto],
];

describe('WordPress plugin fixtures (S8-03)', () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.json'));

  it('[S8-03] every fixture has a contract', () => {
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(
        SCHEMA_BY_PREFIX.some(([prefix]) => file.startsWith(prefix)),
        file,
      ).toBe(true);
    }
  });

  it.each(files)('[S8-03] fixture %s matches its v2 contract', (file) => {
    const schema = SCHEMA_BY_PREFIX.find(([prefix]) => file.startsWith(prefix))?.[1];
    if (!schema) throw new Error(`no contract for ${file}`);
    const parsed = schema.safeParse(JSON.parse(readFileSync(join(DIR, file), 'utf8')));
    expect(parsed.success, parsed.success ? file : `${file}: ${parsed.error.message}`).toBe(true);
  });
});
