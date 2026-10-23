ALTER TYPE "public"."suggestion_type" ADD VALUE 'VERLAENGERUNG';--> statement-breakpoint
ALTER TABLE "suggestions" ADD COLUMN "mentioned_person_role" text;--> statement-breakpoint
ALTER TABLE "suggestions" ADD COLUMN "mentioned_person_unit" text;--> statement-breakpoint
ALTER TABLE "suggestions" ADD COLUMN "mentioned_person_email" text;--> statement-breakpoint
ALTER TABLE "suggestions" ADD COLUMN "proposed_date" text;--> statement-breakpoint
ALTER TABLE "suggestions" ADD COLUMN "conditions_note" text;