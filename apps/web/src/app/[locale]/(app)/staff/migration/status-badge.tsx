import type { MigrationValidationStatus } from '@inmolink/contracts';

/** PASS / FAIL of a validation report or check (S14-03): text, never colour alone. */
export function StatusBadge({ status, label }: { status: MigrationValidationStatus; label: string }) {
  return (
    <span
      className={
        status === 'PASS'
          ? 'rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-900 dark:bg-emerald-900 dark:text-emerald-100'
          : 'rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-900 dark:bg-red-900 dark:text-red-100'
      }
    >
      {label}
    </span>
  );
}
