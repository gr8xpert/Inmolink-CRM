/// <reference lib="webworker" />

/**
 * SHA-256 of a chosen file, off the main thread (S3-06): the media manager posts `{ id, file }` and gets back
 * `{ id, sha256 }` (lowercase hex) or `{ id, error }`. Reading and digesting a 40 MB photo here keeps the page
 * responsive while dozens are hashed.
 */
declare const self: DedicatedWorkerGlobalScope;

self.onmessage = async (event: MessageEvent<{ id: number; file: Blob }>) => {
  const { id, file } = event.data;
  try {
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    const sha256 = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    self.postMessage({ id, sha256 });
  } catch (err) {
    self.postMessage({ id, error: err instanceof Error ? err.message : 'hash failed' });
  }
};
