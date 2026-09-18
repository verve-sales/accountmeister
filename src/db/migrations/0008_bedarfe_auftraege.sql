CREATE TYPE "public"."decision_role" AS ENUM('BEDARFSTRAEGER', 'FACHLICHE_BEWERTUNG', 'BUDGETVERANTWORTUNG', 'EINKAUF_VERTRAGSWEG', 'ZUSAETZLICHE_FREIGABE', 'UNTERSTUETZER_SPONSOR');--> statement-breakpoint
CREATE TYPE "public"."engagement_status" AS ENUM('GEPLANT', 'STARTBEREIT', 'GESTARTET', 'BEENDET');--> statement-breakpoint
CREATE TYPE "public"."offer_status" AS ENUM('ENTWURF', 'GEPRUEFT', 'VORGESTELLT', 'RUECKMELDUNG_OFFEN', 'AKZEPTIERT', 'ABGELEHNT', 'ZURUECKGEZOGEN');--> statement-breakpoint
CREATE TYPE "public"."opportunity_status" AS ENUM('IN_KLAERUNG', 'BESTAETIGT', 'PROFIL_ANGEBOT_VORGESTELLT', 'AUSWAHL_BESTELLUNG', 'BEAUFTRAGT', 'ZURUECKGESTELLT', 'BEENDET');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('IN_VORBEREITUNG', 'NACHWEISE_UNVOLLSTAENDIG', 'BEAUFTRAGUNG_BESTAETIGT', 'BEENDET_STORNIERT');--> statement-breakpoint
CREATE TYPE "public"."requirement_status" AS ENUM('OFFEN', 'NACHWEIS_VORGELEGT', 'BESTAETIGT', 'NICHT_ANWENDBAR');--> statement-breakpoint
CREATE TABLE "candidate_profile_references" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"label" text NOT NULL,
	"source_ref" text,
	"availability_note" text,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decision_participations" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"opportunity_id" text NOT NULL,
	"role" "decision_role" NOT NULL,
	"person_id" text,
	"epistemic_status" "epistemic_status" DEFAULT 'HYPOTHESE' NOT NULL,
	"evidence_source_id" text,
	"note" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offers" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"opportunity_id" text NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"artifact_version_id" text,
	"profile_reference_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "offer_status" DEFAULT 'ENTWURF' NOT NULL,
	"version_no" integer DEFAULT 1 NOT NULL,
	"presented_at" timestamp with time zone,
	"presented_to" text,
	"presented_source_id" text,
	"feedback_note" text,
	"status_reason" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunities" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"account_id" text NOT NULL,
	"setup_id" text NOT NULL,
	"title" text NOT NULL,
	"need_description" text NOT NULL,
	"trigger" text,
	"status" "opportunity_status" DEFAULT 'IN_KLAERUNG' NOT NULL,
	"owner_user_id" text NOT NULL,
	"fast_track" boolean DEFAULT false NOT NULL,
	"requested_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"confirmed_source_id" text,
	"confirmed_note" text,
	"meddpicc" jsonb,
	"signal_id" text,
	"status_reason" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"opportunity_id" text NOT NULL,
	"offer_id" text,
	"order_reference" text,
	"evidence_source_id" text,
	"evidence_note" text,
	"planned_start" date,
	"planned_end" date,
	"status" "order_status" DEFAULT 'IN_VORBEREITUNG' NOT NULL,
	"confirmed_at" timestamp with time zone,
	"confirmed_by" text,
	"engagement_status" "engagement_status" DEFAULT 'GEPLANT' NOT NULL,
	"started_at" timestamp with time zone,
	"status_reason" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "start_requirements" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"order_id" text NOT NULL,
	"requirement" text NOT NULL,
	"policy_ref" text,
	"checked_by" text,
	"evidence_source_id" text,
	"evidence_note" text,
	"status" "requirement_status" DEFAULT 'OFFEN' NOT NULL,
	"confirmed_by" text,
	"confirmed_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "candidate_profile_references" ADD CONSTRAINT "candidate_profile_references_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_profile_references" ADD CONSTRAINT "candidate_profile_references_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_profile_references" ADD CONSTRAINT "candidate_profile_references_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_participations" ADD CONSTRAINT "decision_participations_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_participations" ADD CONSTRAINT "decision_participations_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_participations" ADD CONSTRAINT "decision_participations_evidence_source_id_sources_id_fk" FOREIGN KEY ("evidence_source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_participations" ADD CONSTRAINT "decision_participations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_artifact_version_id_artifact_versions_id_fk" FOREIGN KEY ("artifact_version_id") REFERENCES "public"."artifact_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_presented_source_id_sources_id_fk" FOREIGN KEY ("presented_source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_setup_id_project_setups_id_fk" FOREIGN KEY ("setup_id") REFERENCES "public"."project_setups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_confirmed_source_id_sources_id_fk" FOREIGN KEY ("confirmed_source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_evidence_source_id_sources_id_fk" FOREIGN KEY ("evidence_source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "start_requirements" ADD CONSTRAINT "start_requirements_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "start_requirements" ADD CONSTRAINT "start_requirements_evidence_source_id_sources_id_fk" FOREIGN KEY ("evidence_source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "start_requirements" ADD CONSTRAINT "start_requirements_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "start_requirements" ADD CONSTRAINT "start_requirements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "decision_participations_opp_idx" ON "decision_participations" USING btree ("opportunity_id");--> statement-breakpoint
CREATE INDEX "offers_opp_idx" ON "offers" USING btree ("opportunity_id");--> statement-breakpoint
CREATE INDEX "opportunities_setup_idx" ON "opportunities" USING btree ("setup_id");--> statement-breakpoint
CREATE INDEX "opportunities_account_idx" ON "opportunities" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "orders_opp_idx" ON "orders" USING btree ("opportunity_id");--> statement-breakpoint
CREATE INDEX "start_requirements_order_idx" ON "start_requirements" USING btree ("order_id");