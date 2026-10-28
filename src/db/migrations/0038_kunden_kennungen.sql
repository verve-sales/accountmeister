ALTER TABLE "accounts" ADD COLUMN "mail_domains" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "aliases" text[] DEFAULT '{}'::text[] NOT NULL;