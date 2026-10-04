CREATE TYPE "public"."moco_hint_status" AS ENUM('OFFEN', 'UEBERNOMMEN', 'VERWORFEN');--> statement-breakpoint
CREATE TYPE "public"."moco_import_status" AS ENUM('ENTWURF', 'UEBERNOMMEN', 'VERWORFEN');--> statement-breakpoint
ALTER TYPE "public"."membership_contribution" ADD VALUE 'PRINCIPAL_ZUSTAENDIG';--> statement-breakpoint
CREATE TABLE "moco_events" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"target" text NOT NULL,
	"event" text NOT NULL,
	"moco_id" integer,
	"signature_ok" boolean NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "moco_hints" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "moco_hint_status" DEFAULT 'OFFEN' NOT NULL,
	"dedupe_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text
);
--> statement-breakpoint
CREATE TABLE "moco_imports" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"status" "moco_import_status" DEFAULT 'ENTWURF' NOT NULL,
	"items" jsonb NOT NULL,
	"decisions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"summary" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "moco_company_id" integer;--> statement-breakpoint
ALTER TABLE "engagements" ADD COLUMN "moco_project_id" integer;--> statement-breakpoint
ALTER TABLE "engagements" ADD COLUMN "moco_contract_id" integer;--> statement-breakpoint
ALTER TABLE "freelancers" ADD COLUMN "moco_user_id" integer;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "moco_project_id" integer;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "moco_deal_id" integer;--> statement-breakpoint
ALTER TABLE "project_setups" ADD COLUMN "moco_project_group_id" integer;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "moco_unit_id" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "moco_user_id" integer;--> statement-breakpoint
ALTER TABLE "moco_hints" ADD CONSTRAINT "moco_hints_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moco_hints" ADD CONSTRAINT "moco_hints_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moco_imports" ADD CONSTRAINT "moco_imports_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moco_imports" ADD CONSTRAINT "moco_imports_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "moco_hints_dedupe_uq" ON "moco_hints" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "moco_hints_subject_idx" ON "moco_hints" USING btree ("subject_type","subject_id","status");