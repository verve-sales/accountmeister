-- e48d: Beim Startimport als „endet“ übernommene Einsätze, deren Ende laut Moco zurückliegt, sind abgeschlossen
UPDATE "engagements" SET "status" = 'ABGESCHLOSSEN', "updated_at" = now()
WHERE "status" = 'ENDET'
  AND "status_reason" = 'Laut Moco bereits beendet (Startimport).'
  AND coalesce("actual_end", "planned_end") < current_date
  AND NOT EXISTS (SELECT 1 FROM "renewal_decisions" r WHERE r."engagement_id" = "engagements"."id" AND r."status" IN ('ZU_KLAEREN', 'IN_ABSTIMMUNG', 'ANGEBOTEN'));
