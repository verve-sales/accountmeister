CREATE TABLE "order_case_documents" (
	"case_id" text NOT NULL,
	"document_id" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_case_documents_case_id_document_id_pk" PRIMARY KEY("case_id","document_id")
);
--> statement-breakpoint
CREATE TABLE "order_cases" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"number" text NOT NULL,
	"channel" text DEFAULT 'DIREKT' NOT NULL,
	"status" text DEFAULT 'ENTWURF' NOT NULL,
	"partner_account_id" text,
	"end_customer_account_id" text,
	"end_customer_hint" text,
	"person_name" text,
	"freelancer_id" text,
	"internal_user_id" text,
	"role" text,
	"start_date" date,
	"end_date" date,
	"daily_rate" numeric(10, 2),
	"days" integer,
	"offer_number" text,
	"broker_ref" text,
	"order_number" text,
	"is_renewal" boolean DEFAULT false NOT NULL,
	"opportunity_id" text,
	"offer_id" text,
	"order_id" text,
	"engagement_id" text,
	"parsed" jsonb,
	"systems" jsonb,
	"status_reason" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "order_case_documents" ADD CONSTRAINT "order_case_documents_case_id_order_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."order_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_case_documents" ADD CONSTRAINT "order_case_documents_document_id_contract_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."contract_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_cases" ADD CONSTRAINT "order_cases_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_cases" ADD CONSTRAINT "order_cases_partner_account_id_accounts_id_fk" FOREIGN KEY ("partner_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_cases" ADD CONSTRAINT "order_cases_end_customer_account_id_accounts_id_fk" FOREIGN KEY ("end_customer_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_cases" ADD CONSTRAINT "order_cases_freelancer_id_freelancers_id_fk" FOREIGN KEY ("freelancer_id") REFERENCES "public"."freelancers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_cases" ADD CONSTRAINT "order_cases_internal_user_id_users_id_fk" FOREIGN KEY ("internal_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_cases" ADD CONSTRAINT "order_cases_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_cases" ADD CONSTRAINT "order_cases_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_cases" ADD CONSTRAINT "order_cases_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_cases" ADD CONSTRAINT "order_cases_engagement_id_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_cases" ADD CONSTRAINT "order_cases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "order_cases_number_uq" ON "order_cases" USING btree ("workspace_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "order_cases_order_uq" ON "order_cases" USING btree ("workspace_id","partner_account_id","order_number") WHERE order_number IS NOT NULL AND status <> 'STORNIERT';--> statement-breakpoint
CREATE INDEX "order_cases_status_idx" ON "order_cases" USING btree ("workspace_id","status");