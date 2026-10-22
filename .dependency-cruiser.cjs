/**
 * Module boundaries (PLAN §3 #51, CLAUDE.md golden rules 1–3). `pnpm check:boundaries` runs this
 * once for the packages and node apps, and once per Next app with its tsconfig (`@/` alias) — see
 * `scripts/boundaries/check.ts`. Paths are matched after resolution, with workspace packages
 * resolved to their `src/` through the `@inmolink/source` export condition.
 *
 * Layers: contracts ← platform ← db ← core ← apps. Apps are thin transports: core (public entry and
 * module `index.ts` only), contracts, platform, ui, i18n. App tests may also use `@inmolink/db/testing`
 * (STATUS decision, S0-08).
 */

const TESTS = '(\\.(test|spec|int\\.test)\\.tsx?$|/__tests__/|^(packages|apps)/[^/]+/test/|^tests/)';
const APP_TESTS = '^apps/([^/]+/test/|.*(\\.(test|spec|int\\.test)\\.tsx?$|/__tests__/))';
const CORE_PUBLIC = '^packages/core/src/(index|modules/[^/]+/(index|testing)|testing/factories)\\.ts$';
/** A module's test-only entry point (`@inmolink/core/modules/search/testing`: perf-test SQL helpers, S7-F11). */
const MODULE_TESTING = '^packages/core/src/modules/[^/]+/testing\\.ts$';
const APP_PACKAGES = '^packages/(core|contracts|platform|ui|i18n|config)/';

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'apps-thin-transports',
      severity: 'error',
      comment:
        'Apps reach the database and business rules only through @inmolink/core. Allowed: core, contracts, platform, ui, i18n, config.',
      from: { path: '^apps/', pathNot: TESTS },
      to: { path: '^packages/', pathNot: APP_PACKAGES },
    },
    {
      name: 'apps-tests-thin-transports',
      severity: 'error',
      comment: 'App tests may additionally bring the test stack up with @inmolink/db/testing — nothing else from db.',
      from: { path: APP_TESTS },
      to: { path: '^packages/', pathNot: [APP_PACKAGES, '^packages/db/test/'] },
    },
    {
      name: 'core-public-api-only',
      severity: 'error',
      comment:
        'Outside @inmolink/core, import `@inmolink/core` or `@inmolink/core/modules/<module>` (its index.ts) only.',
      from: { pathNot: '^packages/core/' },
      to: { path: '^packages/core/', pathNot: CORE_PUBLIC },
    },
    {
      name: 'core-test-factories-in-tests-only',
      severity: 'error',
      comment: '`@inmolink/core/test` (factories through the real services) is for tests only.',
      from: { pathNot: [TESTS, '^packages/core/src/testing/'] },
      to: { path: '^packages/core/src/testing/' },
    },
    {
      name: 'core-module-testing-in-tests-only',
      severity: 'error',
      comment: "A module's `testing.ts` (perf-test helpers) is for tests only — never apps or other modules' code.",
      from: { pathNot: [TESTS, MODULE_TESTING] },
      to: { path: MODULE_TESTING },
    },
    {
      name: 'apps-infra-via-platform',
      severity: 'error',
      comment: 'Apps use databases, queues and caches through @inmolink/platform adapters and core (golden rule 10).',
      from: { path: '^apps/', pathNot: TESTS },
      to: {
        path: 'node_modules/(drizzle-orm|drizzle-kit|pg|pg-pool|ioredis|bullmq)/',
      },
    },
    {
      name: 'core-shared-no-schema',
      severity: 'error',
      comment:
        'Only a module queries tables; core code outside modules (context, runtime) never imports a schema file.',
      from: { path: '^packages/core/', pathNot: '^packages/core/src/modules/' },
      to: { path: '^packages/db/src/schema/' },
    },
    {
      name: 'module-via-index-only',
      severity: 'error',
      comment:
        'A module uses another module only through its index.ts (or reacts to its outbox events) — never its repo, service or internals.',
      from: { path: '^packages/core/src/modules/([^/]+)/' },
      to: {
        path: '^packages/core/src/modules/',
        pathNot: ['^packages/core/src/modules/$1/', '^packages/core/src/modules/[^/]+/index\\.ts$'],
      },
    },
    {
      name: 'core-shared-via-index-only',
      severity: 'error',
      comment: 'Core code outside modules (context, runtime) uses a module through its index.ts only.',
      from: { path: '^packages/core/src/', pathNot: '^packages/core/src/modules/' },
      to: { path: '^packages/core/src/modules/', pathNot: '^packages/core/src/modules/[^/]+/index\\.ts$' },
    },
    {
      name: 'module-own-schema-only',
      severity: 'error',
      comment:
        'A module queries only its own tables: @inmolink/db/schema/<this-module>. Other data comes from that module’s index.ts or events.',
      from: { path: '^packages/core/src/modules/([^/]+)/' },
      to: { path: '^packages/db/src/schema/', pathNot: '^packages/db/src/schema/$1\\.ts$' },
    },
    {
      name: 'platform-never-imports-core',
      severity: 'error',
      comment: 'platform is infrastructure below core and db: it may use contracts, nothing above it.',
      from: { path: '^packages/platform/' },
      to: { path: '^packages/(core|db|ui|i18n|sdk)/' },
    },
    {
      name: 'db-below-core',
      severity: 'error',
      comment: 'db (client, schema, RLS) sits under core: it may use platform, never core or the apps’ packages.',
      from: { path: '^packages/db/' },
      to: { path: '^packages/(core|ui|i18n|sdk)/' },
    },
    {
      name: 'contracts-standalone',
      severity: 'error',
      comment:
        'contracts (Zod DTOs, error codes) is shared by apps, SDK and core, so it depends on no workspace package.',
      from: { path: '^packages/contracts/' },
      to: { path: '^packages/', pathNot: '^packages/(contracts|config)/' },
    },
    {
      name: 'packages-never-import-apps',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular imports between files. Split the shared part out, or invert the dependency.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      comment:
        'The import does not resolve to a file. Note `@inmolink/core/modules/<m>/<file>` paths do not exist — use the index.',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'no-undeclared-dependency',
      severity: 'error',
      comment: 'Imported package is not declared in the nearest package.json.',
      from: {},
      // An optional peer that is also a devDependency (platform → fastify) carries npm-no-pkg too.
      to: {
        dependencyTypes: ['npm-no-pkg', 'npm-unknown'],
        dependencyTypesNot: ['npm', 'npm-dev', 'npm-peer', 'npm-optional'],
      },
    },
  ],
  options: {
    doNotFollow: { path: '(^|/)node_modules/' },
    // node_modules stays in the graph (doNotFollow) so npm rules can see edges into it.
    exclude: { path: '(^|/)(dist|\\.next|\\.turbo|coverage|test-results)/|^apps/wp-plugin/' },
    moduleSystems: ['es6', 'cjs'],
    // Type-only imports count: a boundary is a boundary for types too.
    tsPreCompilationDeps: true,
    combinedDependencies: false,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['@inmolink/source', 'import', 'types', 'node', 'default'],
      extensions: ['.ts', '.tsx', '.d.ts', '.js', '.mjs', '.cjs', '.json'],
      mainFields: ['module', 'main', 'types'],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
