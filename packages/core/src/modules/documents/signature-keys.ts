import { withSystem } from '@inmolink/db';
import * as repo from './signatures-repo';

/**
 * Where a signed form's PDF is stored (R2-05b): next to the form's own PDF (`form-documents/<agency>/<form>.pdf`), one
 * per signing request — private bucket, under the forms prefix (outside the `documents/` orphan sweep).
 */
export const signedFormKey = (agencyId: string, formId: string, requestId: string): string =>
  `form-documents/${agencyId}/${formId}.signed-${requestId}.pdf`;

/**
 * The signed PDFs' keys of these forms' requests (erasure: read before the rows go — the form's cascade removes its
 * requests, signers and page actions — and deleted before and after them).
 */
export async function signedObjectKeys(agencyId: string, formIds: readonly string[]): Promise<string[]> {
  if (formIds.length === 0) return [];
  const rows = await withSystem('documents.signature.erase', (tx) => repo.requestIdsOfForms(tx, agencyId, formIds));
  return rows.map((r) => signedFormKey(agencyId, r.formId, r.id));
}
