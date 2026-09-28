ALTER TABLE "playbook_run_steps" ADD COLUMN "drafts" jsonb;--> statement-breakpoint
ALTER TABLE "playbook_run_steps" ADD COLUMN "drafts_note" text;--> statement-breakpoint
ALTER TABLE "playbook_run_steps" ADD COLUMN "drafts_ai_job_id" text;--> statement-breakpoint
ALTER TABLE "playbook_run_steps" ADD COLUMN "drafts_at" timestamp with time zone;