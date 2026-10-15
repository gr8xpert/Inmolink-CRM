-- S3-03: property_media references media by SHA-256 instead of a media_objects uuid (the next migration swaps
-- the column). No media existed before the upload pipeline, so only test rows (no real file behind them) are
-- dropped. TRUNCATE, not DELETE: forced RLS hides every row from the owner role.
TRUNCATE TABLE "property_media";
