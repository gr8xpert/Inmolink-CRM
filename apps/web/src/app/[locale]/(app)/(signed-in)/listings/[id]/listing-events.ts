/**
 * A saved change to a listing, announced in the page (S3-08): the editor and the media manager are separate
 * client islands, and the quality panel refreshes its score when either saves — without a page reload.
 */
const LISTING_CHANGED = 'inmolink:listing-changed';

/** Tells the page a change to listing `id` was saved. */
export function notifyListingChanged(id: string, target: EventTarget = window): void {
  target.dispatchEvent(new CustomEvent<string>(LISTING_CHANGED, { detail: id }));
}

/** Calls `fn` after each saved change to listing `id`; answers the unsubscribe. */
export function onListingChanged(id: string, fn: () => void, target: EventTarget = window): () => void {
  const listener = (e: Event) => {
    if ((e as CustomEvent<string>).detail === id) fn();
  };
  target.addEventListener(LISTING_CHANGED, listener);
  return () => target.removeEventListener(LISTING_CHANGED, listener);
}
