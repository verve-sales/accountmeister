import Link from "next/link";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { getCurrentActor, } from "@/modules/identity/session";
import { hasRole } from "@/modules/identity/actor";
import { buildPortfolio, listGoals, listLeadershipReviews, listMySupportRequests } from "@/modules/leadership/service";
import { listVisibleAccounts } from "@/modules/accounts/service";
import { Feedback, type SearchParams } from "@/components/Feedback";
import { Status } from "@/components/Status";
import { fmtDate, fmtDateTime, goalStatusLabel, reviewStatusLabel, reviewTypeLabel, supportStatusLabel } from "@/lib/labels";
import { createGoalAction, createLeadershipReviewAction, respondSupportRequestAction } from "../actions";

export default async function ZielePage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  const isLeader = hasRole(actor, "PRINCIPAL") || hasRole(actor, "CEO");
  const [goals, reviews, support, accounts, users] = await Promise.all([
    listGoals(actor),
    listLeadershipReviews(actor),
    listMySupportRequests(actor),
    listVisibleAccounts(actor),
    db.query.users.findMany({ where: eq(schema.users.status, "ACTIVE"), orderBy: (u, { asc }) => [asc(u.displayName)] }),
  ]);
  let portfolio: Awaited<ReturnType<typeof buildPortfolio>> | null = null;
  if (isLeader) portfolio = await buildPortfolio(actor);
  const openSupport = support.filter((s) => s.status === "ANGEFRAGT" || s.status === "ANGENOMMEN");
  const back = "/ziele";

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Ziele & Portfolio</h1>
      <Feedback params={params} />

      {portfolio && (
        <section className="card">
          <h2 className="font-semibold mb-2">Portfolio ({portfolio.entries.length} Kunden)</h2>
          <p className="muted text-sm mb-2">{portfolio.note}</p>
          <table className="list">
            <thead><tr><th>Kunde</th><th>BD</th><th>Setups</th><th>Offene Hinweise</th><th>Offene Fragen</th><th>Zugangslücken</th><th>Prioritäten (vereinbart / vorgeschlagen)</th><th>Aktionen (offen / blockiert)</th><th>Unterstützung offen</th><th>Letztes bestätigtes Weekly</th></tr></thead>
            <tbody>
              {portfolio.entries.map((e) => (
                <tr key={e.accountId}>
                  <td><Link href={`/kunden/${e.accountId}`}>{e.accountName}</Link></td>
                  <td className="text-sm">{e.responsibleBd ?? <Status label="offen" />}</td>
                  <td>{e.setups}{e.setupsWithoutWeekly > 0 && <div className="muted text-sm">{e.setupsWithoutWeekly} ohne Weekly</div>}</td>
                  <td>{e.openChanges}</td>
                  <td>{e.openQuestions}</td>
                  <td>{e.accessGaps}{e.unprovenRelationships > 0 && <div className="muted text-sm">{e.unprovenRelationships} Beziehung(en) ohne Beleg</div>}</td>
                  <td>{e.agreedPriorities} / {e.proposedPriorities}</td>
                  <td>{e.openActions} / {e.blockedActions}</td>
                  <td>{e.openSupport}</td>
                  <td className="text-sm">{e.lastConfirmedWeekly ? fmtDateTime(e.lastConfirmedWeekly) : <span className="muted">–</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="card">
        <h2 className="font-semibold mb-2">Unterstützungsaufträge ({openSupport.length} offen)</h2>
        {openSupport.length === 0 ? <p className="muted text-sm">Keine offenen Unterstützungsaufträge.</p> : (
          <ul className="space-y-2">
            {openSupport.map((s) => (
              <li key={s.id} className="border rounded-md p-3 text-sm" style={{ borderColor: "var(--border)" }}>
                <div className="flex flex-wrap gap-2 items-baseline"><strong>{s.task}</strong><Status label={supportStatusLabel[s.status] ?? s.status} /><span className="muted">{s.requesterName} → {s.addresseeName}{s.setupName && <> · <Link href={`/setups/${s.setupId}`}>{s.setupName}</Link></>}{s.dueDate && ` · bis ${fmtDate(s.dueDate)}`}</span></div>
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
        )}
        <p className="muted text-sm mt-2">Ein Unterstützungsauftrag ist begrenzt und konkret; die operative Fallverantwortung bleibt beim BD. Anfragen erfolgen aus dem Setup.</p>
      </section>

      <section className="card">
        <h2 className="font-semibold mb-2">Ziele ({goals.length})</h2>
        {goals.length === 0 ? <p className="muted text-sm">Noch keine Ziele. Ziele vereinbaren CEO und Principal im Zielgespräch.</p> : (
          <table className="list">
            <thead><tr><th>Ziel</th><th>Verantwortlich</th><th>Zeitraum</th><th>Status</th><th>Zielwert</th><th>Beiträge</th></tr></thead>
            <tbody>
              {goals.map((g) => (
                <tr key={g.id}>
                  <td><Link href={`/ziele/${g.id}`}>{g.title}</Link><div className="muted text-sm">{g.current?.desiredOutcome}</div></td>
                  <td className="text-sm">{g.ownerName}</td>
                  <td className="text-sm">{g.current?.periodFrom ? fmtDate(g.current.periodFrom) : "–"} – {g.current?.periodTo ? fmtDate(g.current.periodTo) : "–"}</td>
                  <td><Status label={goalStatusLabel[g.status] ?? g.status} />{g.agreedByNames.length > 0 && g.status !== "VEREINBART" && <div className="muted text-sm">Zustimmung: {g.agreedByNames.join(", ")}</div>}</td>
                  <td className="text-sm">{g.current?.targetValue ?? <span className="muted">kein Zielwert vereinbart</span>}</td>
                  <td className="text-sm">{g.contributions.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {isLeader && (
          <details className="mt-3">
            <summary>Ziel anlegen (Entwurf)</summary>
            <form action={createGoalAction} className="mt-2 grid sm:grid-cols-2 gap-3">
              <div><label className="label" htmlFor="gTitle">Titel</label><input id="gTitle" name="title" className="input" required minLength={3} /></div>
              <div>
                <label className="label" htmlFor="gOwner">Verantwortlich</label>
                <select id="gOwner" name="ownerUserId" className="select" defaultValue={actor.userId}>{users.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}</select>
              </div>
              <div className="sm:col-span-2"><label className="label" htmlFor="gOutcome">Gewünschtes Ergebnis</label><textarea id="gOutcome" name="desiredOutcome" className="textarea" required minLength={5} /></div>
              <div><label className="label" htmlFor="gScope">Geltungsbereich</label><input id="gScope" name="scope" className="input" /></div>
              <div>
                <label className="label" htmlFor="gAccount">Kundenbezug (optional)</label>
                <select id="gAccount" name="accountId" className="select" defaultValue=""><option value="">–</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
              </div>
              <div><label className="label" htmlFor="gFrom">Zeitraum von</label><input id="gFrom" name="periodFrom" type="date" className="input" /></div>
              <div><label className="label" htmlFor="gTo">bis</label><input id="gTo" name="periodTo" type="date" className="input" /></div>
              <div className="sm:col-span-2"><label className="label" htmlFor="gCrit">Beobachtbares Erfolgskriterium / Messgröße</label><input id="gCrit" name="successCriterion" className="input" /></div>
              <div><label className="label" htmlFor="gBase">Ausgangslage (mit Quelle; „unbekannt“ ist zulässig)</label><input id="gBase" name="baseline" className="input" /></div>
              <div><label className="label" htmlFor="gTarget">Zielwert – nur, falls tatsächlich vereinbart</label><input id="gTarget" name="targetValue" className="input" placeholder="leer lassen, wenn keiner vereinbart ist" /></div>
              <div><label className="label" htmlFor="gSupport">Benötigte Unterstützung</label><input id="gSupport" name="supportNeeded" className="input" /></div>
              <div><label className="label" htmlFor="gPre">Voraussetzungen (Zeit, Budget, Zugang, Fähigkeiten, Freigaben)</label><input id="gPre" name="prerequisites" className="input" /></div>
              <div className="sm:col-span-2"><button className="btn" type="submit">Ziel anlegen</button></div>
            </form>
          </details>
        )}
      </section>

      <section className="card">
        <h2 className="font-semibold mb-2">Führungs-Reviews ({reviews.length})</h2>
        {reviews.length === 0 ? <p className="muted text-sm">Keine Principal-/BD-Weeklys oder Zielgespräche, an denen Sie teilnehmen.</p> : (
          <table className="list">
            <thead><tr><th>Review</th><th>Art</th><th>Termin</th><th>Status</th></tr></thead>
            <tbody>{reviews.map((r) => <tr key={r.id}><td><Link href={`/fuehrung/${r.id}`}>{r.title}</Link></td><td className="text-sm">{reviewTypeLabel[r.type]}</td><td>{fmtDate(r.scheduledFor)}</td><td><Status label={reviewStatusLabel[r.status] ?? r.status} /></td></tr>)}</tbody>
          </table>
        )}
        {(isLeader || hasRole(actor, "BD")) && (
          <details className="mt-3">
            <summary>Review anlegen</summary>
            <form action={createLeadershipReviewAction} className="mt-2 grid sm:grid-cols-2 gap-3">
              <div>
                <label className="label" htmlFor="rType">Art</label>
                <select id="rType" name="type" className="select" defaultValue="PRINCIPAL_BD_WEEKLY">
                  <option value="PRINCIPAL_BD_WEEKLY">Principal-/BD-Weekly</option>
                  {isLeader && <option value="CEO_PRINCIPAL_ZIELGESPRAECH">CEO-/Principal-Zielgespräch</option>}
                </select>
              </div>
              <div><label className="label" htmlFor="rDate">Termin</label><input id="rDate" name="scheduledFor" type="date" className="input" required /></div>
              <div className="sm:col-span-2"><label className="label" htmlFor="rTitle">Titel (optional)</label><input id="rTitle" name="title" className="input" /></div>
              <fieldset className="sm:col-span-2">
                <legend className="label">Teilnehmende</legend>
                <div className="flex flex-wrap gap-3 text-sm">{users.filter((u) => u.id !== actor.userId).map((u) => <label key={u.id} className="flex items-center gap-1"><input type="checkbox" name="participantIds" value={u.id} /> {u.displayName}</label>)}</div>
              </fieldset>
              <div className="sm:col-span-2"><button className="btn" type="submit">Review anlegen</button></div>
            </form>
          </details>
        )}
      </section>
    </div>
  );
}
