CREATE TABLE "portal_connection_issues" (
	"connection_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"agency_id" uuid NOT NULL,
	"errors" jsonb NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "portal_connection_issues_connection_id_property_id_pk" PRIMARY KEY("connection_id","property_id")
);
--> statement-breakpoint
ALTER TABLE "agency_portal_connections" ADD COLUMN "last_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agency_portal_connections" ADD COLUMN "last_valid_count" integer;--> statement-breakpoint
ALTER TABLE "agency_portal_connections" ADD COLUMN "last_invalid_count" integer;--> statement-breakpoint
ALTER TABLE "portal_connection_issues" ADD CONSTRAINT "portal_connection_issues_connection_fk" FOREIGN KEY ("agency_id","connection_id") REFERENCES "public"."agency_portal_connections"("agency_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_connection_issues" ADD CONSTRAINT "portal_connection_issues_property_fk" FOREIGN KEY ("property_id","agency_id") REFERENCES "public"."properties"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portal_connection_issues_property_idx" ON "portal_connection_issues" USING btree ("property_id");