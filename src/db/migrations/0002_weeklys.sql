CREATE TYPE "public"."review_status" AS ENUM('GEPLANT', 'IN_VORBEREITUNG', 'LAUFEND', 'BESTAETIGUNG_OFFEN', 'BESTAETIGT');--> statement-breakpoint
CREATE TYPE "public"."review_type" AS ENUM('BD_ANKER_WEEKLY', 'PRINCIPAL_BD_WEEKLY', 'CEO_PRINCIPAL_ZIELGESPRAECH');--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"setup_id" text,
	"review_id" text,
	"content" text NOT NULL,
	"scope" text,
	"rationale" text,
	"decided_by_user_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"decided_on" date DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_participants" (
	"review_id" text NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "review_participants_review_id_user_id_pk" PRIMARY KEY("review_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "review_versions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"review_id" text NOT NULL,
	"version_no" integer NOT NULL,
	"note" text,
	"snapshot" jsonb NOT NULL,
	"confirmed_by" text NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"supersedes_version_id" text,
	"correction_note" text
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"type" "review_type" DEFAULT 'BD_ANKER_WEEKLY' NOT NULL,
	"setup_id" text,
	"account_id" text,
	"title" text NOT NULL,
	"scheduled_for" date NOT NULL,
	"status" "review_status" DEFAULT 'GEPLANT' NOT NULL,
	"note_draft" text,
	"confirmed_version_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "actions" ADD COLUMN "review_id" text;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "review_id" text;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_setup_id_project_setups_id_fk" FOREIGN KEY ("setup_id") REFERENCES "public"."project_setups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_participants" ADD CONSTRAINT "review_participants_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_participants" ADD CONSTRAINT "review_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_versions" ADD CONSTRAINT "review_versions_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_versions" ADD CONSTRAINT "review_versions_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_setup_id_project_setups_id_fk" FOREIGN KEY ("setup_id") REFERENCES "public"."project_setups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "decisions_setup_idx" ON "decisions" USING btree ("setup_id");--> statement-breakpoint
CREATE UNIQUE INDEX "review_versions_no_uq" ON "review_versions" USING btree ("review_id","version_no");--> statement-breakpoint
CREATE INDEX "reviews_setup_idx" ON "reviews" USING btree ("setup_id");--> statement-breakpoint
CREATE INDEX "reviews_scheduled_idx" ON "reviews" USING btree ("scheduled_for");--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE no action ON UPDATE no action;