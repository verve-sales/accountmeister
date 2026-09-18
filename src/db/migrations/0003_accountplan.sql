CREATE TYPE "public"."priority_kind" AS ENUM('VERLAENGERN', 'AUSWEITEN', 'VERTIEFEN', 'UEBERTRAGEN');--> statement-breakpoint
CREATE TYPE "public"."priority_status" AS ENUM('VORGESCHLAGEN', 'VEREINBART', 'ZURUECKGESTELLT', 'ERREICHT', 'VERWORFEN');--> statement-breakpoint
CREATE TABLE "account_plan_snapshots" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"account_id" text NOT NULL,
	"title" text NOT NULL,
	"content" jsonb NOT NULL,
	"note" text,
	"confirmed_by" text NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_priorities" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"account_id" text NOT NULL,
	"setup_id" text,
	"kind" "priority_kind" NOT NULL,
	"title" text NOT NULL,
	"rationale" text,
	"prerequisites" text,
	"goal_reference" text,
	"rank" integer DEFAULT 100 NOT NULL,
	"status" "priority_status" DEFAULT 'VORGESCHLAGEN' NOT NULL,
	"agreed_by_user_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"deferred_reason" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_plan_snapshots" ADD CONSTRAINT "account_plan_snapshots_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_plan_snapshots" ADD CONSTRAINT "account_plan_snapshots_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_plan_snapshots" ADD CONSTRAINT "account_plan_snapshots_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_priorities" ADD CONSTRAINT "account_priorities_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_priorities" ADD CONSTRAINT "account_priorities_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_priorities" ADD CONSTRAINT "account_priorities_setup_id_project_setups_id_fk" FOREIGN KEY ("setup_id") REFERENCES "public"."project_setups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_priorities" ADD CONSTRAINT "account_priorities_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_plan_snapshots_account_idx" ON "account_plan_snapshots" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "account_priorities_account_idx" ON "account_priorities" USING btree ("account_id");