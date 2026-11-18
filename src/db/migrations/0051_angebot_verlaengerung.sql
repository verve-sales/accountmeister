-- e49f: Angebote, die über „Angebot erzeugen“ entstanden sind, bevor daraus automatisch eine Verlängerung wurde:
-- offene Verlängerung ohne Zeitraum bekommt Zeitraum und Angebot; fehlt sie ganz, wird sie als „angeboten“ angelegt.
WITH offers AS (
  SELECT DISTINCT ON (e.id) e.id AS engagement_id, e.workspace_id, e.bd_user_id, d.valid_from, d.valid_to, d.reference, d.link, d.created_by
  FROM engagements e
  JOIN engagement_documents ed ON ed.engagement_id = e.id
  JOIN contract_documents d ON d.id = ed.document_id AND d.doc_type = 'ANGEBOT' AND d.valid_to IS NOT NULL AND d.reference IS NOT NULL
  WHERE e.status IN ('AKTIV', 'PAUSIERT', 'GEPLANT', 'ENDET') AND e.planned_end IS NOT NULL AND d.valid_to > e.planned_end
  ORDER BY e.id, d.created_at DESC
), upd AS (
  UPDATE renewal_decisions r
  SET status = 'ANGEBOTEN', proposed_from = COALESCE(r.proposed_from, o.valid_from), proposed_to = COALESCE(r.proposed_to, o.valid_to), offer_number = COALESCE(r.offer_number, o.reference), offer_link = COALESCE(r.offer_link, o.link), conditions_note = COALESCE(r.conditions_note, 'Angebot ' || o.reference), updated_at = now()
  FROM offers o
  WHERE r.engagement_id = o.engagement_id AND r.status IN ('ZU_KLAEREN', 'IN_ABSTIMMUNG', 'ANGEBOTEN') AND (r.proposed_to IS NULL OR r.offer_number IS NULL)
  RETURNING r.engagement_id
)
INSERT INTO renewal_decisions (id, workspace_id, engagement_id, status, trigger_date, proposed_from, proposed_to, conditions_note, offer_number, offer_link, commercial_owner_user_id, created_by)
SELECT gen_random_uuid()::text, o.workspace_id, o.engagement_id, 'ANGEBOTEN', current_date, o.valid_from, o.valid_to, 'Angebot ' || o.reference, o.reference, o.link, o.bd_user_id, o.created_by
FROM offers o
WHERE NOT EXISTS (SELECT 1 FROM renewal_decisions r WHERE r.engagement_id = o.engagement_id AND (r.status IN ('ZU_KLAEREN', 'IN_ABSTIMMUNG', 'ANGEBOTEN') OR (r.status = 'BESTAETIGT' AND r.proposed_to >= o.valid_to)));
