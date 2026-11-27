CREATE TABLE "kpi_snapshots" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"day" date NOT NULL,
	"values" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kpi_snapshots" ADD CONSTRAINT "kpi_snapshots_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "kpi_snapshots_day_uq" ON "kpi_snapshots" USING btree ("workspace_id","day");