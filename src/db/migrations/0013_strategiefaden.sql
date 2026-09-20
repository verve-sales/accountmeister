CREATE TABLE "strategy_threads" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"setup_id" text NOT NULL,
	"version_no" integer NOT NULL,
	"summary" text NOT NULL,
	"next_step" text NOT NULL,
	"moves" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"risks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"open_questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"basis" text NOT NULL,
	"stage" text NOT NULL,
	"note" text,
	"ai_job_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "strategy_threads" ADD CONSTRAINT "strategy_threads_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_threads" ADD CONSTRAINT "strategy_threads_setup_id_project_setups_id_fk" FOREIGN KEY ("setup_id") REFERENCES "public"."project_setups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_threads" ADD CONSTRAINT "strategy_threads_ai_job_id_ai_jobs_id_fk" FOREIGN KEY ("ai_job_id") REFERENCES "public"."ai_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_threads" ADD CONSTRAINT "strategy_threads_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "strategy_threads_version_uq" ON "strategy_threads" USING btree ("setup_id","version_no");--> statement-breakpoint
CREATE INDEX "strategy_threads_setup_idx" ON "strategy_threads" USING btree ("setup_id");