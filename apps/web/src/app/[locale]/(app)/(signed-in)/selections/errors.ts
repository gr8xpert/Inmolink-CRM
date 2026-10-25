import type { SelectionShareDto } from '@inmolink/contracts';

/** Error codes the selection pages explain (i18n keys `selections.errors.*`); anything else is `generic`. */
export const SELECTION_ERRORS = [
  'FORBIDDEN',
  'SELECTION_NOT_FOUND',
  'SELECTION_GONE',
  'SELECTION_ITEMS_INVALID',
  'BOOKMARK_FOLDER_NOT_FOUND',
  'CONTACT_NOT_FOUND',
  'VALIDATION_FAILED',
  'VERSION_CONFLICT',
  'RATE_LIMITED',
] as const;
export type SelectionError = (typeof SELECTION_ERRORS)[number] | 'generic';

/** Notices after a form (`?done=`). */
export const SELECTION_DONE = ['revoked'] as const;

/** What a create or rotate form came back with: the link is shown once, so it travels in the form state, never a URL. */
export type ShareState = { error?: SelectionError; share?: SelectionShareDto; selectionId?: string } | null;
