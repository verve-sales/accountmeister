CREATE TABLE "opportunity_advice" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"opportunity_id" text NOT NULL,
	"version_no" integer NOT NULL,
	"summary" text NOT NULL,
	"next_step" text NOT NULL,
	"moves" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"risks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"open_questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"basis" text NOT NULL,
	"status" text NOT NULL,
	"note" text,
	"ai_job_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "opportunity_advice" ADD CONSTRAINT "opportunity_advice_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_advice" ADD CONSTRAINT "opportunity_advice_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_advice" ADD CONSTRAINT "opportunity_advice_ai_job_id_ai_jobs_id_fk" FOREIGN KEY ("ai_job_id") REFERENCES "public"."ai_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_advice" ADD CONSTRAINT "opportunity_advice_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "opportunity_advice_version_uq" ON "opportunity_advice" USING btree ("opportunity_id","version_no");--> statement-breakpoint
CREATE INDEX "opportunity_advice_opportunity_idx" ON "opportunity_advice" USING btree ("opportunity_id");