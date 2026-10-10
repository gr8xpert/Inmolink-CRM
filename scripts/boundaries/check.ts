/**
 * `pnpm check:boundaries` (S0-12) — dependency-cruiser over the workspace with `.dependency-cruiser.cjs`.
 * Runs from the current directory, so the boundary tests can point it at a sandbox copy.
 *
 * One cruise for the packages and node apps, one per Next app: each Next app resolves its own `@/`
 * alias (tsconfig `paths`), which a single cruise cannot express.
 */
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { cruise, type ICruiseOptions, type IResolveOptions } from 'dependency-cruiser';
import extractDepcruiseOptions from 'dependency-cruiser/config-utl/extract-depcruise-options';

interface Run {
  label: string;
  paths: string[];
  resolve?: Partial<IResolveOptions>;
}

/** Every TypeScript app under `apps/` (one with a package.json); a Next app has a `next.config.*`. */
function discoverApps(root: string): { next: string[]; node: string[] } {
  const apps = readdirSync(resolve(root, 'apps'), { withFileTypes: true })
    .filter(
      (d) => d.isDirectory() && d.name !== 'wp-plugin' && existsSync(resolve(root, 'apps', d.name, 'package.json')),
    )
    .map((d) => `apps/${d.name}`);
  const isNext = (app: string) => readdirSync(resolve(root, app)).some((f) => f.startsWith('next.config.'));
  return { next: apps.filter(isNext), node: apps.filter((a) => !isNext(a)) };
}

async function main(): Promise<void> {
  const root = process.cwd();
  const { next: NEXT_APPS, node: NODE_APPS } = discoverApps(root);
  const options: ICruiseOptions = {
    ...(await extractDepcruiseOptions(resolve(root, '.dependency-cruiser.cjs'))),
    validate: true,
    outputType: 'err',
  };
  const nextAlias = (app: string): Partial<IResolveOptions> => ({ alias: { '@': resolve(root, app, 'src') } });
  // `check.ts <paths…>` cruises only those paths (one Next app at most) — used by the boundary tests.
  const selected = process.argv.slice(2).map((p) => p.replaceAll('\\', '/'));
  const selectedApp = NEXT_APPS.find((app) => selected.length > 0 && selected.every((p) => p.startsWith(`${app}/`)));
  const runs: Run[] =
    selected.length > 0
      ? [{ label: selected.join(' '), paths: selected, resolve: selectedApp ? nextAlias(selectedApp) : undefined }]
      : [
          { label: 'packages + node apps', paths: ['packages', ...NODE_APPS] },
          ...NEXT_APPS.map((app) => ({ label: app, paths: [app], resolve: nextAlias(app) })),
        ];

  let failed = false;
  for (const run of runs) {
    const missing = run.paths.filter((p) => !existsSync(resolve(root, p)));
    if (missing.length > 0) throw new Error(`boundaries: no such path ${missing.join(', ')}`);
    const result = await cruise(run.paths, options, run.resolve as IResolveOptions | undefined);
    process.stdout.write(`boundaries · ${run.label}: ${String(result.output).trim()}\n`);
    if (result.exitCode !== 0) failed = true;
  }
  process.exitCode = failed ? 1 : 0;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
