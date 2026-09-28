import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { canManagePlaybooks, DORMANT_AFTER_DAYS, listDormantAccounts, listPlaybooks, playbookStats } from "@/modules/playbooks/service";
import { Feedback, type SearchParams } from "@/components/Feedback";
import { Status } from "@/components/Status";
import { accountStatusLabel, fmtDate, playbookScopeLabel } from "@/lib/labels";
import { schema } from "@/db/client";
import { createPlaybookAction } from "../actions";

/**
 * Vorgehensmuster (Etappe 20): Übersicht aller Standard-Vorgehen – zugleich Einarbeitungsunterlage für neue BDs –,
 * einfache Lernschleife (wie oft gestartet/abgeschlossen, welche Schritte übersprungen) und Einstieg in die
 * Reaktivierung ruhender Kunden.
 */
export default async function VorgehenPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  const [playbooks, stats, dormant] = await Promise.all([listPlaybooks(actor), playbookStats(actor), listDormantAccounts(actor)]);
  const mayManage = canManagePlaybooks(actor);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Vorgehensmuster</h1>
      <p className="muted text-sm max-w-3xl">Standard-Vorgehen als Gerüst: Jeder Schritt hat ein Ziel, einen MEDDPICC-Bezug, einen Vorschlag und ein Erledigt-Kriterium. Angewendet auf einen Kunden, ein Setup oder eine Chance wird immer der aktuelle Schritt als Aktion angelegt. Orientierung, keine Pflichtschleuse – jeder Schritt darf begründet übersprungen werden.</p>
      <Feedback params={sp} />

      <section className="card">
        <h2 className="font-semibold mb-2">Reaktivierung prüfen – ruhende Kunden ({dormant.length})</h2>
        <p className="muted text-sm mb-2">Kunden, die als „ruhend“ markiert sind oder seit mehr als {DORMANT_AFTER_DAYS} Tagen keine Aktivität hatten (Setups, Aktionen, Beobachtungen, Chancen). Längste Inaktivität zuerst.</p>
        {dormant.length === 0 ? <p className="muted text-sm">Keine ruhenden Kunden in Ihrem Berechtigungsbereich.</p> : (
          <table className="list">
            <thead><tr><th>Kunde</th><th>Status</th><th>Letzte Aktivität</th><th>Vorgehen</th></tr></thead>
            <tbody>
              {dormant.map((x) => (
                <tr key={x.account.id}>
                  <td><Link href={`/kunden/${x.account.id}`}>{x.account.name}</Link></td>
                  <td><Status label={accountStatusLabel[x.account.status] ?? x.account.status} /></td>
                  <td>{fmtDate(x.lastActivity)}</td>
                  <td>{x.hasActiveRun ? <span className="muted text-sm">läuft bereits</span> : <Link href={`/kunden/${x.account.id}#vorgehen`} className="text-sm">Reaktivierung starten</Link>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {playbooks.map((p) => {
        const st = stats.get(p.id);
        const started = st ? Object.values(st.runs).reduce((a, b) => a + b, 0) : 0;
        return (
          <section key={p.id} className="card">
            <div className="flex flex-wrap items-baseline gap-3 mb-1">
              <h2 className="font-semibold">{p.name}</h2>
              <Status label={`für: ${playbookScopeLabel[p.scope] ?? p.scope}`} />
              {!p.active && <Status label="deaktiviert" />}
              {mayManage && <Link href={`/vorgehen/${p.id}`} className="text-sm ml-auto">Bearbeiten</Link>}
            </div>
            {p.description && <p className="text-sm mb-2">{p.description}</p>}
            <ol className="text-sm space-y-2 list-decimal ml-5">
              {p.steps.map((s) => {
                const ss = st?.steps.get(s.position);
                return (
                  <li key={s.id}>
                    <strong>{s.title}</strong>
                    {s.meddpicc && <span className="muted"> · MEDDPICC: {s.meddpicc}</span>}
                    {s.dueInDays !== null && <span className="muted"> · Richtwert {s.dueInDays} Tage</span>}
                    {s.goal && <div><span className="muted">Wozu: </span>{s.goal}</div>}
                    {s.suggestedAction && <div><span className="muted">Vorschlag: </span>{s.suggestedAction}</div>}
                    {s.doneCriterion && <div><span className="muted">Erledigt, wenn: </span>{s.doneCriterion}</div>}
                    {ss && (ss.erledigt > 0 || ss.uebersprungen > 0) && <div className="muted text-xs">bisher {ss.erledigt}× erledigt, {ss.uebersprungen}× übersprungen</div>}
                  </li>
                );
              })}
            </ol>
            {started > 0 && (
              <p className="muted text-xs mt-2">
                Bisher {started}× angewendet: {st!.runs.AKTIV ?? 0} laufend, {st!.runs.ABGESCHLOSSEN ?? 0} abgeschlossen, {st!.runs.ZURUECKGESTELLT ?? 0} zurückgestellt.
              </p>
            )}
          </section>
        );
      })}

      {mayManage && (
        <details className="card">
          <summary>Eigenes Vorgehensmuster anlegen</summary>
          <form action={createPlaybookAction} className="mt-3 grid sm:grid-cols-2 gap-3">
            <div><label className="label" htmlFor="pbName">Name</label><input id="pbName" name="name" className="input" required minLength={3} maxLength={120} /></div>
            <div>
              <label className="label" htmlFor="pbScope">Wird angewendet auf</label>
              <select id="pbScope" name="scope" className="select" defaultValue="ACCOUNT">
                {schema.playbookScopeEnum.enumValues.map((v) => <option key={v} value={v}>{playbookScopeLabel[v]}</option>)}
              </select>
            </div>
            <div className="sm:col-span-2"><label className="label" htmlFor="pbDesc">Wofür ist das Muster gedacht?</label><textarea id="pbDesc" name="description" className="textarea" rows={2} maxLength={1000} /></div>
            <div className="sm:col-span-2"><button className="btn" type="submit">Anlegen und Schritte ergänzen</button></div>
          </form>
        </details>
      )}
    </div>
  );
}
