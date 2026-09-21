CREATE TYPE "public"."action_channel" AS ENUM('GESPRAECH', 'TELEFON', 'EMAIL', 'LINKEDIN', 'SONSTIGE');--> statement-breakpoint
ALTER TABLE "actions" ADD COLUMN "channel" "action_channel";--> statement-breakpoint
ALTER TABLE "actions" ADD COLUMN "linkedin_url" text;--> statement-breakpoint
ALTER TABLE "persons" ADD COLUMN "linkedin_url" text;