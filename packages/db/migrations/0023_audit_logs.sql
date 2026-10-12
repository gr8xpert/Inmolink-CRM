CREATE TABLE "audit_logs" (
	"id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"agency_id" uuid NOT NULL,
	"type" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_user_id" uuid,
	"impersonated_by" uuid,
	"target_type" text,
	"target_id" uuid,
	"request_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "audit_logs_id_occurred_at_pk" PRIMARY KEY("id","occurred_at"),
	CONSTRAINT "audit_logs_type_ck" CHECK ("audit_logs"."type" ~ '^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*){1,4}$'),
	CONSTRAINT "audit_logs_actor_kind_ck" CHECK ("audit_logs"."actor_kind" in ('user', 'staff', 'system', 'apiKey', 'anonymous')),
	CONSTRAINT "audit_logs_target_ck" CHECK (("audit_logs"."target_type" is null) = ("audit_logs"."target_id" is null)),
	CONSTRAINT "audit_logs_target_type_ck" CHECK ("audit_logs"."target_type" is null or "audit_logs"."target_type" ~ '^[a-z][a-zA-Z0-9]{0,39}$'),
	CONSTRAINT "audit_logs_request_id_ck" CHECK ("audit_logs"."request_id" is null or length("audit_logs"."request_id") <= 128),
	CONSTRAINT "audit_logs_metadata_ck" CHECK (jsonb_typeof("audit_logs"."metadata") = 'object' and octet_length("audit_logs"."metadata"::text) <= 4096)
) PARTITION BY RANGE ("occurred_at"); -- S1-08: hand-added (drizzle has no PARTITION BY); partman setup in 0024
--> statement-breakpoint
CREATE INDEX "audit_logs_agency_idx" ON "audit_logs" USING btree ("agency_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "audit_logs_target_idx" ON "audit_logs" USING btree ("target_id","occurred_at") WHERE "audit_logs"."target_id" is not null;
