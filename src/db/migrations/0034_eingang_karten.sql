ALTER TYPE "public"."suggestion_type" ADD VALUE 'KARTE';--> statement-breakpoint
ALTER TABLE "suggestions" ALTER COLUMN "setup_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "suggestions" ADD COLUMN "account_id" text;--> statement-breakpoint
ALTER TABLE "suggestions" ADD COLUMN "payload" jsonb;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;