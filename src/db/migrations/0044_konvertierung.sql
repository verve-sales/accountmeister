CREATE TABLE "backoffice_handovers" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"engagement_id" text NOT NULL,
	"conversion_id" text,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'OFFEN' NOT NULL,
	"moco_project_id" integer,
	"ack_note" text,
	"ack_by" text,
	"ack_at" timestamp with time zone,
	"reminded_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"opportunity_id" text NOT NULL,
	"status" text DEFAULT 'LAUFEND' NOT NULL,
	"clarified_at" timestamp with time zone,
	"intermediary_checked_at" timestamp with time zone,
	"intermediary_checked_by" text,
	"intermediary_check_note" text,
	"offer_number" text,
	"offer_version" integer DEFAULT 1 NOT NULL,
	"offer_sent_at" timestamp with time zone,
	"offer_link" text,
	"commit_at" timestamp with time zone,
	"commit_note" text,
	"order_reference" text,
	"order_link" text,
	"order_at" timestamp with time zone,
	"provisional_start" boolean DEFAULT false NOT NULL,
	"ended_reason" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "freelancers" ADD COLUMN "legal_form" text DEFAULT 'PERSON' NOT NULL;--> statement-breakpoint
ALTER TABLE "freelancers" ADD COLUMN "street" text;--> statement-breakpoint
ALTER TABLE "freelancers" ADD COLUMN "postal_city" text;--> statement-breakpoint
ALTER TABLE "freelancers" ADD COLUMN "residence" text;--> statement-breakpoint
ALTER TABLE "freelancers" ADD COLUMN "tax_number" text;--> statement-breakpoint
ALTER TABLE "freelancers" ADD COLUMN "representative_name" text;--> statement-breakpoint
ALTER TABLE "freelancers" ADD COLUMN "representative_role" text;--> statement-breakpoint
ALTER TABLE "freelancers" ADD COLUMN "roles" text;--> statement-breakpoint
ALTER TABLE "freelancers" ADD COLUMN "industries" text;--> statement-breakpoint
ALTER TABLE "freelancers" ADD COLUMN "languages" text;--> statement-breakpoint
ALTER TABLE "freelancers" ADD COLUMN "certificates" text;--> statement-breakpoint
ALTER TABLE "freelancers" ADD COLUMN "available_from" date;--> statement-breakpoint
ALTER TABLE "freelancers" ADD COLUMN "capacity_note" text;--> statement-breakpoint
ALTER TABLE "freelancers" ADD COLUMN "travel_note" text;--> statement-breakpoint
ALTER TABLE "freelancers" ADD COLUMN "profile_link" text;--> statement-breakpoint
ALTER TABLE "freelancers" ADD COLUMN "ek_rate" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "freelancers" ADD COLUMN "ek_unit" text DEFAULT 'STUNDE' NOT NULL;--> statement-breakpoint
ALTER TABLE "freelancers" ADD COLUMN "payment_term_days" integer;--> statement-breakpoint
ALTER TABLE "freelancers" ADD COLUMN "invoice_note" text;--> statement-breakpoint
ALTER TABLE "project_setups" ADD COLUMN "offer_path" text DEFAULT 'MOCO' NOT NULL;--> statement-breakpoint
ALTER TABLE "backoffice_handovers" ADD CONSTRAINT "backoffice_handovers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backoffice_handovers" ADD CONSTRAINT "backoffice_handovers_engagement_id_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backoffice_handovers" ADD CONSTRAINT "backoffice_handovers_conversion_id_conversions_id_fk" FOREIGN KEY ("conversion_id") REFERENCES "public"."conversions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backoffice_handovers" ADD CONSTRAINT "backoffice_handovers_ack_by_users_id_fk" FOREIGN KEY ("ack_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backoffice_handovers" ADD CONSTRAINT "backoffice_handovers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversions" ADD CONSTRAINT "conversions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversions" ADD CONSTRAINT "conversions_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversions" ADD CONSTRAINT "conversions_intermediary_checked_by_users_id_fk" FOREIGN KEY ("intermediary_checked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversions" ADD CONSTRAINT "conversions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "backoffice_handovers_status_idx" ON "backoffice_handovers" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "backoffice_handovers_eng_idx" ON "backoffice_handovers" USING btree ("engagement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversions_running_uq" ON "conversions" USING btree ("opportunity_id") WHERE status in ('LAUFEND', 'RUHEND');--> statement-breakpoint
CREATE INDEX "conversions_ws_idx" ON "conversions" USING btree ("workspace_id","status");