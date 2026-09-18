CREATE TYPE "public"."ai_job_status" AS ENUM('GESTARTET', 'ERFOLGREICH', 'ABGELEHNT', 'FEHLER');--> statement-breakpoint
CREATE TYPE "public"."feedback_reason" AS ENUM('FALSCHE_ANNAHME', 'BEREITS_ERLEDIGT', 'UNPASSEND', 'NICHT_ZULAESSIG', 'KEIN_AKTUELLER_ANLASS', 'SONSTIGES');--> statement-breakpoint
CREATE TYPE "public"."open_question_status" AS ENUM('OFFEN', 'IN_KLAERUNG', 'BEANTWORTET', 'ZURUECKGESTELLT');--> statement-breakpoint
CREATE TYPE "public"."priority_category" AS ENUM('KONKRETE_ANFRAGE', 'BLOCKIERTE_AKTION', 'NEUE_INFORMATION', 'ZUGANGSLUECKE', 'PLANUNGSANLASS', 'VERBESSERUNGSIDEE');--> statement-breakpoint
CREATE TYPE "public"."suggestion_status" AS ENUM('NEU', 'GEPRUEFT', 'ANGENOMMEN', 'VERAENDERT', 'ZURUECKGESTELLT', 'ABGELEHNT', 'ERLEDIGT', 'UEBERHOLT');--> statement-breakpoint
CREATE TYPE "public"."suggestion_type" AS ENUM('BEOBACHTUNG', 'AKTION', 'ENTSCHEIDUNG', 'OFFENE_FRAGE', 'PERSON', 'KONFLIKT');--> statement-breakpoint
CREATE TABLE "ai_jobs" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"type" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"setup_id" text,
	"review_id" text,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"input_hash" text NOT NULL,
	"input_chars" integer NOT NULL,
	"status" "ai_job_status" DEFAULT 'GESTARTET' NOT NULL,
	"item_count" integer,
	"rejected_count" integer,
	"error" text,
	"dedupe_key" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "open_questions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"setup_id" text NOT NULL,
	"question" text NOT NULL,
	"decision_impact" text,
	"possible_source" text,
	"owner_user_id" text,
	"action_id" text,
	"answer" text,
	"answer_source_id" text,
	"status" "open_question_status" DEFAULT 'OFFEN' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suggestions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"type" "suggestion_type" NOT NULL,
	"title" text NOT NULL,
	"target_role" text NOT NULL,
	"setup_id" text NOT NULL,
	"review_id" text,
	"object_type" text,
	"object_id" text,
	"trigger" text NOT NULL,
	"source_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"evidence_quote" text NOT NULL,
	"observation" text NOT NULL,
	"hypothesis" text,
	"uncertainty" text,
	"why_now" text,
	"next_step" text,
	"proposed_question" text,
	"expected_result" text,
	"proposed_owner_user_id" text,
	"mentioned_person_name" text,
	"priority_category" "priority_category" DEFAULT 'NEUE_INFORMATION' NOT NULL,
	"dedupe_key" text NOT NULL,
	"recheck_trigger" text,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ai_job_id" text,
	"status" "suggestion_status" DEFAULT 'NEU' NOT NULL,
	"feedback_reason" "feedback_reason",
	"feedback_note" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"accepted_object_type" text,
	"accepted_object_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_setup_id_project_setups_id_fk" FOREIGN KEY ("setup_id") REFERENCES "public"."project_setups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_questions" ADD CONSTRAINT "open_questions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_questions" ADD CONSTRAINT "open_questions_setup_id_project_setups_id_fk" FOREIGN KEY ("setup_id") REFERENCES "public"."project_setups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_questions" ADD CONSTRAINT "open_questions_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_questions" ADD CONSTRAINT "open_questions_action_id_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."actions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_questions" ADD CONSTRAINT "open_questions_answer_source_id_sources_id_fk" FOREIGN KEY ("answer_source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_questions" ADD CONSTRAINT "open_questions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_setup_id_project_setups_id_fk" FOREIGN KEY ("setup_id") REFERENCES "public"."project_setups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_proposed_owner_user_id_users_id_fk" FOREIGN KEY ("proposed_owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_ai_job_id_ai_jobs_id_fk" FOREIGN KEY ("ai_job_id") REFERENCES "public"."ai_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_jobs_ws_started_idx" ON "ai_jobs" USING btree ("workspace_id","started_at");--> statement-breakpoint
CREATE INDEX "open_questions_setup_idx" ON "open_questions" USING btree ("setup_id");--> statement-breakpoint
CREATE INDEX "suggestions_setup_status_idx" ON "suggestions" USING btree ("setup_id","status");--> statement-breakpoint
CREATE INDEX "suggestions_dedupe_idx" ON "suggestions" USING btree ("setup_id","dedupe_key");