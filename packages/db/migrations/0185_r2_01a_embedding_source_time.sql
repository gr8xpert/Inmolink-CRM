-- R2-01a review: the table is empty everywhere (embeddings are off until a provider is chosen), so NOT NULL needs no default.
ALTER TABLE "listing_embeddings" ADD COLUMN "source_updated_at" timestamp with time zone NOT NULL;--> statement-breakpoint
-- Small in-line rows (the vector is stored out of line): room on the page keeps version touches HOT, so the HNSW graph
-- is not re-inserted into on every price or status edit.
ALTER TABLE "listing_embeddings" SET (fillfactor = 80);
