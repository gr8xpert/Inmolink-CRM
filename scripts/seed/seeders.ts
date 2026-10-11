/**
 * Seeder registry. Each module that owns seedable tables adds one entry when it lands (S1-01
 * agencies, S3 listings, S4 contacts, …), with a dev seed (small, readable demo data) and a scale
 * seed (COPY-based, §4.1 ratios). Seeders run in this order, so later ones may reference earlier
 * ones' deterministic IDs (`seededId(seed, '<namespace>', i)`).
 */
import { agenciesSeeder } from './agencies';
import { identityUsers } from './identity';

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
  onProgress?: (done: number, total: number) => void;
}

export interface SeedResult {
  /** Rows written by this run; 0 on a re-run. */
  inserted: number;
  /** Rows of this seeder present after the run. */
  total: number;
  logins?: Login[];
}

export interface Seeder {
  /** `<module>.<table>`, also the `withSystem` reason suffix. */
  name: string;
  dev(options: DevSeedOptions): Promise<SeedResult>;
  scale(options: ScaleSeedOptions): Promise<SeedResult>;
}

export const SEEDERS: readonly Seeder[] = [identityUsers, agenciesSeeder];
