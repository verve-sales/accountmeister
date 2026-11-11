DROP INDEX "conversions_running_uq";--> statement-breakpoint
ALTER TABLE "conversions" ADD COLUMN "position_id" text;--> statement-breakpoint
ALTER TABLE "conversions" ADD CONSTRAINT "conversions_position_id_staffing_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."staffing_positions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Bestehende Vorgänge (einer je Chance) auf die Positionen der Chance verteilen: die erste Position übernimmt den Vorgang,
-- jede weitere bekommt eine Kopie. Bestellangaben gehen nur an Positionen mit Einsatz mit.
INSERT INTO "conversions" ("workspace_id","opportunity_id","position_id","status","clarified_at","intermediary_checked_at","intermediary_checked_by","intermediary_check_note","offer_number","offer_version","offer_sent_at","offer_link","commit_at","commit_note","order_reference","order_link","order_at","provisional_start","created_by","created_at","updated_at")
SELECT c."workspace_id", c."opportunity_id", r.pid, CASE WHEN c."status" = 'ABGESCHLOSSEN' AND NOT r.has_eng THEN 'LAUFEND' ELSE c."status" END, c."clarified_at", c."intermediary_checked_at", c."intermediary_checked_by", c."intermediary_check_note", c."offer_number", c."offer_version", c."offer_sent_at", c."offer_link", c."commit_at", c."commit_note",
  CASE WHEN r.has_eng THEN c."order_reference" END, CASE WHEN r.has_eng THEN c."order_link" END, CASE WHEN r.has_eng THEN c."order_at" END, CASE WHEN r.has_eng THEN c."provisional_start" ELSE false END, c."created_by", c."created_at", c."updated_at"
FROM "conversions" c
JOIN (
  SELECT p."opportunity_id" AS oid, p."id" AS pid, row_number() OVER (PARTITION BY p."opportunity_id" ORDER BY p."created_at", p."id") AS rn,
    EXISTS (SELECT 1 FROM "engagements" e WHERE e."position_id" = p."id") AS has_eng
  FROM "staffing_positions" p WHERE p."status" <> 'ABGEBROCHEN'
) r ON r.oid = c."opportunity_id" AND r.rn > 1
WHERE c."status" IN ('LAUFEND','RUHEND','ABGESCHLOSSEN');--> statement-breakpoint
UPDATE "conversions" c SET "position_id" = r.pid
FROM (
  SELECT p."opportunity_id" AS oid, p."id" AS pid, row_number() OVER (PARTITION BY p."opportunity_id" ORDER BY p."created_at", p."id") AS rn
  FROM "staffing_positions" p WHERE p."status" <> 'ABGEBROCHEN'
) r
WHERE r.oid = c."opportunity_id" AND r.rn = 1 AND c."position_id" IS NULL AND c."status" IN ('LAUFEND','RUHEND','ABGESCHLOSSEN')
  AND c."id" IN (SELECT DISTINCT ON ("opportunity_id") "id" FROM "conversions" WHERE "position_id" IS NULL AND "status" IN ('LAUFEND','RUHEND','ABGESCHLOSSEN') ORDER BY "opportunity_id", "created_at" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX "conversions_running_pos_uq" ON "conversions" USING btree ("position_id") WHERE status in ('LAUFEND', 'RUHEND') and position_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "conversions_running_open_uq" ON "conversions" USING btree ("opportunity_id") WHERE status in ('LAUFEND', 'RUHEND') and position_id is null;--> statement-breakpoint
CREATE INDEX "conversions_opp_idx" ON "conversions" USING btree ("opportunity_id");