-- R2-01a: pgvector ships in the Postgres image (infra/docker/postgres) and initdb creates it; kept here for databases made otherwise.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "listing_embeddings" (
	"target_id" uuid PRIMARY KEY NOT NULL,
	"owner_agency_id" uuid NOT NULL,
	"embedding" halfvec(1024) NOT NULL,
	"model" text NOT NULL,
	"content_hash" text NOT NULL,
	"source_version" integer NOT NULL,
	"embedded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "listing_embeddings_version_ck" CHECK ("listing_embeddings"."source_version" >= 1)
);
--> statement-breakpoint
CREATE INDEX "listing_embeddings_hnsw_idx" ON "listing_embeddings" USING hnsw ("embedding" halfvec_cosine_ops);--> statement-breakpoint
CREATE INDEX "listing_embeddings_owner_idx" ON "listing_embeddings" USING btree ("owner_agency_id","target_id");