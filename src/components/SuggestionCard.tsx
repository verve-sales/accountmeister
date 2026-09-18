import { schema } from "@/db/client";
import { Status } from "@/components/Status";
import { feedbackReasonLabel, fmtDateTime, priorityCategoryLabel, suggestionStatusLabel, suggestionTypeLabel } from "@/lib/labels";
import { acceptSuggestionAction, suggestionFeedbackAction } from "@/app/actions";

type Suggestion = typeof schema.suggestions.$inferSelect;

/**
 * Vorschlagskarte (Briefing 14.2): zeigt Beobachtung, getrennt gekennzeichnete Idee, Beleg, Unsicherheit,
 * Warum-jetzt, nächsten Schritt, vorgeschlagene Person, Modell-/Promptversion. Entscheidung bleibt beim Menschen.
 */
export function SuggestionCard({ s, ownerName, canDecide, back, users }: { s: Suggestion; ownerName: string | null; canDecide: boolean; back: string; users: { id: string; displayName: string }[] }) {
  const open = s.status === "NEU" || s.status === "GEPRUEFT" || s.status === "ZURUECKGESTELLT";
  return (
    <li className="border rounded-md p-3" style={{ borderColor: "var(--border)" }}>
      <div className="flex flex-wrap gap-2 items-baseline">
        <Status label={suggestionTypeLabel[s.type] ?? s.type} />
        <strong>{s.title}</strong>
        <Status label={suggestionStatusLabel[s.status] ?? s.status} />
        <span className="muted text-sm">{priorityCategoryLabel[s.priorityCategory]}</span>
      </div>
      <dl className="text-sm mt-2 grid sm:grid-cols-2 gap-x-6 gap-y-1">
        <div><dt className="muted">Sachverhalt aus der Quelle</dt><dd>{s.observation}</dd></div>
        {s.hypothesis && <div><dt className="muted">Idee / Vermutung (nicht belegt)</dt><dd>{s.hypothesis}</dd></div>}
        <div><dt className="muted">Beleg (Zitat)</dt><dd>„{s.evidenceQuote}“ <span className="muted">– {s.trigger}</span></dd></div>
        {s.uncertainty && <div><dt className="muted">Unsicherheit / Voraussetzung</dt><dd>{s.uncertainty}</dd></div>}
        {s.whyNow && <div><dt className="muted">Warum jetzt</dt><dd>{s.whyNow}</dd></div>}
        {s.nextStep && <div><dt className="muted">Konkreter nächster Schritt</dt><dd>{s.nextStep}</dd></div>}
        {s.proposedQuestion && <div><dt className="muted">Mögliche Frage</dt><dd>{s.proposedQuestion}</dd></div>}
        {s.expectedResult && <div><dt className="muted">Erwartetes Arbeitsergebnis</dt><dd>{s.expectedResult}</dd></div>}
        <div><dt className="muted">Vorgeschlagene Person (keine Zuweisung)</dt><dd>{ownerName ?? "–"}</dd></div>
        {s.feedbackReason && <div><dt className="muted">Rückmeldung</dt><dd>{feedbackReasonLabel[s.feedbackReason]}{s.feedbackNote && ` – ${s.feedbackNote}`}</dd></div>}
      </dl>
      <p className="muted text-sm mt-1">Anbieter {s.provider} · Modell {s.model} · Prompt {s.promptVersion} · berechnet {fmtDateTime(s.computedAt)}</p>
      {canDecide && open && (
        <div className="mt-2 flex flex-wrap gap-4 items-start">
          <form action={acceptSuggestionAction} className="flex flex-wrap gap-1 items-end">
            <input type="hidden" name="suggestionId" value={s.id} />
            <input type="hidden" name="version" value={s.version} />
            <input type="hidden" name="back" value={back} />
            <input name="editedText" className="input" style={{ width: "16rem" }} placeholder="Optional: Text vor Übernahme anpassen" aria-label="Text anpassen" />
            {(s.type === "AKTION" || s.type === "OFFENE_FRAGE" || s.type === "PERSON") && (
              <select name="ownerUserId" className="select" style={{ width: "12rem" }} defaultValue={s.proposedOwnerUserId ?? ""} aria-label="Verantwortliche Person">
                <option value="">– Person wählen –</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
              </select>
            )}
            <button className="btn btn-small" type="submit">Annehmen</button>
          </form>
          <form action={suggestionFeedbackAction} className="flex flex-wrap gap-1 items-end">
            <input type="hidden" name="suggestionId" value={s.id} />
            <input type="hidden" name="version" value={s.version} />
            <input type="hidden" name="back" value={back} />
            <select name="feedbackReason" className="select" style={{ width: "11rem" }} defaultValue="" aria-label="Grund">
              <option value="">Grund (bei Ablehnung)</option>
              {schema.feedbackReasonEnum.enumValues.map((v) => <option key={v} value={v}>{feedbackReasonLabel[v]}</option>)}
            </select>
            <input name="feedbackNote" className="input" style={{ width: "10rem" }} placeholder="Notiz" aria-label="Notiz" />
            {s.status !== "GEPRUEFT" && <button className="btn btn-secondary btn-small" name="status" value="GEPRUEFT">Geprüft</button>}
            {s.status !== "ZURUECKGESTELLT" && <button className="btn btn-secondary btn-small" name="status" value="ZURUECKGESTELLT">Später</button>}
            <button className="btn btn-secondary btn-small" name="status" value="ABGELEHNT">Ablehnen</button>
          </form>
        </div>
      )}
    </li>
  );
}
