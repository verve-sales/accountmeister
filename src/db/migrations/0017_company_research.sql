CREATE TABLE "company_research" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"account_id" text NOT NULL,
	"company_name" text NOT NULL,
	"facts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"note" text NOT NULL,
	"fixture_mode" boolean DEFAULT true NOT NULL,
	"fetched_by" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_research" ADD CONSTRAINT "company_research_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_research" ADD CONSTRAINT "company_research_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_research" ADD CONSTRAINT "company_research_fetched_by_users_id_fk" FOREIGN KEY ("fetched_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_research_account_uq" ON "company_research" USING btree ("account_id");