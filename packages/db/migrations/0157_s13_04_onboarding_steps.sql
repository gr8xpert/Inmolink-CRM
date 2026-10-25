CREATE TYPE "public"."onboarding_step" AS ENUM('VERIFY_AGENCY', 'IMPORT_LISTINGS', 'CONNECT_WEBSITE', 'INVITE_TEAM', 'SHARE_LISTING');--> statement-breakpoint
CREATE TABLE "onboarding_steps" (
	"agency_id" uuid NOT NULL,
	"step" "onboarding_step" NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"event_id" uuid NOT NULL,
	CONSTRAINT "onboarding_steps_agency_id_step_pk" PRIMARY KEY("agency_id","step")
);
--> statement-breakpoint
ALTER TABLE "onboarding_steps" ADD CONSTRAINT "onboarding_steps_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE cascade ON UPDATE no action;