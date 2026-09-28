CREATE TYPE "public"."playbook_run_status" AS ENUM('AKTIV', 'ABGESCHLOSSEN', 'ZURUECKGESTELLT');--> statement-breakpoint
CREATE TYPE "public"."playbook_scope" AS ENUM('ACCOUNT', 'SETUP', 'OPPORTUNITY');--> statement-breakpoint
CREATE TYPE "public"."playbook_step_status" AS ENUM('WARTET', 'OFFEN', 'ERLEDIGT', 'UEBERSPRUNGEN');--> statement-breakpoint
ALTER TYPE "public"."priority_kind" ADD VALUE 'REAKTIVIEREN';--> statement-breakpoint
CREATE TABLE "playbook_run_steps" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"run_id" text NOT NULL,
	"step_id" text,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"goal" text,
	"meddpicc" text,
	"suggested_action" text,
	"done_criterion" text,
	"due_in_days" integer,
	"status" "playbook_step_status" DEFAULT 'WARTET' NOT NULL,
	"action_id" text,
	"result" text,
	"skip_reason" text,
	"completed_by" text,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "playbook_runs" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"playbook_id" text NOT NULL,
	"playbook_name" text NOT NULL,
	"account_id" text NOT NULL,
	"setup_id" text NOT NULL,
	"opportunity_id" text,
	"owner_user_id" text NOT NULL,
	"status" "playbook_run_status" DEFAULT 'AKTIV' NOT NULL,
	"closed_reason" text,
	"started_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "playbook_steps" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"playbook_id" text NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"goal" text,
	"meddpicc" text,
	"suggested_action" text,
	"done_criterion" text,
	"due_in_days" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "playbooks" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"scope" "playbook_scope" NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "playbook_run_steps" ADD CONSTRAINT "playbook_run_steps_run_id_playbook_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."playbook_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_run_steps" ADD CONSTRAINT "playbook_run_steps_action_id_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."actions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_run_steps" ADD CONSTRAINT "playbook_run_steps_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_runs" ADD CONSTRAINT "playbook_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_runs" ADD CONSTRAINT "playbook_runs_playbook_id_playbooks_id_fk" FOREIGN KEY ("playbook_id") REFERENCES "public"."playbooks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_runs" ADD CONSTRAINT "playbook_runs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_runs" ADD CONSTRAINT "playbook_runs_setup_id_project_setups_id_fk" FOREIGN KEY ("setup_id") REFERENCES "public"."project_setups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_runs" ADD CONSTRAINT "playbook_runs_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_runs" ADD CONSTRAINT "playbook_runs_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_runs" ADD CONSTRAINT "playbook_runs_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_steps" ADD CONSTRAINT "playbook_steps_playbook_id_playbooks_id_fk" FOREIGN KEY ("playbook_id") REFERENCES "public"."playbooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbooks" ADD CONSTRAINT "playbooks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbooks" ADD CONSTRAINT "playbooks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "playbook_run_steps_run_idx" ON "playbook_run_steps" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "playbook_run_steps_action_idx" ON "playbook_run_steps" USING btree ("action_id");--> statement-breakpoint
CREATE INDEX "playbook_runs_account_idx" ON "playbook_runs" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "playbook_runs_setup_idx" ON "playbook_runs" USING btree ("setup_id");--> statement-breakpoint
CREATE INDEX "playbook_steps_playbook_idx" ON "playbook_steps" USING btree ("playbook_id");--> statement-breakpoint
CREATE UNIQUE INDEX "playbooks_code_uq" ON "playbooks" USING btree ("workspace_id","code");