import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { listMySetups } from "@/modules/setups/service";
import { listMyOpenActions } from "@/modules/actions/service";
import { listMyHandovers } from "@/modules/handovers/service";
import { listReviews } from "@/modules/reviews/service";
import { listMySupportRequests } from "@/modules/leadership/service";
import { listMyOpportunities } from "@/modules/opportunities/service";
import { getProviderStatus, listMySuggestions } from "@/modules/suggestions/service";
import { SuggestionCard } from "@/components/SuggestionCard";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { Feedback, type SearchParams } from "@/components/Feedback";
import { Status } from "@/components/Status";
import { actionStatusLabel, fmtDate, handoverStatusLabel, reviewStatusLabel, setupStatusLabel, supportStatusLabel, opportunityStatusLabel } from "@/lib/labels";
import { changeActionStatusAction, respondHandoverAction, respondSupportRequestAction } from "../actions";

export default async function MeineArbeitPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  const [setups, actions, handovers, reviews, support] = await Promise.all([listMySetups(actor), listMyOpenActions(actor), listMyHandovers(actor), listReviews(actor), listMySupportRequests(actor)]);
  const myOpportunities = await listMyOpportunities(actor);
  const openSupport = support.filter((s) => s.status === "ANGEFRAGT" || s.status === "ANGENOMMEN");
  const nextReviews = [...reviews.open, ...reviews.upcoming].slice(0, 5);
  const ai = getProviderStatus();
  const mySuggestions = ai.enabled ? await listMySuggestions(actor) : [];
  const allUsers = ai.enabled ? await db.query.users.findMany({ where: eq(schema.users.status, "ACTIVE") }) : [];
  const userNames = new Map(allUsers.map((u) => [u.id, u.displayName]));
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

      {openSupport.length > 0 && (
        <section className="card">
          <h2 className="font-semibold mb-2">Unterstützungsaufträge ({openSupport.length} offen)</h2>
          <ul className="space-y-2">
            {openSupport.map((s) => (
              <li key={s.id} className="border rounded-md p-3 text-sm" style={{ borderColor: "var(--border)" }}>
                <div className="flex flex-wrap gap-2 items-baseline"><strong>{s.task}</strong><Status label={supportStatusLabel[s.status] ?? s.status} /><span className="muted">{s.isAddressee ? `von ${s.requesterName}` : `an ${s.addresseeName}`}{s.setupName && <> · <Link href={`/setups/${s.setupId}`}>{s.setupName}</Link></>}{s.dueDate && ` · bis ${fmtDate(s.dueDate)}`}</span></div>
                {s.context && <p className="muted mt-1">{s.context}</p>}
                <form action={respondSupportRequestAction} className="mt-2 flex flex-wrap gap-1 items-end">
                  <input type="hidden" name="requestId" value={s.id} />
                  <input type="hidden" name="version" value={s.version} />
                  <input type="hidden" name="back" value={back} />
                  <input name="note" className="input" style={{ width: "18rem" }} placeholder="Ergebnis / Begründung" aria-label="Ergebnis oder Begründung" />
                  {s.isAddressee && s.status === "ANGEFRAGT" && <button className="btn btn-small" name="decision" value="ANNEHMEN">Annehmen</button>}
                  {s.isAddressee && s.status === "ANGENOMMEN" && <button className="btn btn-small" name="decision" value="ERLEDIGEN">Ergebnis melden</button>}
                  {s.isAddressee && <button className="btn btn-secondary btn-small" name="decision" value="ZURUECKGEBEN">Zurückgeben</button>}
                  {s.isRequester && s.status === "ANGEFRAGT" && <button className="btn btn-secondary btn-small" name="decision" value="ZURUECKZIEHEN">Zurückziehen</button>}
                </form>
              </li>
            ))}
          </ul>
        </section>
      )}

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

      {myOpportunities.length > 0 && (
        <section className="card">
          <h2 className="font-semibold mb-2">Meine offenen Bedarfe ({myOpportunities.length})</h2>
          <table className="list">
            <thead><tr><th>Bedarf</th><th>Kunde</th><th>Status</th><th>Geändert</th></tr></thead>
            <tbody>{myOpportunities.map((o) => <tr key={o.id}><td><Link href={`/bedarfe/${o.id}`}>{o.title}</Link>{o.fastTrack && <span className="muted text-sm"> · direkte Anfrage</span>}</td><td>{o.accountName}</td><td><Status label={opportunityStatusLabel[o.status] ?? o.status} /></td><td>{fmtDate(o.updatedAt)}</td></tr>)}</tbody>
          </table>
        </section>
      )}

      <section className="card">
        <h2 className="font-semibold mb-2">Nächste Weeklys ({nextReviews.length})</h2>
        {nextReviews.length === 0 ? <p className="muted text-sm">Keine anstehenden Weeklys. <Link href="/weeklys">Weekly anlegen</Link>.</p> : (
          <ul className="text-sm space-y-1">
            {nextReviews.map((r) => <li key={r.id}><Link href={`/weeklys/${r.id}`}>{r.title}</Link> · {fmtDate(r.scheduledFor)} · <Status label={reviewStatusLabel[r.status] ?? r.status} /></li>)}
          </ul>
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
        <h2 className="font-semibold mb-1">Vorschläge ({mySuggestions.length})</h2>
        {!ai.enabled ? (
          <p className="muted text-sm">KI-Anbieter ist deaktiviert. Es werden keine automatischen Vorschläge erzeugt; manuelle Dokumentation funktioniert vollständig (Briefing 17.5).</p>
        ) : mySuggestions.length === 0 ? (
          <p className="muted text-sm">Keine offenen Vorschläge in Ihren Setups. Anbieter: {ai.description}</p>
        ) : (
          <ul className="space-y-3">{mySuggestions.map((x) => <SuggestionCard key={x.id} s={x} ownerName={x.proposedOwnerUserId ? userNames.get(x.proposedOwnerUserId) ?? null : null} canDecide back={back} users={allUsers} />)}</ul>
        )}
      </section>
    </div>
  );
}
