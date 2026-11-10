CREATE TABLE "moco_ignores" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"item_key" text NOT NULL,
	"label" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "engagements" ADD COLUMN "renewal_contact_person_id" text;--> statement-breakpoint
ALTER TABLE "engagements" ADD COLUMN "order_contact_person_id" text;--> statement-breakpoint
ALTER TABLE "engagements" ADD COLUMN "renewal_approach" text;--> statement-breakpoint
ALTER TABLE "project_setups" ADD COLUMN "renewal_contact_person_id" text;--> statement-breakpoint
ALTER TABLE "project_setups" ADD COLUMN "order_contact_person_id" text;--> statement-breakpoint
ALTER TABLE "project_setups" ADD COLUMN "renewal_approach" text;--> statement-breakpoint
ALTER TABLE "moco_ignores" ADD CONSTRAINT "moco_ignores_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moco_ignores" ADD CONSTRAINT "moco_ignores_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "moco_ignores_uq" ON "moco_ignores" USING btree ("workspace_id","item_key");--> statement-breakpoint
ALTER TABLE "engagements" ADD CONSTRAINT "engagements_renewal_contact_person_id_persons_id_fk" FOREIGN KEY ("renewal_contact_person_id") REFERENCES "public"."persons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagements" ADD CONSTRAINT "engagements_order_contact_person_id_persons_id_fk" FOREIGN KEY ("order_contact_person_id") REFERENCES "public"."persons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_setups" ADD CONSTRAINT "project_setups_renewal_contact_person_id_persons_id_fk" FOREIGN KEY ("renewal_contact_person_id") REFERENCES "public"."persons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_setups" ADD CONSTRAINT "project_setups_order_contact_person_id_persons_id_fk" FOREIGN KEY ("order_contact_person_id") REFERENCES "public"."persons"("id") ON DELETE set null ON UPDATE no action;