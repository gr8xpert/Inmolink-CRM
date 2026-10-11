CREATE TABLE "agency_invites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "member_role" NOT NULL,
	"invited_by" uuid NOT NULL,
	"locale" text NOT NULL,
	"token_hash" text,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_user_id" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Team directory copy of name and email (S1-02): added nullable, filled from users, then required.
ALTER TABLE "agency_members" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "agency_members" ADD COLUMN "email" text;--> statement-breakpoint
-- Both tables FORCE row level security (pnpm db:rls), which hides their rows from the owner running
-- this migration: lift it for the backfill, inside the migration transaction, and restore it.
DO $$
DECLARE users_forced boolean; members_forced boolean;
BEGIN
  SELECT relforcerowsecurity INTO users_forced FROM pg_class WHERE oid = 'public.users'::regclass;
  SELECT relforcerowsecurity INTO members_forced FROM pg_class WHERE oid = 'public.agency_members'::regclass;
  ALTER TABLE "users" NO FORCE ROW LEVEL SECURITY;
  ALTER TABLE "agency_members" NO FORCE ROW LEVEL SECURITY;
  UPDATE "agency_members" m SET "name" = u."name", "email" = u."email" FROM "users" u WHERE u."id" = m."user_id";
  IF users_forced THEN ALTER TABLE "users" FORCE ROW LEVEL SECURITY; END IF;
  IF members_forced THEN ALTER TABLE "agency_members" FORCE ROW LEVEL SECURITY; END IF;
END $$;--> statement-breakpoint
ALTER TABLE "agency_members" ALTER COLUMN "name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agency_members" ALTER COLUMN "email" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agency_members" ADD COLUMN "deactivated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agency_invites" ADD CONSTRAINT "agency_invites_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agency_invites_token_uq" ON "agency_invites" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "agency_invites_open_email_uq" ON "agency_invites" USING btree ("agency_id","email") WHERE accepted_at is null and revoked_at is null;--> statement-breakpoint
CREATE INDEX "agency_invites_agency_created_idx" ON "agency_invites" USING btree ("agency_id","created_at","id");--> statement-breakpoint
CREATE INDEX "agency_members_agency_created_idx" ON "agency_members" USING btree ("agency_id","created_at","user_id");