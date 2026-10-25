CREATE TYPE "public"."social_account_status" AS ENUM('ACTIVE', 'NEEDS_RECONNECT');--> statement-breakpoint
CREATE TYPE "public"."social_caption_status" AS ENUM('NONE', 'PENDING', 'READY', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."social_platform" AS ENUM('FACEBOOK_PAGE', 'INSTAGRAM_BUSINESS');--> statement-breakpoint
CREATE TYPE "public"."social_post_status" AS ENUM('DRAFT', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "social_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"platform" "social_platform" NOT NULL,
	"external_id" text NOT NULL,
	"page_id" text,
	"name" text NOT NULL,
	"token_enc" text NOT NULL,
	"user_token_enc" text,
	"token_expires_at" timestamp with time zone,
	"status" "social_account_status" DEFAULT 'ACTIVE' NOT NULL,
	"status_reason" text,
	"checked_at" timestamp with time zone,
	"connected_by" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "social_accounts_external_uq" UNIQUE("agency_id","platform","external_id"),
	CONSTRAINT "social_accounts_agency_id_uq" UNIQUE("agency_id","id"),
	CONSTRAINT "social_accounts_external_ck" CHECK (length("social_accounts"."external_id") between 1 and 64),
	CONSTRAINT "social_accounts_name_ck" CHECK (length("social_accounts"."name") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "social_posts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"listing_id" uuid NOT NULL,
	"status" "social_post_status" DEFAULT 'DRAFT' NOT NULL,
	"locale" text NOT NULL,
	"caption" text,
	"captions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"caption_status" "social_caption_status" DEFAULT 'NONE' NOT NULL,
	"caption_request_id" uuid,
	"media_ids" uuid[] NOT NULL,
	"scheduled_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"publish_started_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"external_post_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"error_message" text,
	"created_by" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "social_posts_media_ck" CHECK (cardinality("social_posts"."media_ids") between 1 and 10),
	CONSTRAINT "social_posts_caption_ck" CHECK ("social_posts"."caption" is null or length("social_posts"."caption") <= 2200),
	CONSTRAINT "social_posts_scheduled_ck" CHECK ("social_posts"."status" <> 'SCHEDULED' or "social_posts"."scheduled_at" is not null),
	CONSTRAINT "social_posts_captions_ck" CHECK (jsonb_typeof("social_posts"."captions") = 'array' and octet_length("social_posts"."captions"::text) <= 32768)
);
--> statement-breakpoint
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_posts" ADD CONSTRAINT "social_posts_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_posts" ADD CONSTRAINT "social_posts_listing_id_properties_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_posts" ADD CONSTRAINT "social_posts_account_fk" FOREIGN KEY ("agency_id","account_id") REFERENCES "public"."social_accounts"("agency_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "social_accounts_agency_created_idx" ON "social_accounts" USING btree ("agency_id","created_at","id");--> statement-breakpoint
CREATE INDEX "social_accounts_expiry_idx" ON "social_accounts" USING btree ("token_expires_at") WHERE "social_accounts"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "social_posts_agency_created_idx" ON "social_posts" USING btree ("agency_id","created_at","id");--> statement-breakpoint
CREATE INDEX "social_posts_account_idx" ON "social_posts" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "social_posts_listing_idx" ON "social_posts" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX "social_posts_due_idx" ON "social_posts" USING btree ("scheduled_at") WHERE "social_posts"."status" = 'SCHEDULED';