CREATE TYPE "public"."access_plan_status" AS ENUM('ENTWURF', 'IN_ABSTIMMUNG', 'VERMITTLUNG_ZUGESAGT', 'VORGESTELLT', 'NICHT_MOEGLICH', 'BEENDET');--> statement-breakpoint
CREATE TYPE "public"."access_step_kind" AS ENUM('BELEGT', 'GEPLANT', 'HYPOTHETISCH');--> statement-breakpoint
CREATE TYPE "public"."mediation_readiness" AS ENUM('UNBEKANNT', 'ANGEFRAGT', 'BEREIT', 'ABGELEHNT');--> statement-breakpoint
CREATE TABLE "access_plan_steps" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"access_plan_id" text NOT NULL,
	"position" integer NOT NULL,
	"from_user_id" text,
	"from_person_id" text,
	"to_person_id" text NOT NULL,
	"kind" "access_step_kind" DEFAULT 'HYPOTHETISCH' NOT NULL,
	"relationship_id" text,
	"evidence_source_id" text,
	"mediation_readiness" "mediation_readiness" DEFAULT 'UNBEKANNT' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "access_plans" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"setup_id" text NOT NULL,
	"target_person_id" text,
	"target_function" text,
	"occasion" text NOT NULL,
	"desired_outcome" text,
	"allowed_intro_content" text,
	"alternative" text,
	"owner_user_id" text NOT NULL,
	"next_step" text,
	"status" "access_plan_status" DEFAULT 'ENTWURF' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "access_plan_steps" ADD CONSTRAINT "access_plan_steps_access_plan_id_access_plans_id_fk" FOREIGN KEY ("access_plan_id") REFERENCES "public"."access_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_plan_steps" ADD CONSTRAINT "access_plan_steps_from_user_id_users_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_plan_steps" ADD CONSTRAINT "access_plan_steps_from_person_id_persons_id_fk" FOREIGN KEY ("from_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_plan_steps" ADD CONSTRAINT "access_plan_steps_to_person_id_persons_id_fk" FOREIGN KEY ("to_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_plan_steps" ADD CONSTRAINT "access_plan_steps_relationship_id_relationships_id_fk" FOREIGN KEY ("relationship_id") REFERENCES "public"."relationships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_plan_steps" ADD CONSTRAINT "access_plan_steps_evidence_source_id_sources_id_fk" FOREIGN KEY ("evidence_source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_plans" ADD CONSTRAINT "access_plans_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_plans" ADD CONSTRAINT "access_plans_setup_id_project_setups_id_fk" FOREIGN KEY ("setup_id") REFERENCES "public"."project_setups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_plans" ADD CONSTRAINT "access_plans_target_person_id_persons_id_fk" FOREIGN KEY ("target_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_plans" ADD CONSTRAINT "access_plans_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_plans" ADD CONSTRAINT "access_plans_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_plan_steps_plan_idx" ON "access_plan_steps" USING btree ("access_plan_id");--> statement-breakpoint
CREATE INDEX "access_plans_setup_idx" ON "access_plans" USING btree ("setup_id");