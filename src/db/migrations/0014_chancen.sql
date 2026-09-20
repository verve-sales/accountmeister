CREATE TYPE "public"."chance_kind" AS ENUM('VERVE_EXPERTE', 'FREELANCER_EXPERTE', 'AUSSCHREIBUNG');--> statement-breakpoint
CREATE TYPE "public"."role_family" AS ENUM('DELIVERY_MANAGEMENT', 'AGILE_LEADERSHIP', 'BUSINESS_ANALYSE', 'SOLUTION_ARCHITEKTUR', 'TEST_QS');--> statement-breakpoint
ALTER TYPE "public"."opportunity_status" ADD VALUE 'ANTIZIPIERT' BEFORE 'IN_KLAERUNG';--> statement-breakpoint
CREATE TABLE "standard_roles" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"family" "role_family" NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "actions" ADD COLUMN "opportunity_id" text;--> statement-breakpoint
ALTER TABLE "open_questions" ADD COLUMN "opportunity_id" text;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "kind" "chance_kind" DEFAULT 'VERVE_EXPERTE' NOT NULL;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "role_id" text;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "role_family" "role_family";--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "headcount" integer;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "horizon" text;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "opportunity_id" text;--> statement-breakpoint
ALTER TABLE "suggestions" ADD COLUMN "opportunity_id" text;--> statement-breakpoint
ALTER TABLE "suggestions" ADD COLUMN "purpose" text;--> statement-breakpoint
ALTER TABLE "standard_roles" ADD CONSTRAINT "standard_roles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "standard_roles_name_uq" ON "standard_roles" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "standard_roles_family_idx" ON "standard_roles" USING btree ("workspace_id","family");--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_questions" ADD CONSTRAINT "open_questions_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_role_id_standard_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."standard_roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE no action ON UPDATE no action;