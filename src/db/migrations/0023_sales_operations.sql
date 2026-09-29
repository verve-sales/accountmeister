ALTER TYPE "public"."role" ADD VALUE 'SALES_OPS';--> statement-breakpoint
ALTER TABLE "playbook_run_steps" ADD COLUMN "assignee" text DEFAULT 'VERANTWORTLICH' NOT NULL;--> statement-breakpoint
ALTER TABLE "playbook_runs" ADD COLUMN "sales_ops_user_id" text;--> statement-breakpoint
ALTER TABLE "playbook_steps" ADD COLUMN "assignee" text DEFAULT 'VERANTWORTLICH' NOT NULL;--> statement-breakpoint
ALTER TABLE "playbook_runs" ADD CONSTRAINT "playbook_runs_sales_ops_user_id_users_id_fk" FOREIGN KEY ("sales_ops_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Standardmuster: Vorbereitungsschritte an Sales Operations (nur, wenn der Schritt noch unverändert ist)
UPDATE "playbook_steps" SET "assignee" = 'SALES_OPS' FROM "playbooks" p WHERE p."id" = "playbook_steps"."playbook_id" AND p."code" = 'ALTKUNDEN_REAKTIVIERUNG' AND "playbook_steps"."position" = 1 AND "playbook_steps"."title" = 'Lage und Anlass prüfen';--> statement-breakpoint
UPDATE "playbook_steps" SET "assignee" = 'SALES_OPS' FROM "playbooks" p WHERE p."id" = "playbook_steps"."playbook_id" AND p."code" = 'AUSSCHREIBUNG' AND "playbook_steps"."position" = 2 AND "playbook_steps"."title" = 'Bieterfragen fristgerecht stellen';--> statement-breakpoint
UPDATE "playbook_steps" SET "assignee" = 'SALES_OPS' FROM "playbooks" p WHERE p."id" = "playbook_steps"."playbook_id" AND p."code" = 'AUSSCHREIBUNG' AND "playbook_steps"."position" = 3 AND "playbook_steps"."title" = 'Profile und Angebot erstellen';
