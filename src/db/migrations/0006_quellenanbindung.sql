CREATE TYPE "public"."import_job_status" AS ENUM('VORGESCHLAGEN', 'UEBERNOMMEN', 'AUSGEWERTET', 'BESTAETIGT', 'FEHLER', 'VERWORFEN');--> statement-breakpoint
CREATE TYPE "public"."import_kind" AS ENUM('PROTOKOLL_TEXT', 'PROTOKOLL_DATEI', 'MAIL', 'TERMIN');--> statement-breakpoint
CREATE TYPE "public"."integration_provider" AS ENUM('MICROSOFT_GRAPH');--> statement-breakpoint
CREATE TYPE "public"."integration_status" AS ENUM('VERBUNDEN_FIXTURE', 'VERBUNDEN', 'ABGELAUFEN', 'WIDERRUFEN', 'FEHLER');--> statement-breakpoint
CREATE TYPE "public"."merge_review_status" AS ENUM('OFFEN', 'ZUSAMMENGEFUEHRT', 'NEUE_PERSON', 'IGNORIERT');--> statement-breakpoint
CREATE TABLE "import_jobs" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"kind" "import_kind" NOT NULL,
	"connection_id" text,
	"external_key" text NOT NULL,
	"title" text NOT NULL,
	"setup_id" text,
	"account_id" text,
	"access_class" "access_class" DEFAULT 'PERSOENLICH' NOT NULL,
	"source_id" text,
	"ai_job_id" text,
	"status" "import_job_status" DEFAULT 'VORGESCHLAGEN' NOT NULL,
	"scope_summary" text,
	"warnings" text[] DEFAULT '{}'::text[] NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_connections" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider" "integration_provider" NOT NULL,
	"granted_scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"token_ref" text,
	"account_label" text,
	"status" "integration_status" DEFAULT 'VERBUNDEN_FIXTURE' NOT NULL,
	"fixture_mode" boolean DEFAULT true NOT NULL,
	"last_successful_fetch_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merge_review_items" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"import_job_id" text NOT NULL,
	"mentioned_name" text NOT NULL,
	"mentioned_email" text,
	"candidate_person_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "merge_review_status" DEFAULT 'OFFEN' NOT NULL,
	"decided_person_id" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_versions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"source_id" text NOT NULL,
	"version_no" integer NOT NULL,
	"body" text,
	"content_hash" text NOT NULL,
	"import_job_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_connection_id_integration_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_setup_id_project_setups_id_fk" FOREIGN KEY ("setup_id") REFERENCES "public"."project_setups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_ai_job_id_ai_jobs_id_fk" FOREIGN KEY ("ai_job_id") REFERENCES "public"."ai_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_review_items" ADD CONSTRAINT "merge_review_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_review_items" ADD CONSTRAINT "merge_review_items_import_job_id_import_jobs_id_fk" FOREIGN KEY ("import_job_id") REFERENCES "public"."import_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_review_items" ADD CONSTRAINT "merge_review_items_decided_person_id_persons_id_fk" FOREIGN KEY ("decided_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_review_items" ADD CONSTRAINT "merge_review_items_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_versions" ADD CONSTRAINT "source_versions_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_versions" ADD CONSTRAINT "source_versions_import_job_id_import_jobs_id_fk" FOREIGN KEY ("import_job_id") REFERENCES "public"."import_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "import_jobs_external_uq" ON "import_jobs" USING btree ("workspace_id","kind","external_key");--> statement-breakpoint
CREATE INDEX "import_jobs_actor_idx" ON "import_jobs" USING btree ("actor_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_connections_user_provider_uq" ON "integration_connections" USING btree ("user_id","provider");--> statement-breakpoint
CREATE INDEX "merge_review_items_job_idx" ON "merge_review_items" USING btree ("import_job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_versions_no_uq" ON "source_versions" USING btree ("source_id","version_no");