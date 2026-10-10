// pnpm i18n:draft
//
// Brings every drafted UI locale (all except the hand-written EN and ES) in line with EN: missing
// keys are added, removed keys dropped, existing translations kept. Until the AI gateway exists
// (S12-01) a new key gets the EN text and a `todo` mark in `messages/<locale>/_drafts.json`; after
// that it gets an AI draft marked `draft` for review. Hand-written locales are never written —
// missing keys there are listed for a human. Also regenerates `catalogs.generated.ts` (the bundled
// catalogs of the configured locales). Then run `pnpm i18n:check`.
import { localeConfig } from '@inmolink/i18n';
import { draftCatalogs } from '@inmolink/i18n/tools';

const result = await draftCatalogs(localeConfig);
for (const [locale, { added, removed }] of Object.entries(result.locales)) {
  console.log(`${locale}: ${added} added (marked todo), ${removed} removed`);
}
if (Object.keys(result.locales).length === 0) console.log('No drafted locales configured (all are hand-written).');
if (result.indexChanged) console.log('Updated packages/i18n/src/catalogs.generated.ts.');
if (result.handwrittenMissing.length > 0) {
  console.error('\nHand-written locales are missing keys — write these by hand:');
  for (const k of result.handwrittenMissing) console.error(`  ${k}`);
  process.exit(1);
}
