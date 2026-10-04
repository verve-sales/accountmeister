import { deleteEngagementAction, deleteOpportunityAction, deleteSetupAction } from "@/app/actions";

/**
 * Endgültiges Löschen eines Objekts mit allem, was daran hängt – bewusst unauffällig am Seitenende, eingeklappt,
 * mit Bestätigung und Begründung (Protokoll). Kunden werden weiterhin über Archivieren → Löschen entfernt.
 */
export function DeleteBlock({ kind, id, label, scope, back }: { kind: "SETUP" | "CHANCE" | "EINSATZ"; id: string; label: string; scope: string; back: string }) {
  const action = kind === "SETUP" ? deleteSetupAction : kind === "CHANCE" ? deleteOpportunityAction : deleteEngagementAction;
  const field = kind === "SETUP" ? "setupId" : kind === "CHANCE" ? "opportunityId" : "engagementId";
  const noun = kind === "SETUP" ? "Setup" : kind === "CHANCE" ? "Chance" : "Einsatz";
  return (
    <section className="card" style={{ borderColor: "var(--border)" }}>
      <details>
        <summary className="text-sm muted">{noun} endgültig löschen …</summary>
        <form action={action} className="mt-2 space-y-2 text-sm">
          <input type="hidden" name={field} value={id} />
          <input type="hidden" name="back" value={back} />
          <p>Löscht <strong>{label}</strong> endgültig – {scope}. Beobachtungen, die nur darauf verweisen, bleiben erhalten. Das lässt sich nicht rückgängig machen; Begründung und Umfang bleiben im Protokoll.</p>
          <div><label className="label" htmlFor={`del-${id}`}>Begründung (Pflicht)</label><input id={`del-${id}`} name="reason" className="input" required minLength={10} maxLength={1000} placeholder="z. B. Dublette aus Import, Fehlanlage, Testdaten" /></div>
          <label className="flex items-center gap-2"><input type="checkbox" name="confirm" value="on" required /> Ja, {noun} mit allem Inhalt löschen</label>
          <button className="btn btn-secondary btn-small" type="submit" style={{ borderColor: "#c0392b", color: "#c0392b" }}>Endgültig löschen</button>
        </form>
      </details>
    </section>
  );
}
