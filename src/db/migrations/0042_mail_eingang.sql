CREATE TABLE "mail_inbox_items" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text,
	"message_id" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"user_id" text,
	"subject" text,
	"status" text NOT NULL,
	"reason" text,
	"source_id" text,
	"card_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mail_inbox_items" ADD CONSTRAINT "mail_inbox_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_inbox_items" ADD CONSTRAINT "mail_inbox_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_inbox_items" ADD CONSTRAINT "mail_inbox_items_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mail_inbox_items_msg_uq" ON "mail_inbox_items" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "mail_inbox_items_received_idx" ON "mail_inbox_items" USING btree ("received_at");