import Link from "next/link";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { Status } from "@/components/Status";
import { feedbackReasonLabel, fmtDate, opportunityStatusLabel, orgTypeLabel } from "@/lib/labels";
import { acceptSuggestionAction, suggestionFeedbackAction } from "@/app/actions";
import { eingangTypeLabel, renewalDefaultsFor } from "@/modules/eingang/service";
import type { IntakeItem } from "@/modules/ai/schemas";

type Suggestion = typeof schema.suggestions.$inferSelect;
type Resolved = { opportunityId?: string | null; engagementId?: string | null; actionId?: string | null; questionId?: string | null; personId?: string | null; dueDate?: string };

const AMBER = "#b7791f";
const decisionRoleText: Record<string, string> = { BEDARFSTRAEGER: "Bedarfsträger", FACHLICHE_BEWERTUNG: "Fachliche Bewertung", BUDGETVERANTWORTUNG: "Budget", EINKAUF_VERTRAGSWEG: "Einkauf/Vertragsweg", ZUSAETZLICHE_FREIGABE: "Zusätzliche Freigabe", UNTERSTUETZER_SPONSOR: "Sponsor" };

/** Karte der Eingangs-Auswertung (Etappe 36): was erkannt wurde, worauf es sich bezieht, ein Klick zum Übernehmen. */
export async function EingangCard({ s, canDecide, back }: { s: Suggestion; canDecide: boolean; back: string }) {
  const payload = (s.payload ?? null) as { item: IntakeItem; resolved: Resolved } | null;
  if (!payload) return null;
  const { item, resolved } = payload;
  const open = s.status === "NEU" || s.status === "GEPRUEFT" || s.status === "ZURUECKGESTELLT";
  const [opp, action, question, person, account] = await Promise.all([
    resolved.opportunityId ? db.query.opportunities.findFirst({ where: eq(schema.opportunities.id, resolved.opportunityId) }) : null,
    resolved.actionId ? db.query.actions.findFirst({ where: eq(schema.actions.id, resolved.actionId) }) : null,
    resolved.questionId ? db.query.openQuestions.findFirst({ where: eq(schema.openQuestions.id, resolved.questionId) }) : null,
    resolved.personId ? db.query.persons.findFirst({ where: eq(schema.persons.id, resolved.personId) }) : null,
    s.accountId ? db.query.accounts.findFirst({ where: eq(schema.accounts.id, s.accountId) }) : null,
  ]);
  const renewal = item.type === "VERLAENGERUNG" ? await renewalDefaultsFor(resolved.engagementId ?? null, item.newEnd) : null;
  const engagement = item.type === "STIMMUNG" && resolved.engagementId ? await db.query.engagements.findFirst({ where: eq(schema.engagements.id, resolved.engagementId) }) : null;
  const needsCustomer = !s.setupId && !["KUNDE", "EINSORTIERUNG"].includes(item.type) && !(s.accountId && ["PERSON", "INITIATIVE", "BESCHAFFUNG", "RISIKO", "HEBEL", "SOS", "TEAM"].includes(item.type));
  const label = eingangTypeLabel[item.type] ?? item.type;
  const accept: Record<string, string> = {
    KUNDE: "Kunde + Setup anlegen", EINSORTIERUNG: "Zuordnen", SETUP: "Setup anlegen", PERSON: resolved.personId ? "Person ergänzen" : "Person übernehmen", CHANCE: "Chance anlegen", CHANCE_STATUS: "Stand übernehmen",
    VERLAENGERUNG: item.type === "VERLAENGERUNG" && item.decision === "ENDET" ? "Ende festhalten" : "Verlängerung übernehmen", ERLEDIGT: "Abhaken", STIMMUNG: "Als Check-in festhalten", FREELANCER: resolved.opportunityId ? "Als Kandidat:in eintragen" : "In den Pool", BESETZUNG: "Position anlegen", AKTION: "Aufgabe anlegen", FRAGE: "Frage anlegen", KONTAKT: "Aufgabe anlegen", SIGNAL: "Beobachtung anlegen", EINSATZ: "Einsatz nachtragen",
  };

  return (
    <li className="border rounded-md p-3" style={{ borderColor: "var(--border)", borderLeft: `4px solid ${["VERLAENGERUNG", "CHANCE_STATUS", "CHANCE", "KUNDE"].includes(item.type) ? AMBER : "var(--border)"}` }}>
      <div className="flex flex-wrap gap-2 items-baseline">
        <Status label={label} />
        <strong>{s.title}</strong>
        <span className="muted text-xs ml-auto">{account ? account.name : "Kunde offen"} · {s.trigger}</span>
      </div>
      <div className="text-sm mt-1 space-y-1">
        {item.type === "PERSON" && (
          <p>
            <strong>{item.displayName}</strong>
            {item.functionTitle ? ` – ${item.functionTitle}` : ""}
            {item.orgUnitName ? ` · ${item.orgUnitName}` : ""}
            {item.email ? <span className="muted"> · {item.email}</span> : null}
            {item.phone ? <span className="muted"> · {item.phone}</span> : null}
            {item.decisionRole ? <span> · Buyingcenter: {decisionRoleText[item.decisionRole] ?? item.decisionRole} <span className="muted">(Hypothese)</span></span> : null}
            {person ? <span className="muted"> · ergänzt die bekannte Person {person.displayName}</span> : null}
          </p>
        )}
        {renewal && item.type === "VERLAENGERUNG" && (
          <p>
            Einsatz <Link href={`/einsaetze/${renewal.engagementId}#verlaengerung`}>{renewal.title}</Link> · Ende heute <strong>{renewal.currentEnd ? fmtDate(renewal.currentEnd) : "offen"}</strong>
            {renewal.openStatus ? <span style={{ color: AMBER }}> · Verlängerung {renewal.openStatus === "ZU_KLAEREN" ? "zu klären" : "in Abstimmung"}</span> : null}
            {item.decision === "ENDET" ? <span style={{ color: "#c0392b" }}> · laut Text: keine Verlängerung</span> : null}
            {item.conditionsNote ? ` · ${item.conditionsNote}` : ""}
          </p>
        )}
        {item.type === "CHANCE_STATUS" && opp && <p>Chance <Link href={`/bedarfe/${opp.id}`}>{opp.title}</Link>: {opportunityStatusLabel[opp.status] ?? opp.status} → <strong>{opportunityStatusLabel[item.status] ?? item.status}</strong>{item.reason ? <span className="muted"> · {item.reason}</span> : null}</p>}
        {item.type === "ERLEDIGT" && (action || question) && <p>{action ? <>Aktion „{action.title}“</> : <>Frage „{question!.question.slice(0, 160)}“</>} wird abgehakt{item.result ? <span className="muted"> · {item.result}</span> : null}</p>}
        {item.type === "STIMMUNG" && engagement && <p>Einsatz <Link href={`/einsaetze/${engagement.id}`}>{engagement.title}</Link> · {item.side === "KUNDE" ? "Kunde" : "Freelancer"}: <strong>{item.mood.toLowerCase()}</strong></p>}
        {!["PERSON", "VERLAENGERUNG", "CHANCE_STATUS", "ERLEDIGT", "STIMMUNG"].includes(item.type) && s.observation && s.observation !== s.evidenceQuote && <p>{s.observation}</p>}
        {resolved.dueDate ? <p>Frist: <strong>{fmtDate(resolved.dueDate)}</strong></p> : item.type === "AKTION" && item.dueHint ? <p>Frist laut Text: {item.dueHint}</p> : null}
        {opp && item.type !== "CHANCE_STATUS" ? <p className="muted">Wofür: <Link href={`/bedarfe/${opp.id}`}>{opp.title}</Link></p> : null}
        <p className="muted">Beleg: „{s.evidenceQuote.length > 260 ? `${s.evidenceQuote.slice(0, 260)} …` : s.evidenceQuote}“</p>
      </div>
      {canDecide && open && (
        <div className="mt-2 flex flex-wrap gap-4 items-end">
          {needsCustomer ? (
            <p className="text-sm" style={{ color: AMBER }}>Erst die Karte „Neuer Kunde“ bzw. „Kunde zuordnen“ übernehmen – dann gehört diese Karte automatisch dazu.</p>
          ) : (
            <form action={acceptSuggestionAction} className="flex flex-wrap gap-2 items-end text-sm">
              <input type="hidden" name="suggestionId" value={s.id} />
              <input type="hidden" name="version" value={s.version} />
              <input type="hidden" name="back" value={back} />
              {item.type === "KUNDE" && (
                <div>
                  <label className="label" htmlFor={`ot-${s.id}`}>Organisationstyp <span style={{ color: "#c0392b" }}>*</span></label>
                  <select id={`ot-${s.id}`} name="orgType" className="select" required defaultValue={item.orgType && item.orgType !== "SONSTIGE" ? item.orgType : ""}>
                    <option value="" disabled>Bitte wählen …</option>
                    {schema.orgTypeEnum.enumValues.map((v) => <option key={v} value={v}>{orgTypeLabel[v] ?? v}</option>)}
                  </select>
                </div>
              )}
              {renewal && item.type === "VERLAENGERUNG" && item.decision !== "ENDET" && (
                <>
                  <div><label className="label" htmlFor={`ne-${s.id}`}>Neues Ende{renewal.fromText ? "" : " (nicht im Text – bitte prüfen)"}</label><input id={`ne-${s.id}`} type="date" name="newEnd" className="input" required defaultValue={renewal.newEnd} /></div>
                  <div><label className="label" htmlFor={`cf-${s.id}`}>Vertragsfolge</label><select id={`cf-${s.id}`} name="contractFollowUp" className="select" defaultValue="Nachtrag"><option>Nachtrag</option><option>Neue Bestellung</option><option>Rahmenabruf</option><option>Verlängerungsschreiben</option></select></div>
                </>
              )}
              <button className="btn btn-small" type="submit" title={item.type === "VERLAENGERUNG" ? "BD/Principal: bestätigt direkt (Einsatzende, Moco, offene Klärung erledigt). Sonst Anstoß an den BD." : undefined}>{accept[item.type] ?? "Übernehmen"}</button>
            </form>
          )}
          <form action={suggestionFeedbackAction} className="flex flex-wrap gap-1 items-end">
            <input type="hidden" name="suggestionId" value={s.id} />
            <input type="hidden" name="version" value={s.version} />
            <input type="hidden" name="back" value={back} />
            <select name="feedbackReason" className="select" style={{ width: "11rem" }} defaultValue="" aria-label="Grund">
              <option value="">Grund (bei Ablehnung)</option>
              {schema.feedbackReasonEnum.enumValues.map((v) => <option key={v} value={v}>{feedbackReasonLabel[v]}</option>)}
            </select>
            <button className="btn btn-secondary btn-small" name="status" value="ABGELEHNT">Ablehnen</button>
            <button className="btn btn-secondary btn-small" name="status" value="ZURUECKGESTELLT">Später</button>
          </form>
        </div>
      )}
    </li>
  );
}
