ALTER TABLE "orders" ADD COLUMN "contract_source_id" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "contract_link" text;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_contract_source_id_sources_id_fk" FOREIGN KEY ("contract_source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;