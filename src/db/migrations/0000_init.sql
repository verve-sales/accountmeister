CREATE TYPE "public"."access_class" AS ENUM('PERSOENLICH', 'SETUP', 'ACCOUNT_TEAM', 'WORKSPACE');--> statement-breakpoint
CREATE TYPE "public"."account_status" AS ENUM('ACTIVE', 'DORMANT', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."action_status" AS ENUM('VORGESCHLAGEN', 'ANGENOMMEN', 'IN_ARBEIT', 'BLOCKIERT', 'ERLEDIGT', 'VERWORFEN');--> statement-breakpoint
CREATE TYPE "public"."epistemic_status" AS ENUM('UNGEPRUEFT_EXTRAHIERT', 'AUSSAGE_WIEDERGEGEBEN', 'SACHVERHALT_BESTAETIGT', 'HYPOTHESE', 'WIDERSPRUECHLICH', 'UEBERHOLT');--> statement-breakpoint
CREATE TYPE "public"."handover_status" AS ENUM('ENTWURF', 'ANGEFRAGT', 'ANGENOMMEN', 'ZURUECKGEGEBEN', 'ABGESCHLOSSEN');--> statement-breakpoint
CREATE TYPE "public"."handover_subject" AS ENUM('SIGNAL', 'SETUP', 'AKTION');--> statement-breakpoint
CREATE TYPE "public"."membership_contribution" AS ENUM('ANKER_KONTEXT', 'ANKER_RUECKFRAGEN', 'ANKER_EINFUEHRUNG', 'BD_ZUSTAENDIG', 'BEOBACHTER');--> statement-breakpoint
CREATE TYPE "public"."org_type" AS ENUM('KONZERN', 'TOCHTERGESELLSCHAFT', 'EINZELUNTERNEHMEN', 'OEFFENTLICH', 'SONSTIGE');--> statement-breakpoint
CREATE TYPE "public"."relationship_state" AS ENUM('NAME_FUNKTION_BEKANNT', 'VORSTELLUNG_ANGEFRAGT', 'VORGESTELLT', 'IM_AUSTAUSCH', 'KONKRETE_ZUSAMMENARBEIT', 'NICHT_AKTIV');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('ANKER', 'BD', 'PRINCIPAL', 'CEO', 'ADMIN');--> statement-breakpoint
CREATE TYPE "public"."role_scope" AS ENUM('WORKSPACE', 'ACCOUNT');--> statement-breakpoint
CREATE TYPE "public"."setup_status" AS ENUM('ENTWURF', 'AKTIV', 'RUHEND', 'ARCHIVIERT');--> statement-breakpoint
CREATE TYPE "public"."setup_visibility" AS ENUM('MITGLIEDER', 'ACCOUNT_TEAM', 'WORKSPACE');--> statement-breakpoint
CREATE TYPE "public"."signal_status" AS ENUM('NEU', 'PRUEFUNG_UEBERNOMMEN', 'IN_KLAERUNG', 'MIT_BEDARF_VERKNUEPFT', 'ZURUECKGESTELLT', 'BEENDET');--> statement-breakpoint
CREATE TYPE "public"."source_type" AS ENUM('NOTIZ', 'PROTOKOLL', 'EMAIL', 'TERMIN', 'OEFFENTLICH');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('ACTIVE', 'INACTIVE');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"org_type" "org_type" DEFAULT 'SONSTIGE' NOT NULL,
	"parent_account_id" text,
	"status" "account_status" DEFAULT 'ACTIVE' NOT NULL,
	"responsible_bd_user_id" text,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "actions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"setup_id" text,
	"signal_id" text,
	"title" text NOT NULL,
	"agreement" text,
	"owner_user_id" text NOT NULL,
	"status" "action_status" DEFAULT 'VORGESCHLAGEN' NOT NULL,
	"due_date" date,
	"result" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assertion_evidence" (
	"assertion_id" text NOT NULL,
	"source_id" text NOT NULL,
	"excerpt" text,
	"evidence_kind" text DEFAULT 'BELEG' NOT NULL,
	CONSTRAINT "assertion_evidence_assertion_id_source_id_pk" PRIMARY KEY("assertion_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "assertions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"setup_id" text,
	"subject_type" text NOT NULL,
	"subject_id" text,
	"content" text NOT NULL,
	"epistemic_status" "epistemic_status" DEFAULT 'UNGEPRUEFT_EXTRAHIERT' NOT NULL,
	"valid_from" date,
	"valid_to" date,
	"confirmed_by" text,
	"confirmed_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"actor_user_id" text,
	"action" text NOT NULL,
	"object_type" text NOT NULL,
	"object_id" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"changes" jsonb
);
--> statement-breakpoint
CREATE TABLE "handovers" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"setup_id" text,
	"subject_type" "handover_subject" NOT NULL,
	"subject_id" text NOT NULL,
	"sender_user_id" text NOT NULL,
	"receiver_user_id" text NOT NULL,
	"context" text NOT NULL,
	"proven" text,
	"open" text,
	"allowed_use" text,
	"responsibility" text NOT NULL,
	"next_step" text,
	"due_date" date,
	"feedback_channel" text,
	"status" "handover_status" DEFAULT 'ANGEFRAGT' NOT NULL,
	"response_note" text,
	"responded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_units" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"account_id" text NOT NULL,
	"parent_org_unit_id" text,
	"name" text NOT NULL,
	"valid_from" date,
	"valid_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "person_functions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"person_id" text NOT NULL,
	"org_unit_id" text,
	"function_title" text NOT NULL,
	"known_responsibility" text,
	"valid_from" date,
	"valid_to" date,
	"source_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "persons" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"account_id" text,
	"display_name" text NOT NULL,
	"email" text,
	"phone" text,
	"access_class" "access_class" DEFAULT 'ACCOUNT_TEAM' NOT NULL,
	"retention_note" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_setups" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"account_id" text NOT NULL,
	"name" text NOT NULL,
	"context_note" text,
	"status" "setup_status" DEFAULT 'ENTWURF' NOT NULL,
	"visibility" "setup_visibility" DEFAULT 'MITGLIEDER' NOT NULL,
	"bd_user_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relationships" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"person_id" text NOT NULL,
	"holder_user_id" text NOT NULL,
	"setup_id" text,
	"state" "relationship_state" DEFAULT 'NAME_FUNKTION_BEKANNT' NOT NULL,
	"context_note" text,
	"evidence_source_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_assignments" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" "role" NOT NULL,
	"scope" "role_scope" DEFAULT 'WORKSPACE' NOT NULL,
	"account_id" text,
	"valid_from" date DEFAULT now() NOT NULL,
	"valid_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "setup_memberships" (
	"setup_id" text NOT NULL,
	"user_id" text NOT NULL,
	"contribution" "membership_contribution" NOT NULL,
	"contribution_note" text,
	"can_edit" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "setup_memberships_setup_id_user_id_pk" PRIMARY KEY("setup_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"setup_id" text NOT NULL,
	"observation" text NOT NULL,
	"relevance_hypothesis" text,
	"usage_limit" text,
	"status" "signal_status" DEFAULT 'NEU' NOT NULL,
	"owner_user_id" text,
	"source_id" text,
	"closed_reason" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"setup_id" text,
	"type" "source_type" NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"origin" text,
	"external_key" text,
	"source_time" timestamp with time zone,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"owner_user_id" text NOT NULL,
	"access_class" "access_class" DEFAULT 'SETUP' NOT NULL,
	"is_locked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"status" "user_status" DEFAULT 'ACTIVE' NOT NULL,
	"timezone" text DEFAULT 'Europe/Berlin' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"name" text NOT NULL,
	"policy_version" text DEFAULT 'pilot-0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_parent_account_id_accounts_id_fk" FOREIGN KEY ("parent_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_responsible_bd_user_id_users_id_fk" FOREIGN KEY ("responsible_bd_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_setup_id_project_setups_id_fk" FOREIGN KEY ("setup_id") REFERENCES "public"."project_setups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assertion_evidence" ADD CONSTRAINT "assertion_evidence_assertion_id_assertions_id_fk" FOREIGN KEY ("assertion_id") REFERENCES "public"."assertions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assertion_evidence" ADD CONSTRAINT "assertion_evidence_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assertions" ADD CONSTRAINT "assertions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assertions" ADD CONSTRAINT "assertions_setup_id_project_setups_id_fk" FOREIGN KEY ("setup_id") REFERENCES "public"."project_setups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assertions" ADD CONSTRAINT "assertions_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assertions" ADD CONSTRAINT "assertions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handovers" ADD CONSTRAINT "handovers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handovers" ADD CONSTRAINT "handovers_setup_id_project_setups_id_fk" FOREIGN KEY ("setup_id") REFERENCES "public"."project_setups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handovers" ADD CONSTRAINT "handovers_sender_user_id_users_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handovers" ADD CONSTRAINT "handovers_receiver_user_id_users_id_fk" FOREIGN KEY ("receiver_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_units" ADD CONSTRAINT "org_units_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_units" ADD CONSTRAINT "org_units_parent_org_unit_id_org_units_id_fk" FOREIGN KEY ("parent_org_unit_id") REFERENCES "public"."org_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_functions" ADD CONSTRAINT "person_functions_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_functions" ADD CONSTRAINT "person_functions_org_unit_id_org_units_id_fk" FOREIGN KEY ("org_unit_id") REFERENCES "public"."org_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_functions" ADD CONSTRAINT "person_functions_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persons" ADD CONSTRAINT "persons_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persons" ADD CONSTRAINT "persons_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persons" ADD CONSTRAINT "persons_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_setups" ADD CONSTRAINT "project_setups_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_setups" ADD CONSTRAINT "project_setups_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_setups" ADD CONSTRAINT "project_setups_bd_user_id_users_id_fk" FOREIGN KEY ("bd_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_setups" ADD CONSTRAINT "project_setups_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_holder_user_id_users_id_fk" FOREIGN KEY ("holder_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_setup_id_project_setups_id_fk" FOREIGN KEY ("setup_id") REFERENCES "public"."project_setups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_evidence_source_id_sources_id_fk" FOREIGN KEY ("evidence_source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setup_memberships" ADD CONSTRAINT "setup_memberships_setup_id_project_setups_id_fk" FOREIGN KEY ("setup_id") REFERENCES "public"."project_setups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setup_memberships" ADD CONSTRAINT "setup_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_setup_id_project_setups_id_fk" FOREIGN KEY ("setup_id") REFERENCES "public"."project_setups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_setup_id_project_setups_id_fk" FOREIGN KEY ("setup_id") REFERENCES "public"."project_setups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "actions_owner_idx" ON "actions" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "actions_setup_idx" ON "actions" USING btree ("setup_id");--> statement-breakpoint
CREATE INDEX "assertions_setup_idx" ON "assertions" USING btree ("setup_id");--> statement-breakpoint
CREATE INDEX "audit_events_object_idx" ON "audit_events" USING btree ("object_type","object_id");--> statement-breakpoint
CREATE INDEX "handovers_receiver_idx" ON "handovers" USING btree ("receiver_user_id");--> statement-breakpoint
CREATE INDEX "handovers_subject_idx" ON "handovers" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "project_setups_account_idx" ON "project_setups" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "role_assignments_user_idx" ON "role_assignments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "signals_setup_idx" ON "signals" USING btree ("setup_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sources_external_key_uq" ON "sources" USING btree ("workspace_id","type","external_key");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree ("workspace_id","email");