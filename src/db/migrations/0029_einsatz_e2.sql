CREATE TABLE "care_assignments" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"engagement_id" text NOT NULL,
	"role" text NOT NULL,
	"user_id" text NOT NULL,
	"from_date" date NOT NULL,
	"to_date" date,
	"accepted_at" timestamp with time zone,
	"granted_by" text NOT NULL,
	"handover_work_item_id" text,
	"ended_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checkins" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"engagement_id" text NOT NULL,
	"side" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"due_date" date NOT NULL,
	"status" text DEFAULT 'FAELLIG' NOT NULL,
	"scheduled_at" timestamp with time zone,
	"held_at" timestamp with time zone,
	"participants" text,
	"note" text,
	"risks" text,
	"open_points" text,
	"next_step" text,
	"sales_hint" text,
	"sales_signal_id" text,
	"rule_key" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contract_documents" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"account_id" text NOT NULL,
	"side" text NOT NULL,
	"doc_type" text NOT NULL,
	"title" text NOT NULL,
	"version_label" text,
	"valid_from" date,
	"valid_to" date,
	"signed_status" text DEFAULT 'ENTWURF' NOT NULL,
	"source_id" text,
	"link" text,
	"reference" text,
	"freelancer_id" text,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"suggestion" jsonb,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "engagement_documents" (
	"engagement_id" text NOT NULL,
	"document_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "engagement_documents_engagement_id_document_id_pk" PRIMARY KEY("engagement_id","document_id")
);
--> statement-breakpoint
CREATE TABLE "engagement_periods" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"engagement_id" text NOT NULL,
	"kind" text DEFAULT 'PLAN' NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"ek" numeric(10, 2),
	"vk" numeric(10, 2),
	"currency" text DEFAULT 'EUR' NOT NULL,
	"rate_unit" text DEFAULT 'TAG' NOT NULL,
	"scope_amount" integer,
	"scope_unit" text,
	"source" text,
	"confirmed_by" text,
	"confirmed_at" timestamp with time zone,
	"superseded_by_id" text,
	"note" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "engagements" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"position_id" text NOT NULL,
	"candidacy_id" text NOT NULL,
	"freelancer_id" text NOT NULL,
	"opportunity_id" text NOT NULL,
	"account_id" text NOT NULL,
	"setup_id" text NOT NULL,
	"order_id" text,
	"title" text NOT NULL,
	"status" text DEFAULT 'VORBEREITUNG' NOT NULL,
	"status_reason" text,
	"review_date" date,
	"planned_start" date,
	"actual_start" date,
	"planned_end" date,
	"actual_end" date,
	"renewal_deadline" date,
	"notice_note" text,
	"bd_user_id" text NOT NULL,
	"procurement_exception" text,
	"procurement_exception_by" text,
	"procurement_exception_at" timestamp with time zone,
	"external_ref" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"name" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"ok" boolean,
	"error" text,
	"counts" jsonb
);
--> statement-breakpoint
CREATE TABLE "procurement_profiles" (
	"account_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"required" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"note" text,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "renewal_decisions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"engagement_id" text NOT NULL,
	"trigger_date" date,
	"status" text DEFAULT 'ZU_KLAEREN' NOT NULL,
	"proposed_from" date,
	"proposed_to" date,
	"conditions_note" text,
	"availability_note" text,
	"commercial_owner_user_id" text,
	"contract_follow_up" text,
	"result_period_id" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "care_assignments" ADD CONSTRAINT "care_assignments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_assignments" ADD CONSTRAINT "care_assignments_engagement_id_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_assignments" ADD CONSTRAINT "care_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_assignments" ADD CONSTRAINT "care_assignments_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_assignments" ADD CONSTRAINT "care_assignments_handover_work_item_id_work_items_id_fk" FOREIGN KEY ("handover_work_item_id") REFERENCES "public"."work_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkins" ADD CONSTRAINT "checkins_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkins" ADD CONSTRAINT "checkins_engagement_id_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkins" ADD CONSTRAINT "checkins_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkins" ADD CONSTRAINT "checkins_sales_signal_id_signals_id_fk" FOREIGN KEY ("sales_signal_id") REFERENCES "public"."signals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkins" ADD CONSTRAINT "checkins_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_documents" ADD CONSTRAINT "contract_documents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_documents" ADD CONSTRAINT "contract_documents_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_documents" ADD CONSTRAINT "contract_documents_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_documents" ADD CONSTRAINT "contract_documents_freelancer_id_freelancers_id_fk" FOREIGN KEY ("freelancer_id") REFERENCES "public"."freelancers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_documents" ADD CONSTRAINT "contract_documents_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_documents" ADD CONSTRAINT "contract_documents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_documents" ADD CONSTRAINT "engagement_documents_engagement_id_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_documents" ADD CONSTRAINT "engagement_documents_document_id_contract_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."contract_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_periods" ADD CONSTRAINT "engagement_periods_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_periods" ADD CONSTRAINT "engagement_periods_engagement_id_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_periods" ADD CONSTRAINT "engagement_periods_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_periods" ADD CONSTRAINT "engagement_periods_superseded_by_id_engagement_periods_id_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."engagement_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_periods" ADD CONSTRAINT "engagement_periods_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagements" ADD CONSTRAINT "engagements_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagements" ADD CONSTRAINT "engagements_position_id_staffing_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."staffing_positions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagements" ADD CONSTRAINT "engagements_candidacy_id_candidacies_id_fk" FOREIGN KEY ("candidacy_id") REFERENCES "public"."candidacies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagements" ADD CONSTRAINT "engagements_freelancer_id_freelancers_id_fk" FOREIGN KEY ("freelancer_id") REFERENCES "public"."freelancers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagements" ADD CONSTRAINT "engagements_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagements" ADD CONSTRAINT "engagements_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagements" ADD CONSTRAINT "engagements_setup_id_project_setups_id_fk" FOREIGN KEY ("setup_id") REFERENCES "public"."project_setups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagements" ADD CONSTRAINT "engagements_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagements" ADD CONSTRAINT "engagements_bd_user_id_users_id_fk" FOREIGN KEY ("bd_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagements" ADD CONSTRAINT "engagements_procurement_exception_by_users_id_fk" FOREIGN KEY ("procurement_exception_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagements" ADD CONSTRAINT "engagements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_profiles" ADD CONSTRAINT "procurement_profiles_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_profiles" ADD CONSTRAINT "procurement_profiles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_profiles" ADD CONSTRAINT "procurement_profiles_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renewal_decisions" ADD CONSTRAINT "renewal_decisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renewal_decisions" ADD CONSTRAINT "renewal_decisions_engagement_id_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renewal_decisions" ADD CONSTRAINT "renewal_decisions_commercial_owner_user_id_users_id_fk" FOREIGN KEY ("commercial_owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renewal_decisions" ADD CONSTRAINT "renewal_decisions_result_period_id_engagement_periods_id_fk" FOREIGN KEY ("result_period_id") REFERENCES "public"."engagement_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renewal_decisions" ADD CONSTRAINT "renewal_decisions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renewal_decisions" ADD CONSTRAINT "renewal_decisions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "care_assignments_eng_idx" ON "care_assignments" USING btree ("engagement_id");--> statement-breakpoint
CREATE INDEX "care_assignments_user_idx" ON "care_assignments" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "care_assignments_primary_uq" ON "care_assignments" USING btree ("engagement_id","role") WHERE to_date IS NULL;--> statement-breakpoint
CREATE INDEX "checkins_eng_idx" ON "checkins" USING btree ("engagement_id");--> statement-breakpoint
CREATE INDEX "checkins_owner_idx" ON "checkins" USING btree ("owner_user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "checkins_rule_uq" ON "checkins" USING btree ("rule_key");--> statement-breakpoint
CREATE INDEX "contract_documents_account_idx" ON "contract_documents" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "engagement_periods_eng_idx" ON "engagement_periods" USING btree ("engagement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "engagements_candidacy_uq" ON "engagements" USING btree ("candidacy_id");--> statement-breakpoint
CREATE INDEX "engagements_account_idx" ON "engagements" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "engagements_status_idx" ON "engagements" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "job_runs_name_idx" ON "job_runs" USING btree ("name","started_at");--> statement-breakpoint
CREATE INDEX "renewal_decisions_eng_idx" ON "renewal_decisions" USING btree ("engagement_id");