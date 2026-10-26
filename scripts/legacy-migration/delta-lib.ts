// Legacy delta reader (S14-04). Moved into the migration module on the `platform/legacy-db` adapter (S15-F4) so the
// worker's hourly job uses the same reader; the manual `legacy:delta` / `legacy:cutover` scripts import it from here.
export {
  type DeltaMode,
  type LegacyDeltaReader,
  type OpenDeltaOptions,
  openLegacyDeltaReader,
} from '@inmolink/core/modules/migration';
