/**
 * Which board error a failed post says (S17-F37): the first Zod issue tells a bad expiry from a bad price from
 * contact details in the text; anything else is the neutral "check the fields".
 */
export type PostErrorCode =
  | 'VALIDATION_FAILED'
  | 'VALIDATION_EXPIRY'
  | 'VALIDATION_PRICE'
  | 'VALIDATION_CONTACT'
  | 'VALIDATION_TEXT';

export function postErrorCode(issues: readonly { path: readonly PropertyKey[]; message: string }[]): PostErrorCode {
  const issue = issues[0];
  if (!issue) return 'VALIDATION_FAILED';
  const path = issue.path.map(String);
  if (path.includes('expiresInDays')) return 'VALIDATION_EXPIRY';
  if (path.some((p) => p === 'priceMinCents' || p === 'priceMaxCents')) return 'VALIDATION_PRICE';
  if (issue.message === 'no contact details') return 'VALIDATION_CONTACT';
  if (path[0] === 'title' || path[0] === 'body') return 'VALIDATION_TEXT';
  return 'VALIDATION_FAILED';
}
