ALTER TABLE "accounts" ADD COLUMN "account_kind" text DEFAULT 'KUNDE' NOT NULL;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "end_customer_note" text;