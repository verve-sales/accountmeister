CREATE TYPE "public"."artifact_status" AS ENUM('ENTWURF', 'GEPRUEFT', 'FREIGEGEBEN', 'UEBERHOLT');--> statement-breakpoint
CREATE TYPE "public"."artifact_variant" AS ENUM('INTERN', 'EXTERN');--> statement-breakpoint
CREATE TABLE "artifact_templates" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"responsible" text NOT NULL,
	"trigger" text NOT NULL,
	"scope_type" text NOT NULL,
	"implementation" text NOT NULL,
	"view_path" text,
	"quality_criterion" text NOT NULL,
	"external_variant_allowed" boolean DEFAULT false NOT NULL,
	"sections" jsonb NOT NULL,
	"registry_version" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifact_versions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"artifact_key" text NOT NULL,
	"version_no" integer DEFAULT 1 NOT NULL,
	"template_code" text NOT NULL,
	"template_version" integer NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" text NOT NULL,
	"setup_id" text,
	"account_id" text,
	"title" text NOT NULL,
	"variant" "artifact_variant" DEFAULT 'INTERN' NOT NULL,
	"content" jsonb NOT NULL,
	"source_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"audience" "access_class" DEFAULT 'SETUP' NOT NULL,
	"status" "artifact_status" DEFAULT 'ENTWURF' NOT NULL,
	"supersedes_id" text,
	"created_by" text NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_template_code_artifact_templates_code_fk" FOREIGN KEY ("template_code") REFERENCES "public"."artifact_templates"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_setup_id_project_setups_id_fk" FOREIGN KEY ("setup_id") REFERENCES "public"."project_setups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifact_versions_key_idx" ON "artifact_versions" USING btree ("artifact_key");--> statement-breakpoint
CREATE INDEX "artifact_versions_setup_idx" ON "artifact_versions" USING btree ("setup_id");--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_versions_key_no_uq" ON "artifact_versions" USING btree ("artifact_key","version_no");