import { defineConfig } from 'drizzle-kit';

// `pnpm db:generate` diffs the schema files against the migration snapshots — no database needed.
// Migrations are applied by `pnpm db:migrate` (src/migrate.ts), never by `drizzle-kit push`.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/*.ts',
  out: './migrations',
  strict: true,
  verbose: true,
});
