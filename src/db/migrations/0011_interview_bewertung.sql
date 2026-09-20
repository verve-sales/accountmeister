CREATE TYPE "public"."influence" AS ENUM('UNBEKANNT', 'HOCH', 'MITTEL', 'NIEDRIG');--> statement-breakpoint
CREATE TYPE "public"."interview_kind" AS ENUM('KUNDE_NEU', 'SETUP_ERGAENZUNG');--> statement-breakpoint
CREATE TYPE "public"."interview_status" AS ENUM('LAUFEND', 'ABGESCHLOSSEN', 'VERWORFEN');--> statement-breakpoint
CREATE TYPE "public"."stance" AS ENUM('UNBEKANNT', 'POSITIV', 'NEUTRAL', 'KRITISCH');--> statement-breakpoint
ALTER TYPE "public"."source_type" ADD VALUE 'INTERVIEW';--> statement-breakpoint
ALTER TYPE "public"."suggestion_type" ADD VALUE 'KONTAKTAUFNAHME';--> statement-breakpoint
CREATE TABLE "interview_turns" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"interview_id" text NOT NULL,
	"seq" integer NOT NULL,
	"role" text NOT NULL,
	"text" text NOT NULL,
	"rationale" text,
	"ai_job_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interviews" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"kind" "interview_kind" NOT NULL,
	"setup_id" text,
	"status" "interview_status" DEFAULT 'LAUFEND' NOT NULL,
	"title" text NOT NULL,
	"coverage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"question_count" integer DEFAULT 0 NOT NULL,
	"source_id" text,
	"proposal_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "person_assessments" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"person_id" text NOT NULL,
	"setup_id" text NOT NULL,
	"decision_role" "decision_role",
	"stance" "stance" DEFAULT 'UNBEKANNT' NOT NULL,
	"influence" "influence" DEFAULT 'UNBEKANNT' NOT NULL,
	"epistemic_status" "epistemic_status" DEFAULT 'HYPOTHESE' NOT NULL,
	"note" text,
	"source_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "intake_proposals" ADD COLUMN "kind" text DEFAULT 'DOKUMENT' NOT NULL;--> statement-breakpoint
ALTER TABLE "intake_proposals" ADD COLUMN "interview_id" text;--> statement-breakpoint
ALTER TABLE "intake_proposals" ADD COLUMN "target_setup_id" text;--> statement-breakpoint
ALTER TABLE "interview_turns" ADD CONSTRAINT "interview_turns_interview_id_interviews_id_fk" FOREIGN KEY ("interview_id") REFERENCES "public"."interviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_turns" ADD CONSTRAINT "interview_turns_ai_job_id_ai_jobs_id_fk" FOREIGN KEY ("ai_job_id") REFERENCES "public"."ai_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_setup_id_project_setups_id_fk" FOREIGN KEY ("setup_id") REFERENCES "public"."project_setups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_assessments" ADD CONSTRAINT "person_assessments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_assessments" ADD CONSTRAINT "person_assessments_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_assessments" ADD CONSTRAINT "person_assessments_setup_id_project_setups_id_fk" FOREIGN KEY ("setup_id") REFERENCES "public"."project_setups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_assessments" ADD CONSTRAINT "person_assessments_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_assessments" ADD CONSTRAINT "person_assessments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "interview_turns_seq_uq" ON "interview_turns" USING btree ("interview_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "person_assessments_uq" ON "person_assessments" USING btree ("person_id","setup_id");--> statement-breakpoint
ALTER TABLE "intake_proposals" ADD CONSTRAINT "intake_proposals_target_setup_id_project_setups_id_fk" FOREIGN KEY ("target_setup_id") REFERENCES "public"."project_setups"("id") ON DELETE no action ON UPDATE no action;