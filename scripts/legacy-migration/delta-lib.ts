// Legacy delta reader (S14-04). Lives in the migration module on the `platform/legacy-dump` adapter (S15-F4, S17-F4);
// the manual `legacy:delta` / `legacy:cutover` scripts import it from here.
export {
  type DeltaMode,
  type LegacyDeltaReader,
  type OpenDeltaOptions,
  openLegacyDeltaReader,
} from '@inmolink/core/modules/migration';
