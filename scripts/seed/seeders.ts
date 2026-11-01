/**
 * Seeder registry. Each module that owns seedable tables adds one entry when it lands (S1-01
 * agencies, S3 listings, S4 contacts, …), with a dev seed (small, readable demo data) and a scale
 * seed (COPY-based, §4.1 ratios). Seeders run in this order, so later ones may reference earlier
 * ones' deterministic IDs (`seededId(seed, '<namespace>', i)`).
 */
import { agenciesSeeder } from './agencies';
import { billingSeeder } from './billing';
import { crmSeeder } from './crm';
import { exportsSeeder } from './exports';
import { identityUsers } from './identity';
import { feedConnectionsSeeder } from './imports';
import { listingsSeeder } from './listings';
import { savedSearchesSeeder } from './matching';
import { notificationsSeeder } from './notifications';
import { taxonomySeeder } from './taxonomy';

export interface Login {
  agency: string;
  role: string;
  email: string;
}

export interface DevSeedOptions {
  /** Plain-text password of every demo user. Dev and test stacks only. */
  demoPassword: string;
}

export interface ScaleSeedOptions {
  agencies: number;
  seed: number;
  /** Agencies per COPY transaction. */
  chunk: number;
  /** Plain-text password of every synthetic user (one Argon2 hash shared by all). */
  scalePassword: string;
  /**
   * S16-F4: origin the seeded feed connections point at (`<origin>/s<seed>/a<agency>.xml`). They are disabled, so
   * nothing fetches it until a storm (or an operator) turns one on. Default `DEFAULT_FEED_BASE_URL`: a reserved
   * `.invalid` host, never a real one.
   */
  feedBaseUrl?: string;
  /**
   * S16-F4: the day the time-relative CRM rows are placed around (activities and notifications in the 30–60 days
   * before it — the months whose partitions exist — calendar events from 4 weeks before to 12 after, task due dates).
   * Default: the start of today (UTC). Rows are found by deterministic ID, so a re-run on a later day writes nothing.
   */
  anchor?: Date;
  onProgress?: (done: number, total: number) => void;
}

export interface SeedResult {
  /** Rows written by this run; 0 on a re-run. */
  inserted: number;
  /** Rows of this seeder present after the run. */
  total: number;
  /** Wall time of this seeder, set by the runner. */
  seconds?: number;
  logins?: Login[];
}

export interface Seeder {
  /** `<module>.<table>`, also the `withSystem` reason suffix. */
  name: string;
  dev(options: DevSeedOptions): Promise<SeedResult>;
  scale(options: ScaleSeedOptions): Promise<SeedResult>;
}

export const SEEDERS: readonly Seeder[] = [
  identityUsers,
  agenciesSeeder,
  taxonomySeeder,
  listingsSeeder,
  exportsSeeder,
  billingSeeder,
  // S16-F4: what the load suite reads (PLAN §15's 10M contacts, 1M client profiles, 5,000 feed connections)
  feedConnectionsSeeder,
  savedSearchesSeeder,
  crmSeeder,
  notificationsSeeder,
];

/** S16-F4: the seeders of the load suite's data (feeds, client profiles, CRM, notifications), by name. */
export const LOAD_SUITE_SEEDERS: readonly string[] = [
  feedConnectionsSeeder.name,
  savedSearchesSeeder.name,
  crmSeeder.name,
  notificationsSeeder.name,
];
