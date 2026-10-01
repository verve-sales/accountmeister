DROP INDEX "candidacies_active_uq";--> statement-breakpoint
ALTER TABLE "candidacies" ALTER COLUMN "freelancer_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "engagements" ALTER COLUMN "freelancer_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "candidacies" ADD COLUMN "internal_user_id" text;--> statement-breakpoint
ALTER TABLE "engagements" ADD COLUMN "internal_user_id" text;--> statement-breakpoint
ALTER TABLE "staffing_positions" ADD COLUMN "resource_kind" text DEFAULT 'FREELANCER' NOT NULL;--> statement-breakpoint
ALTER TABLE "candidacies" ADD CONSTRAINT "candidacies_internal_user_id_users_id_fk" FOREIGN KEY ("internal_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagements" ADD CONSTRAINT "engagements_internal_user_id_users_id_fk" FOREIGN KEY ("internal_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "candidacies_active_internal_uq" ON "candidacies" USING btree ("position_id","internal_user_id") WHERE is_active = true AND internal_user_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "candidacies_active_uq" ON "candidacies" USING btree ("position_id","freelancer_id") WHERE is_active = true AND freelancer_id IS NOT NULL;