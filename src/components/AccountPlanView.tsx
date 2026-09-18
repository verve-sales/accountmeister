import Link from "next/link";
import type { AccountPlanView as Plan } from "@/modules/accountplan/service";
import { Status } from "@/components/Status";
import { accessPlanStatusLabel, actionStatusLabel, fmtDate, fmtDateTime, handoverStatusLabel, priorityKindLabel, priorityStatusLabel, relationshipStateLabel, setupStatusLabel, signalStatusLabel } from "@/lib/labels";

/**
 * Darstellung des Accountplans (A1) – wird für die Live-Übersicht und für gespeicherte Stände gleich verwendet.
 * Alle Inhalte sind Datenbezüge; die Komponente rechnet nichts hinzu.
 */
export function AccountPlanView({ plan, live, children }: { plan: Plan; live: boolean; children?: React.ReactNode }) {
  return (
    <div className="space-y-4">
      <p className="muted text-sm">
        {live ? "Live-Übersicht" : "Gespeicherter Stand"} · erzeugt {fmtDateTime(plan.generatedAt)} · zuständiger BD: {plan.account.responsibleBd ?? "offen"}
        {plan.dataQuality.setupsWithoutConfirmedWeekly > 0 && ` · ${plan.dataQuality.setupsWithoutConfirmedWeekly} Setup(s) ohne bestätigtes Weekly`}
        {plan.dataQuality.hiddenSourcesNote && ` · ${plan.dataQuality.hiddenSourcesNote}`}
      </p>

      <div className="grid lg:grid-cols-2 gap-4">
        <section>
          <h3 className="font-medium mb-1">Bestehende Zusammenarbeit</h3>
          {plan.engagements.length === 0 ? <p className="muted text-sm">Keine bestätigten Einsatzangaben.</p> : (
            <ul className="text-sm list-disc ml-5">{plan.engagements.map((e, i) => <li key={i}>{e.content} <span className="muted">({e.setupName}{e.hasEvidence ? ", belegt" : ", ohne Beleg"})</span></li>)}</ul>
          )}
          <h4 className="font-medium mt-3 mb-1 text-sm">Setups</h4>
          <ul className="text-sm space-y-1">
            {plan.setups.map((s) => (
              <li key={s.id}>
                {live ? <Link href={`/setups/${s.id}`}>{s.name}</Link> : s.name} <Status label={setupStatusLabel[s.status] ?? s.status} /> <span className="muted">BD: {s.bd ?? "offen"}</span>
                <div className="muted">{s.lastConfirmedWeekly ? `Letztes bestätigtes Weekly: ${s.lastConfirmedWeekly.title} (${fmtDate(s.lastConfirmedWeekly.scheduledFor)}, ${s.lastConfirmedWeekly.confirmedBy})` : "Noch kein bestätigtes Weekly"}</div>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h3 className="font-medium mb-1">Relevante Veränderungen ({plan.changes.length})</h3>
          {plan.changes.length === 0 ? <p className="muted text-sm">Keine offenen Hinweise.</p> : (
            <ul className="text-sm list-disc ml-5">{plan.changes.map((c) => <li key={c.id}><Status label={signalStatusLabel[c.status] ?? c.status} /> {c.observation} <span className="muted">({c.setupName}, {fmtDate(c.createdAt)}{c.owner ? `, Prüfung: ${c.owner}` : ""})</span></li>)}</ul>
          )}
        </section>

        <section>
          <h3 className="font-medium mb-1">Belegte Beziehungen und Zugangslücken</h3>
          {plan.relationships.length === 0 ? <p className="muted text-sm">Keine dokumentierten Beziehungen.</p> : (
            <ul className="text-sm list-disc ml-5">{plan.relationships.map((r, i) => <li key={i}>{r.person} – {r.holder} <Status label={relationshipStateLabel[r.state] ?? r.state} />{!r.hasEvidence && <span className="muted"> (ohne Beleg)</span>}</li>)}</ul>
          )}
          {plan.accessGaps.length > 0 && (
            <>
              <h4 className="font-medium mt-3 mb-1 text-sm">Offene Kontaktwege</h4>
              <ul className="text-sm list-disc ml-5">{plan.accessGaps.map((g, i) => <li key={i}>Ziel {g.target}: {g.occasion} <Status label={accessPlanStatusLabel[g.status] ?? g.status} /> <span className="muted">{g.owner}{g.unprovenSteps > 0 ? `, ${g.unprovenSteps} nicht belegte(r) Schritt(e)` : ""}</span></li>)}</ul>
            </>
          )}
        </section>

        <section>
          <h3 className="font-medium mb-1">Offene Fragen und Risiken ({plan.openQuestions.length})</h3>
          {plan.openQuestions.length === 0 ? <p className="muted text-sm">Keine zurückgestellten Hinweise oder blockierten Aktionen.</p> : (
            <ul className="text-sm list-disc ml-5">{plan.openQuestions.map((q, i) => <li key={i}><Status label={q.kind === "BLOCKIERT" ? "Blockiert" : "Zurückgestellt"} /> {q.text} <span className="muted">({q.setupName})</span></li>)}</ul>
          )}
        </section>
      </div>

      <section>
        <h3 className="font-medium mb-1">Priorisierte Entwicklungsvorhaben ({plan.priorities.length})</h3>
        {plan.priorities.length === 0 ? <p className="muted text-sm">Noch keine Prioritäten gesetzt. Prioritäten sind eine gemeinsame Entscheidung von BD und Principal.</p> : (
          <table className="list">
            <thead><tr><th>Rang</th><th>Vorhaben</th><th>Art</th><th>Status</th><th>Begründung / Voraussetzungen</th><th>Zielbezug</th></tr></thead>
            <tbody>
              {plan.priorities.map((p) => (
                <tr key={p.id}>
                  <td>{p.rank}</td>
                  <td>{p.title}{p.setupName && <div className="muted text-sm">{p.setupName}</div>}</td>
                  <td>{priorityKindLabel[p.kind] ?? p.kind}</td>
                  <td><Status label={priorityStatusLabel[p.status] ?? p.status} />{p.deferredReason && <div className="muted text-sm">{p.deferredReason}</div>}</td>
                  <td className="text-sm">{p.rationale ?? "–"}{p.prerequisites && <div className="muted">Voraussetzungen: {p.prerequisites}</div>}</td>
                  <td className="text-sm">{p.goalReference ?? <span className="muted">–</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <div className="grid lg:grid-cols-2 gap-4">
        <section>
          <h3 className="font-medium mb-1">Vereinbarte Aktionen ({plan.actions.length})</h3>
          {plan.actions.length === 0 ? <p className="muted text-sm">Keine offenen Aktionen.</p> : (
            <ul className="text-sm list-disc ml-5">{plan.actions.map((a) => <li key={a.id}>{a.title} – {a.owner} <Status label={actionStatusLabel[a.status] ?? a.status} /> <span className="muted">{a.dueDate ? `bis ${fmtDate(a.dueDate)}` : ""} ({a.setupName})</span></li>)}</ul>
          )}
          {plan.handovers.length > 0 && <ul className="text-sm list-disc ml-5 mt-2">{plan.handovers.map((h, i) => <li key={i}>Übergabe: {h.responsibility} – {h.from} → {h.to} <Status label={handoverStatusLabel[h.status] ?? h.status} /></li>)}</ul>}
        </section>
        <section>
          <h3 className="font-medium mb-1">Entscheidungen und Zielbezug</h3>
          {plan.decisions.length === 0 ? <p className="muted text-sm">Keine dokumentierten Entscheidungen.</p> : (
            <ul className="text-sm list-disc ml-5">{plan.decisions.map((d, i) => <li key={i}>{d.content} <span className="muted">({fmtDate(d.decidedOn)}, {d.setupName})</span></li>)}</ul>
          )}
          <p className="muted text-sm mt-2">{plan.goals.note}</p>
        </section>
      </div>
      {children}
    </div>
  );
}
