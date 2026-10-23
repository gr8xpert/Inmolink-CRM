# Public media host (S3-F4)

Listing photos are served from the `inmolink-media` bucket (Cloudflare R2 in production, MinIO locally) under
deterministic variant keys: `v<pipeline>/<32 hex public id>/<variant>.<ext>` (`packages/core/src/modules/media/variants.ts`).
The JS widget script (S8-F8, `pnpm ops:widget-publish`) is the one other public shape:
`vwidget/<32 hex of its SHA-256>/inmolink-widget.iife.js`.
Nothing else in that bucket may be readable without credentials: originals and masters live in the work bucket (`inmolink-media-work`, S3-F9),
but a stray object (a bug, a manual upload) must not become public either.

## Local and test (MinIO)

`docker compose` applies `infra/storage/media-public-policy.json` (anonymous `s3:GetObject` on
`inmolink-media/v?/<32 × ?>/*`, `v??/…`, `v???/…` and `vwidget/<32 × ?>/inmolink-widget.iife.js` only) in the
`minio-init` / `minio-init-test` containers. Checked by
`packages/core/src/modules/media/__tests__/public-host.int.test.ts` (`[S3-F4]`, `[S8-F8]`): a variant key and the widget
key answer 200, any other key 403. A running stack picks up a changed policy only when `minio-init` runs again (or
`mc anonymous set-json` / an S3 `PutBucketPolicy` on `inmolink-media`).

## Production (Cloudflare R2) — needs H3/H5

R2 has no per-prefix public access: the bucket is public only through its custom domain (e.g. `media.inmolink.es`),
so the line is held at the edge.

1. R2 → `inmolink-media` → Settings → Public access: connect the custom domain; keep the `r2.dev` URL **disabled**.
2. Security → WAF → Custom rules, on the media hostname, action **Block**:

   ```
   (http.host eq "media.inmolink.es" and not (http.request.uri.path matches "^/v[0-9]{1,3}/[0-9a-f]{32}/[a-z0-9-]+\.(webp|jpg|avif)$" or http.request.uri.path matches "^/vwidget/[0-9a-f]{32}/inmolink-widget\.iife\.js$"))
   ```

   (`matches` needs a Business plan or the Pro regex add-on; on Free, use a Transform Rule that rewrites any other
   path to `/__blocked` — an object that never exists — together with `starts_with(http.request.uri.path, "/v")`.)
3. Rules → Transform Rules → Modify Response Header, on the media hostname: **set** `X-Content-Type-Options: nosniff`
   (a browser then never runs or renders an object as anything but its stored type; the widget is stored as
   `text/javascript; charset=utf-8`, photos as their image type).
4. Check from outside: `curl -sI https://media.inmolink.es/v1/<32 hex>/card.webp` → 200 for a real photo;
   `curl -sI https://media.inmolink.es/anything-else.webp` → 403; a published widget URL → 200 with
   `x-content-type-options: nosniff`; `curl -sI https://media.inmolink.es/vwidget/<32 hex>/other.js` → 403.
