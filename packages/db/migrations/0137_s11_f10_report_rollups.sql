CREATE TABLE "crm_response_rollups" (
	"agency_id" uuid NOT NULL,
	"day" date NOT NULL,
	"responder_user_id" uuid,
	"leads" integer NOT NULL,
	"responded" integer NOT NULL,
	"seconds_sum" bigint NOT NULL,
	"seconds" integer[] DEFAULT '{}'::int[] NOT NULL,
	"refreshed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_response_rollups_uq" UNIQUE NULLS NOT DISTINCT("agency_id","day","responder_user_id"),
	CONSTRAINT "crm_response_rollups_counts_ck" CHECK ("crm_response_rollups"."responded" between 0 and "crm_response_rollups"."leads" and "crm_response_rollups"."leads" > 0),
	CONSTRAINT "crm_response_rollups_seconds_ck" CHECK (cardinality("crm_response_rollups"."seconds") = "crm_response_rollups"."responded")
);
--> statement-breakpoint
CREATE TABLE "crm_stage_counts" (
	"agency_id" uuid NOT NULL,
	"stage_id" uuid NOT NULL,
	"leads" integer NOT NULL,
	"entered_epoch_sum" double precision NOT NULL,
	"refreshed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_stage_counts_agency_id_stage_id_pk" PRIMARY KEY("agency_id","stage_id"),
	CONSTRAINT "crm_stage_counts_leads_ck" CHECK ("crm_stage_counts"."leads" > 0)
);
--> statement-breakpoint
CREATE TABLE "crm_stage_move_rollups" (
	"agency_id" uuid NOT NULL,
	"day" date NOT NULL,
	"stage_id" uuid NOT NULL,
	"entered" integer NOT NULL,
	"exited" integer NOT NULL,
	"stay_sum" double precision NOT NULL,
	"stays" double precision[] DEFAULT '{}'::float8[] NOT NULL,
	"refreshed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_stage_move_rollups_agency_id_day_stage_id_pk" PRIMARY KEY("agency_id","day","stage_id"),
	CONSTRAINT "crm_stage_move_rollups_counts_ck" CHECK ("crm_stage_move_rollups"."entered" >= 0 and "crm_stage_move_rollups"."exited" >= 0 and "crm_stage_move_rollups"."entered" + "crm_stage_move_rollups"."exited" > 0),
	CONSTRAINT "crm_stage_move_rollups_stays_ck" CHECK (cardinality("crm_stage_move_rollups"."stays") = "crm_stage_move_rollups"."exited")
);
--> statement-breakpoint
ALTER TABLE "crm_response_rollups" ADD CONSTRAINT "crm_response_rollups_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_stage_counts" ADD CONSTRAINT "crm_stage_counts_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_stage_move_rollups" ADD CONSTRAINT "crm_stage_move_rollups_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- S11-F10 backfill (pre-launch data, single statements): the rollups of the leads and moves as they are now; the
-- worker keeps them from here (crm.refreshStageCounts / crm.refreshReportDay).
INSERT INTO "crm_stage_counts" ("agency_id", "stage_id", "leads", "entered_epoch_sum")
SELECT "agency_id", "stage_id", count(*)::int, sum(extract(epoch from "stage_entered_at"))
  FROM "leads" GROUP BY 1, 2;--> statement-breakpoint
INSERT INTO "crm_response_rollups" ("agency_id", "day", "responder_user_id", "leads", "responded", "seconds_sum", "seconds")
SELECT "agency_id", ("created_ms" at time zone 'UTC')::date, "first_responder_user_id", count(*)::int,
       count("response_seconds")::int, coalesce(sum("response_seconds"), 0)::bigint,
       coalesce(array_agg("response_seconds" order by "response_seconds") filter (where "response_seconds" is not null), '{}')
  FROM "leads" WHERE "source" <> 'MANUAL' GROUP BY 1, 2, 3;--> statement-breakpoint
INSERT INTO "crm_stage_move_rollups" ("agency_id", "day", "stage_id", "entered", "exited", "stay_sum", "stays")
SELECT "agency_id", ("changed_at" at time zone 'UTC')::date, "stage_id", sum("entered")::int, sum("exited")::int,
       coalesce(sum("stay"), 0), coalesce(array_agg("stay" order by "stay") filter (where "stay" is not null), '{}')
  FROM (
    SELECT "agency_id", "changed_at", "to_stage_id" AS "stage_id", 1 AS "entered", 0 AS "exited", null::float8 AS "stay"
      FROM "lead_stage_history"
    UNION ALL
    SELECT "agency_id", "changed_at", "from_stage_id", 0, 1, extract(epoch from "changed_at" - "from_entered_at")::float8
      FROM "lead_stage_history" WHERE "from_stage_id" IS NOT NULL
  ) m
 GROUP BY 1, 2, 3;
