ALTER TABLE "agency_portal_connections" ADD COLUMN "idempotency_hash" text;--> statement-breakpoint
ALTER TABLE "agency_portal_connections" ADD COLUMN "idempotency_request_hash" text;--> statement-breakpoint
ALTER TABLE "agency_portal_connections" ADD COLUMN "idempotency_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "agency_portal_connections_idempotency_uq" ON "agency_portal_connections" USING btree ("agency_id","idempotency_hash") WHERE "agency_portal_connections"."idempotency_hash" is not null;