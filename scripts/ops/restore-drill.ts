// pnpm ops:restore-drill --image <ref> --walg-env <file> [--target <iso>] [--docker-host ssh://user@host]
//                        [--network <name>] [--database <db>] [--verify-sql <sql>] [--keep] [--report <path>]
// pnpm ops:restore-drill --cleanup [--docker-host …]   (removes what a cancelled drill left behind)
//
// Point-in-time restore of the WAL-G store onto a fresh Docker host, with measured RTO (S0-15).
// Weekly against the drill host over SSH (.github/workflows/restore-drill.yml); by hand per
// docs/runbooks/pitr-restore.md. Exit 0 = restored, promoted, writable, not archiving and verified; the
// JSON report goes to stdout and --report.
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { cleanupDrills, DrillError, restoreDrill } from './pitr';

const { values } = parseArgs({
  options: {
    image: { type: 'string' },
    'walg-env': { type: 'string' },
    target: { type: 'string' },
    'docker-host': { type: 'string' },
    network: { type: 'string' },
    'verify-sql': { type: 'string' },
    database: { type: 'string' },
    keep: { type: 'boolean', default: false },
    cleanup: { type: 'boolean', default: false },
    report: { type: 'string' },
  },
});

try {
  if (values['docker-host'] && !/^(ssh|tcp|unix):\/\//.test(values['docker-host'])) {
    throw new DrillError('--docker-host must be an ssh://, tcp:// or unix:// URL');
  }
  if (values.cleanup) {
    const removed = await cleanupDrills({ dockerHost: values['docker-host'] });
    console.error(`restore drill cleanup: removed ${removed} container(s)/volume(s)`);
    process.exit(0);
  }
  if (!values.image || !values['walg-env']) throw new DrillError('--image and --walg-env are required');
  const target = values.target === undefined ? undefined : new Date(values.target);
  if (target && Number.isNaN(target.getTime())) throw new DrillError('--target must be an ISO timestamp');
  if (values.database !== undefined && !/^[a-z_][a-z0-9_]{0,62}$/.test(values.database)) {
    throw new DrillError('--database must be a plain database name');
  }
  const report = await restoreDrill({
    image: values.image,
    walgEnvFile: values['walg-env'],
    targetTime: target,
    dockerHost: values['docker-host'],
    network: values.network,
    verifySql: values['verify-sql'],
    database: values.database,
    keep: values.keep,
  });
  const json = JSON.stringify(report, null, 2);
  if (values.report) writeFileSync(values.report, `${json}\n`);
  console.log(json);
  console.error(`restore drill passed: RTO ${report.rtoSeconds} s from backup ${report.backup}`);
} catch (err) {
  console.error(`restore drill FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
