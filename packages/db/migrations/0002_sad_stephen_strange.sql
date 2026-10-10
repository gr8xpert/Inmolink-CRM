CREATE TYPE "public"."auth_token_kind" AS ENUM('EMAIL_VERIFY', 'PASSWORD_RESET');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('ACTIVE', 'DISABLED');--> statement-breakpoint
CREATE TABLE "auth_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "auth_token_kind" NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"name" text NOT NULL,
	"locale" text NOT NULL,
	"status" "user_status" DEFAULT 'ACTIVE' NOT NULL,
	"email_verified_at" timestamp with time zone,
	"session_version" integer DEFAULT 1 NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_tokens_hash_uq" ON "auth_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "auth_tokens_user_kind_idx" ON "auth_tokens" USING btree ("user_id","kind") WHERE used_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree ("email");