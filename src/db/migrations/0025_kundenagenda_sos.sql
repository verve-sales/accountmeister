CREATE TABLE "account_initiatives" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"account_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"due_date" date,
	"due_hint" text,
	"status" text DEFAULT 'OFFEN' NOT NULL,
	"source_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sos_reports" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"account_id" text NOT NULL,
	"setup_id" text,
	"order_id" text,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"situation" text NOT NULL,
	"need" text,
	"urgency" text DEFAULT 'HOCH' NOT NULL,
	"status" text DEFAULT 'OFFEN' NOT NULL,
	"owner_user_id" text,
	"resolution" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "procurement_channel" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "intermediary_name" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "procurement_note" text;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "initiative_id" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "consultant_user_id" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "consultant_name" text;--> statement-breakpoint
ALTER TABLE "account_initiatives" ADD CONSTRAINT "account_initiatives_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_initiatives" ADD CONSTRAINT "account_initiatives_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_initiatives" ADD CONSTRAINT "account_initiatives_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_initiatives" ADD CONSTRAINT "account_initiatives_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sos_reports" ADD CONSTRAINT "sos_reports_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sos_reports" ADD CONSTRAINT "sos_reports_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sos_reports" ADD CONSTRAINT "sos_reports_setup_id_project_setups_id_fk" FOREIGN KEY ("setup_id") REFERENCES "public"."project_setups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sos_reports" ADD CONSTRAINT "sos_reports_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sos_reports" ADD CONSTRAINT "sos_reports_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sos_reports" ADD CONSTRAINT "sos_reports_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_initiatives_account_idx" ON "account_initiatives" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "sos_reports_account_idx" ON "sos_reports" USING btree ("account_id");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_consultant_user_id_users_id_fk" FOREIGN KEY ("consultant_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;