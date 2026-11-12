ALTER TABLE "engagements" ADD COLUMN "order_reference" text;--> statement-breakpoint
ALTER TABLE "renewal_decisions" ADD COLUMN "order_reference" text;--> statement-breakpoint
-- Benachrichtigungen (e44): Altlast aufräumen. Hinweise zur Kenntnis zählen nicht mehr an der Glocke; erledigte Sachen und
-- tägliche Wiederholungen gelten als gelesen. Die Einträge bleiben in der Liste stehen.
UPDATE "notifications" SET "read_at" = now() WHERE "read_at" IS NULL AND "kind" IN ('ANGENOMMEN', 'ERLEDIGT', 'KOMMENTAR', 'TEAM_EINGANG');--> statement-breakpoint
UPDATE "notifications" n SET "read_at" = now() WHERE n."read_at" IS NULL AND n."kind" = 'UEBERFAELLIG'
  AND EXISTS (SELECT 1 FROM "notifications" m WHERE m."user_id" = n."user_id" AND m."link" = n."link" AND m."kind" = 'UEBERFAELLIG' AND m."created_at" > n."created_at");--> statement-breakpoint
UPDATE "notifications" n SET "read_at" = now() WHERE n."read_at" IS NULL AND n."link" LIKE '/uebergaben/%'
  AND EXISTS (SELECT 1 FROM "backoffice_handovers" h WHERE '/uebergaben/' || h."id" = n."link" AND h."status" = 'QUITTIERT');--> statement-breakpoint
UPDATE "notifications" n SET "read_at" = now() WHERE n."read_at" IS NULL AND n."link" LIKE '/vorgaenge/%'
  AND EXISTS (SELECT 1 FROM "work_items" w WHERE '/vorgaenge/' || w."id" = n."link" AND w."status" IN ('ERLEDIGT', 'VERWORFEN'));--> statement-breakpoint
UPDATE "notifications" n SET "read_at" = now() WHERE n."read_at" IS NULL AND n."link" = '/start#entscheidungen' AND n."created_at" < now() - interval '14 days';