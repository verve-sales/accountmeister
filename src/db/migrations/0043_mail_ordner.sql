ALTER TABLE "integration_connections" ADD COLUMN "watch_folder" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD COLUMN "watch_folder_id" text;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD COLUMN "watch_folder_checked_at" timestamp with time zone;