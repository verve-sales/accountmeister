CREATE TABLE "standard_tasks" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"account_id" text,
	"action_id" text,
	"owner_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_focus" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"focus_text" text NOT NULL,
	"freelancer_lever" boolean DEFAULT true NOT NULL,
	"weekly_question" text,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "standard_tasks" ADD CONSTRAINT "standard_tasks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standard_tasks" ADD CONSTRAINT "standard_tasks_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standard_tasks" ADD CONSTRAINT "standard_tasks_action_id_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."actions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standard_tasks" ADD CONSTRAINT "standard_tasks_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_focus" ADD CONSTRAINT "workspace_focus_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_focus" ADD CONSTRAINT "workspace_focus_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "standard_tasks_key_uq" ON "standard_tasks" USING btree ("workspace_id","key");--> statement-breakpoint
CREATE INDEX "standard_tasks_owner_idx" ON "standard_tasks" USING btree ("owner_user_id");