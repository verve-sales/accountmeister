DROP INDEX "order_cases_order_uq";--> statement-breakpoint
ALTER TABLE "order_cases" ADD COLUMN "order_position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "order_cases_order_uq" ON "order_cases" USING btree ("workspace_id","partner_account_id","order_number","order_position") WHERE order_number IS NOT NULL AND status <> 'STORNIERT';