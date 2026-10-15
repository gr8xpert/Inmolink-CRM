import type { QualityHint } from '@inmolink/contracts';
import type { T } from '../values';

/** A quality hint's message (S3-08), its numbers filled in. */
export function hintText(t: T, hint: QualityHint): string {
  const vars = Object.fromEntries(Object.entries(hint.params).map(([k, v]) => [k, String(v)]));
  return t(`quality.hints.${hint.code}`, vars);
}
