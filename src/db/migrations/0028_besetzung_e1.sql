CREATE TABLE "candidacies" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"position_id" text NOT NULL,
	"freelancer_id" text NOT NULL,
	"handler_user_id" text NOT NULL,
	"status" text DEFAULT 'IDENTIFIZIERT' NOT NULL,
	"status_reason" text,
	"available_from" date,
	"available_to" date,
	"ek_rate" numeric(10, 2),
	"ek_as_of" date,
	"ek_note" text,
	"vk_rate" numeric(10, 2),
	"rate_unit" text DEFAULT 'TAG' NOT NULL,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"origin_ref" text,
	"notes" text,
	"next_step" text,
	"next_step_due" date,
	"presentation_approved_by" text,
	"presentation_approved_at" timestamp with time zone,
	"selected_by" text,
	"selected_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "candidacy_events" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"candidacy_id" text NOT NULL,
	"kind" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"recipient_person_id" text,
	"recipient_text" text,
	"profile_ref" text,
	"profile_hash" text,
	"summary" text,
	"release_scope" text,
	"release_confirmed_by" text,
	"release_as_of" date,
	"price_presented" numeric(10, 2),
	"price_unit" text,
	"communication_ref" text,
	"interview_status" text,
	"interview_at" timestamp with time zone,
	"participants" text,
	"outcome" text,
	"from_status" text,
	"to_status" text,
	"reason" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "freelancers" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"display_name" text NOT NULL,
	"email" text,
	"phone" text,
	"company" text,
	"skills" text,
	"availability_note" text,
	"availability_as_of" date,
	"availability_source" text,
	"external_cv_ref" text,
	"external_tool_ref" text,
	"merged_into_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staffing_intakes" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"opportunity_id" text NOT NULL,
	"source_id" text NOT NULL,
	"proposal" jsonb NOT NULL,
	"status" text DEFAULT 'OFFEN' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "staffing_positions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"opportunity_id" text NOT NULL,
	"account_id" text NOT NULL,
	"setup_id" text NOT NULL,
	"title" text NOT NULL,
	"role_id" text,
	"tasks" text,
	"must_have" text,
	"nice_to_have" text,
	"location" text,
	"language" text,
	"desired_start" date,
	"planned_end" date,
	"end_open" boolean DEFAULT false NOT NULL,
	"scope_amount" integer,
	"scope_unit" text,
	"proposal_due" date,
	"bd_user_id" text NOT NULL,
	"status" text DEFAULT 'ENTWURF' NOT NULL,
	"status_reason" text,
	"hold_review_date" date,
	"internal_notes" text,
	"ek_min" numeric(10, 2),
	"ek_max" numeric(10, 2),
	"vk_min" numeric(10, 2),
	"vk_max" numeric(10, 2),
	"currency" text DEFAULT 'EUR' NOT NULL,
	"rate_unit" text DEFAULT 'TAG' NOT NULL,
	"ad_draft" jsonb,
	"ad_status" text DEFAULT 'KEIN' NOT NULL,
	"ad_approved_by" text,
	"ad_approved_at" timestamp with time zone,
	"source_id" text,
	"copied_from_id" text,
	"replaces_position_id" text,
	"filled_candidacy_id" text,
	"filled_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "resume_status" text;--> statement-breakpoint
ALTER TABLE "candidacies" ADD CONSTRAINT "candidacies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidacies" ADD CONSTRAINT "candidacies_position_id_staffing_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."staffing_positions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidacies" ADD CONSTRAINT "candidacies_freelancer_id_freelancers_id_fk" FOREIGN KEY ("freelancer_id") REFERENCES "public"."freelancers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidacies" ADD CONSTRAINT "candidacies_handler_user_id_users_id_fk" FOREIGN KEY ("handler_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidacies" ADD CONSTRAINT "candidacies_presentation_approved_by_users_id_fk" FOREIGN KEY ("presentation_approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidacies" ADD CONSTRAINT "candidacies_selected_by_users_id_fk" FOREIGN KEY ("selected_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidacies" ADD CONSTRAINT "candidacies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidacy_events" ADD CONSTRAINT "candidacy_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidacy_events" ADD CONSTRAINT "candidacy_events_candidacy_id_candidacies_id_fk" FOREIGN KEY ("candidacy_id") REFERENCES "public"."candidacies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidacy_events" ADD CONSTRAINT "candidacy_events_recipient_person_id_persons_id_fk" FOREIGN KEY ("recipient_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidacy_events" ADD CONSTRAINT "candidacy_events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "freelancers" ADD CONSTRAINT "freelancers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "freelancers" ADD CONSTRAINT "freelancers_merged_into_id_freelancers_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."freelancers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "freelancers" ADD CONSTRAINT "freelancers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staffing_intakes" ADD CONSTRAINT "staffing_intakes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staffing_intakes" ADD CONSTRAINT "staffing_intakes_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staffing_intakes" ADD CONSTRAINT "staffing_intakes_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staffing_intakes" ADD CONSTRAINT "staffing_intakes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staffing_positions" ADD CONSTRAINT "staffing_positions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staffing_positions" ADD CONSTRAINT "staffing_positions_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staffing_positions" ADD CONSTRAINT "staffing_positions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staffing_positions" ADD CONSTRAINT "staffing_positions_setup_id_project_setups_id_fk" FOREIGN KEY ("setup_id") REFERENCES "public"."project_setups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staffing_positions" ADD CONSTRAINT "staffing_positions_role_id_standard_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."standard_roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staffing_positions" ADD CONSTRAINT "staffing_positions_bd_user_id_users_id_fk" FOREIGN KEY ("bd_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staffing_positions" ADD CONSTRAINT "staffing_positions_ad_approved_by_users_id_fk" FOREIGN KEY ("ad_approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staffing_positions" ADD CONSTRAINT "staffing_positions_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staffing_positions" ADD CONSTRAINT "staffing_positions_copied_from_id_staffing_positions_id_fk" FOREIGN KEY ("copied_from_id") REFERENCES "public"."staffing_positions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staffing_positions" ADD CONSTRAINT "staffing_positions_replaces_position_id_staffing_positions_id_fk" FOREIGN KEY ("replaces_position_id") REFERENCES "public"."staffing_positions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staffing_positions" ADD CONSTRAINT "staffing_positions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "candidacies_position_idx" ON "candidacies" USING btree ("position_id");--> statement-breakpoint
CREATE INDEX "candidacies_freelancer_idx" ON "candidacies" USING btree ("freelancer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "candidacies_active_uq" ON "candidacies" USING btree ("position_id","freelancer_id") WHERE is_active = true;--> statement-breakpoint
CREATE INDEX "candidacy_events_candidacy_idx" ON "candidacy_events" USING btree ("candidacy_id");--> statement-breakpoint
CREATE INDEX "freelancers_name_idx" ON "freelancers" USING btree ("workspace_id","display_name");--> statement-breakpoint
CREATE INDEX "staffing_intakes_opp_idx" ON "staffing_intakes" USING btree ("opportunity_id");--> statement-breakpoint
CREATE INDEX "staffing_positions_opp_idx" ON "staffing_positions" USING btree ("opportunity_id");--> statement-breakpoint
CREATE INDEX "staffing_positions_account_idx" ON "staffing_positions" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "staffing_positions_bd_idx" ON "staffing_positions" USING btree ("bd_user_id");