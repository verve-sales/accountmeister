CREATE TYPE "public"."extract_status" AS ENUM('OK', 'TEILWEISE', 'LEER', 'FEHLER');--> statement-breakpoint
CREATE TYPE "public"."intake_status" AS ENUM('ENTWURF', 'UEBERNOMMEN', 'VERWORFEN');--> statement-breakpoint
ALTER TYPE "public"."source_type" ADD VALUE 'DOKUMENT';--> statement-breakpoint
CREATE TABLE "ai_task_settings" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"task" text NOT NULL,
	"model" text NOT NULL,
	"temperature" real DEFAULT 0.2 NOT NULL,
	"max_output_tokens" integer DEFAULT 4000 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"source_id" text NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"storage_path" text,
	"extract_status" "extract_status" NOT NULL,
	"extract_note" text,
	"page_count" integer,
	"uploaded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "intake_proposals" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"source_id" text NOT NULL,
	"ai_job_id" text,
	"status" "intake_status" DEFAULT 'ENTWURF' NOT NULL,
	"payload" jsonb NOT NULL,
	"result_account_id" text,
	"result_setup_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_jobs" ADD COLUMN "tokens_in" integer;--> statement-breakpoint
ALTER TABLE "ai_jobs" ADD COLUMN "tokens_out" integer;--> statement-breakpoint
ALTER TABLE "ai_task_settings" ADD CONSTRAINT "ai_task_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_task_settings" ADD CONSTRAINT "ai_task_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_proposals" ADD CONSTRAINT "intake_proposals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_proposals" ADD CONSTRAINT "intake_proposals_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_proposals" ADD CONSTRAINT "intake_proposals_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_proposals" ADD CONSTRAINT "intake_proposals_ai_job_id_ai_jobs_id_fk" FOREIGN KEY ("ai_job_id") REFERENCES "public"."ai_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_proposals" ADD CONSTRAINT "intake_proposals_result_account_id_accounts_id_fk" FOREIGN KEY ("result_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_proposals" ADD CONSTRAINT "intake_proposals_result_setup_id_project_setups_id_fk" FOREIGN KEY ("result_setup_id") REFERENCES "public"."project_setups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_task_settings_uq" ON "ai_task_settings" USING btree ("workspace_id","task");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_source_uq" ON "documents" USING btree ("source_id");