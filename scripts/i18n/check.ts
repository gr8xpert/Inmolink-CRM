// pnpm i18n:check
//
// Fails (exit 1) when a UI catalog is out of line with the default locale (PATTERNS §21): a key
// missing in EN or ES (hand-written), a drafted locale not yet drafted, an orphan key, a renamed or
// dropped `{placeholder}`, or an empty value. Drafted keys still awaiting review are reported, not
// failed. Runs in `pnpm verify` (via the i18n package tests) and in CI.
import { localeConfig } from '@inmolink/i18n';
import { checkCatalogs } from '@inmolink/i18n/tools';

const { errors, warnings, drafts } = checkCatalogs(localeConfig);
for (const w of warnings) console.warn(`warn  ${w}`);
for (const [locale, n] of Object.entries(drafts)) {
  if (n.todo + n.draft > 0) console.log(`info  ${locale}: ${n.todo} keys to translate, ${n.draft} drafts to review`);
}
if (errors.length > 0) {
  for (const e of errors) console.error(`error ${e}`);
  console.error(`\ni18n:check failed with ${errors.length} problem(s).`);
  process.exit(1);
}
console.log(`i18n:check passed for ${localeConfig.ui.locales.join(', ')}.`);
