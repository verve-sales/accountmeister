import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { listMySetups } from "@/modules/setups/service";
import { listMyOpenActions } from "@/modules/actions/service";
import { listMyHandovers } from "@/modules/handovers/service";
import { Feedback, type SearchParams } from "@/components/Feedback";
import { Status } from "@/components/Status";
import { actionStatusLabel, fmtDate, handoverStatusLabel, setupStatusLabel } from "@/lib/labels";
import { changeActionStatusAction, respondHandoverAction } from "../actions";

export default async function MeineArbeitPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  const [setups, actions, handovers] = await Promise.all([listMySetups(actor), listMyOpenActions(actor), listMyHandovers(actor)]);
  const openIncoming = handovers.filter((h) => h.receiverUserId === actor.userId && h.status === "ANGEFRAGT");
  const outgoing = handovers.filter((h) => h.senderUserId === actor.userId && (h.status === "ANGEFRAGT" || h.status === "ANGENOMMEN"));
  const back = "/meine-arbeit";

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Meine Arbeit</h1>
      <Feedback params={params} />

      <section className="card">
        <h2 className="font-semibold mb-2">Offene Übernahmen an mich ({openIncoming.length})</h2>
        {openIncoming.length === 0 ? (
          <p className="muted text-sm">Keine offenen Übergaben.</p>
        ) : (
          <ul className="space-y-3">
            {openIncoming.map((h) => (
              <li key={h.id} className="border rounded-md p-3" style={{ borderColor: "var(--border)" }}>
                <div className="flex flex-wrap gap-2 items-baseline">
                  <strong>{h.responsibility}</strong>
                  <Status label={handoverStatusLabel[h.status] ?? h.status} />
                  <span className="muted text-sm">von {h.senderName} · Termin {fmtDate(h.dueDate)}</span>
                </div>
                <p className="text-sm mt-1">{h.context}</p>
                <dl className="text-sm mt-2 grid sm:grid-cols-2 gap-x-6 gap-y-1">
                  <div><dt className="muted">Belegt</dt><dd>{h.proven ?? "–"}</dd></div>
                  <div><dt className="muted">Offen</dt><dd>{h.open ?? "–"}</dd></div>
                  <div><dt className="muted">Darf verwendet werden</dt><dd>{h.allowedUse ?? "–"}</dd></div>
                  <div><dt className="muted">Rückmeldung über</dt><dd>{h.feedbackChannel ?? "–"}</dd></div>
                </dl>
                {h.setupId && <p className="text-sm mt-1"><Link href={`/setups/${h.setupId}`}>Zum Setup</Link></p>}
                <form action={respondHandoverAction} className="mt-3 flex flex-wrap gap-2 items-end">
                  <input type="hidden" name="handoverId" value={h.id} />
                  <input type="hidden" name="version" value={h.version} />
                  <input type="hidden" name="back" value={back} />
                  <div className="grow min-w-60">
                    <label className="label" htmlFor={`note-${h.id}`}>Rückfrage / Begründung (bei Rückgabe erforderlich)</label>
                    <input id={`note-${h.id}`} name="responseNote" className="input" />
                  </div>
                  <button className="btn btn-small" type="submit" name="decision" value="ANNEHMEN">Annehmen</button>
                  <button className="btn btn-secondary btn-small" type="submit" name="decision" value="ZURUECKGEBEN">Zurückgeben</button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2 className="font-semibold mb-2">Meine offenen Aktionen ({actions.length})</h2>
        {actions.length === 0 ? (
          <p className="muted text-sm">Keine offenen Aktionen.</p>
        ) : (
          <table className="list">
            <thead><tr><th>Aktion</th><th>Setup</th><th>Status</th><th>Fällig</th><th>Nächster Schritt</th></tr></thead>
            <tbody>
              {actions.map((a) => (
                <tr key={a.id}>
                  <td><div>{a.title}</div>{a.agreement && <div className="muted text-sm">{a.agreement}</div>}</td>
                  <td>{a.setupId ? <Link href={`/setups/${a.setupId}`}>{a.setupName}</Link> : "–"}</td>
                  <td><Status label={actionStatusLabel[a.status] ?? a.status} /></td>
                  <td>{fmtDate(a.dueDate)}</td>
                  <td>
                    <form action={changeActionStatusAction} className="flex flex-wrap gap-1 items-end">
                      <input type="hidden" name="actionId" value={a.id} />
                      <input type="hidden" name="version" value={a.version} />
                      <input type="hidden" name="back" value={back} />
                      <input name="result" className="input" style={{ width: "12rem" }} placeholder="Ergebnis / Blocker" aria-label="Ergebnis oder Blocker" />
                      {a.status === "VORGESCHLAGEN" && <button className="btn btn-small" name="status" value="ANGENOMMEN">Annehmen</button>}
                      {(a.status === "ANGENOMMEN" || a.status === "BLOCKIERT") && <button className="btn btn-secondary btn-small" name="status" value="IN_ARBEIT">In Arbeit</button>}
                      {a.status !== "VORGESCHLAGEN" && <button className="btn btn-small" name="status" value="ERLEDIGT">Erledigt</button>}
                      {(a.status === "ANGENOMMEN" || a.status === "IN_ARBEIT") && <button className="btn btn-secondary btn-small" name="status" value="BLOCKIERT">Blockiert</button>}
                      <button className="btn btn-secondary btn-small" name="status" value="VERWORFEN">Verwerfen</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2 className="font-semibold mb-2">Meine Setups ({setups.length})</h2>
        {setups.length === 0 ? (
          <p className="muted text-sm">
            Noch keine Setups. <Link href="/kunden">Zu den Kunden</Link>, um ein Setup anzulegen.
          </p>
        ) : (
          <table className="list">
            <thead><tr><th>Setup</th><th>Kunde</th><th>Status</th><th>BD</th><th>Zuletzt geändert</th></tr></thead>
            <tbody>
              {setups.map((s) => (
                <tr key={s.id}>
                  <td><Link href={`/setups/${s.id}`}>{s.name}</Link></td>
                  <td>{s.accountName}</td>
                  <td><Status label={setupStatusLabel[s.status] ?? s.status} /></td>
                  <td>{s.bdUserId ? "zugeordnet" : <Status label="Zuordnung offen" />}</td>
                  <td>{fmtDate(s.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {outgoing.length > 0 && (
        <section className="card">
          <h2 className="font-semibold mb-2">Von mir angefragte Übergaben</h2>
          <ul className="text-sm space-y-1">
            {outgoing.map((h) => (
              <li key={h.id}>
                {h.responsibility} → {h.receiverName} · <Status label={handoverStatusLabel[h.status] ?? h.status} />
                {h.status === "ANGENOMMEN" && h.setupId && <> · <Link href={`/setups/${h.setupId}`}>Ergebnis im Setup dokumentieren</Link></>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <h2 className="font-semibold mb-1">Vorschläge</h2>
        <p className="muted text-sm">KI-Anbieter ist deaktiviert. Es werden keine automatischen Vorschläge erzeugt; manuelle Dokumentation funktioniert vollständig (Briefing 17.5).</p>
      </section>
    </div>
  );
}
