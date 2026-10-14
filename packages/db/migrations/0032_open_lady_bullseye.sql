-- S1-F9: trigram index for the staff tenant search. pg_trgm is created by initdb locally; make the
-- migration self-contained for managed databases (no-op where it exists).
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX "agencies_name_trgm_idx" ON "agencies" USING gin ("name" gin_trgm_ops);
