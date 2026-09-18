import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { getAccount } from "@/modules/accounts/service";
import { listSetupsForAccount } from "@/modules/setups/service";
import { listOpportunitiesForAccount } from "@/modules/opportunities/service";
import { canCreateSetup } from "@/modules/identity/authz";
import { DomainError } from "@/lib/errors";
import { Feedback, type SearchParams } from "@/components/Feedback";
import { Status } from "@/components/Status";
import { fmtDate, setupStatusLabel, visibilityLabel, contributionLabel, opportunityStatusLabel } from "@/lib/labels";
import { createSetupAction } from "../../actions";
import { listPeopleForAccount } from "@/modules/people/service";
import { relationshipStateLabel, priorityKindLabel, priorityStatusLabel } from "@/lib/labels";
import { buildAccountPlan, canEditAccountPlan, listAccountPlanSnapshots } from "@/modules/accountplan/service";
import { AccountPlanView } from "@/components/AccountPlanView";
import { changePriorityAction, createPriorityAction, saveAccountPlanSnapshotAction } from "../../actions";
import { db, schema } from "@/db/client";
import { eq } from "drizzle-orm";

export default async function KundePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { id } = await params;
  const sp = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  let account;
  try {
    account = await getAccount(actor, id);
  } catch (e) {
    if (e instanceof DomainError) notFound();
    throw e;
  }
  const setups = await listSetupsForAccount(actor, id);
  const opportunities = await listOpportunitiesForAccount(actor, id);
  const people = await listPeopleForAccount(actor, id);
  const [plan, snapshots, mayEditPlan] = await Promise.all([buildAccountPlan(actor, id), listAccountPlanSnapshots(actor, id), canEditAccountPlan(actor, id)]);
  const back = `/kunden/${id}`;
  const mayCreate = canCreateSetup(actor, account);
  const bdUsers = mayCreate
    ? [...new Map((await db.select({ id: schema.users.id, displayName: schema.users.displayName }).from(schema.users).innerJoin(schema.roleAssignments, eq(schema.roleAssignments.userId, schema.users.id)).where(eq(schema.roleAssignments.role, "BD"))).map((u) => [u.id, u])).values()]
    : [];

  return (
    <div className="space-y-6">
      <p className="text-sm"><Link href="/kunden">Kunden</Link> › {account.name}</p>
      <h1 className="text-2xl font-semibold">{account.name}</h1>
      <Feedback params={sp} />

      <section className="card">
        <h2 className="font-semibold mb-2">Überblick – Accountplan</h2>
        <AccountPlanView plan={plan} live>
          {mayEditPlan && (
            <div className="grid lg:grid-cols-2 gap-6 mt-2">
              <details>
                <summary className="text-sm">Vorhaben vorschlagen</summary>
                <form action={createPriorityAction} className="mt-2 grid sm:grid-cols-2 gap-2">
                  <input type="hidden" name="accountId" value={account.id} />
                  <div className="sm:col-span-2"><label className="label" htmlFor="prTitle">Vorhaben</label><input id="prTitle" name="title" className="input" required minLength={3} placeholder="z. B. Testkoordination im Migrationsteam anbieten" /></div>
                  <div>
                    <label className="label" htmlFor="prKind">Art</label>
                    <select id="prKind" name="kind" className="select" defaultValue="AUSWEITEN">{schema.priorityKindEnum.enumValues.map((v) => <option key={v} value={v}>{priorityKindLabel[v]}</option>)}</select>
                  </div>
                  <div>
                    <label className="label" htmlFor="prSetup">Bezug zu Setup (optional)</label>
                    <select id="prSetup" name="setupId" className="select" defaultValue=""><option value="">–</option>{setups.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
                  </div>
                  <div><label className="label" htmlFor="prRank">Rang (1 = höchste)</label><input id="prRank" name="rank" type="number" min={1} max={999} defaultValue={plan.priorities.length + 1} className="input" /></div>
                  <div><label className="label" htmlFor="prGoal">Zielbezug (Text, bis Ziele modelliert sind)</label><input id="prGoal" name="goalReference" className="input" /></div>
                  <div className="sm:col-span-2"><label className="label" htmlFor="prWhy">Begründung</label><input id="prWhy" name="rationale" className="input" /></div>
                  <div className="sm:col-span-2"><label className="label" htmlFor="prPre">Voraussetzungen</label><input id="prPre" name="prerequisites" className="input" placeholder="Zeit, Zugang, Freigaben …" /></div>
                  <div className="sm:col-span-2"><button className="btn btn-small" type="submit">Als Vorschlag aufnehmen</button></div>
                </form>
              </details>
              <details>
                <summary className="text-sm">Priorität ändern (Zustimmung, Zurückstellen, Rang)</summary>
                {plan.priorities.length === 0 ? <p className="muted text-sm mt-2">Noch keine Vorhaben.</p> : (
                  <ul className="mt-2 space-y-2">
                    {plan.priorities.map((p) => (
                      <li key={p.id}>
                        <form action={changePriorityAction} className="flex flex-wrap gap-1 items-end text-sm">
                          <input type="hidden" name="priorityId" value={p.id} />
                          <input type="hidden" name="version" value={p.version} />
                          <input type="hidden" name="back" value={back} />
                          <span className="grow min-w-48">{p.title} <span className="muted">({priorityStatusLabel[p.status]})</span></span>
                          <input name="rank" type="number" min={1} max={999} defaultValue={p.rank} className="input" style={{ width: "4.5rem" }} aria-label="Rang" />
                          <input name="deferredReason" className="input" style={{ width: "12rem" }} placeholder="Grund (bei Zurückstellen)" aria-label="Grund für Zurückstellen" />
                          {(p.status === "VORGESCHLAGEN" || p.status === "ZURUECKGESTELLT") && <button className="btn btn-small" name="status" value="VEREINBART">Zustimmen</button>}
                          {(p.status === "VORGESCHLAGEN" || p.status === "VEREINBART") && <button className="btn btn-secondary btn-small" name="status" value="ZURUECKGESTELLT">Zurückstellen</button>}
                          {p.status === "VEREINBART" && <button className="btn btn-secondary btn-small" name="status" value="ERREICHT">Erreicht</button>}
                          {p.status !== "ERREICHT" && p.status !== "VERWORFEN" && <button className="btn btn-secondary btn-small" name="status" value="VERWORFEN">Verwerfen</button>}
                          <button className="btn btn-secondary btn-small" type="submit">Rang speichern</button>
                        </form>
                      </li>
                    ))}
                  </ul>
                )}
              </details>
            </div>
          )}
        </AccountPlanView>
        <div className="mt-4 border-t pt-3" style={{ borderColor: "var(--border)" }}>
          <h3 className="font-medium mb-1">Gespeicherte Stände ({snapshots.length})</h3>
          {snapshots.length === 0 ? <p className="muted text-sm">Noch kein gespeicherter Review-Stand.</p> : (
            <ul className="text-sm space-y-1">{snapshots.map((s) => <li key={s.id}><Link href={`/kunden/${account.id}/staende/${s.id}`}>{s.title}</Link> · {s.confirmedByName} · {new Date(s.confirmedAt).toLocaleString("de-DE", { timeZone: "Europe/Berlin", dateStyle: "medium", timeStyle: "short" })}{s.note && <span className="muted"> – {s.note}</span>}</li>)}</ul>
          )}
          {mayEditPlan && (
            <form action={saveAccountPlanSnapshotAction} className="mt-2 flex flex-wrap gap-2 items-end">
              <input type="hidden" name="accountId" value={account.id} />
              <div><label className="label" htmlFor="snapTitle">Aktuellen Stand speichern als</label><input id="snapTitle" name="title" className="input" required minLength={3} placeholder="z. B. Kundenreview KW 40" /></div>
              <div className="grow"><label className="label" htmlFor="snapNote">Notiz (optional)</label><input id="snapNote" name="note" className="input" /></div>
              <button className="btn btn-small" type="submit">Stand speichern</button>
            </form>
          )}
        </div>
      </section>

      <section className="card">
        <h2 className="font-semibold mb-2">Projektsetups ({setups.length})</h2>
        {setups.length === 0 ? (
          <p className="muted text-sm">Noch kein Setup. Ein Setup braucht nur Kunde, Namen und einen Kontextsatz – oder bleibt bewusst Entwurf.</p>
        ) : (
          <table className="list">
            <thead><tr><th>Setup</th><th>Status</th><th>Sichtbarkeit</th><th>BD</th><th>Geändert</th></tr></thead>
            <tbody>
              {setups.map((s) => (
                <tr key={s.id}>
                  <td><Link href={`/setups/${s.id}`}>{s.name}</Link>{s.contextNote && <div className="muted text-sm">{s.contextNote}</div>}</td>
                  <td><Status label={setupStatusLabel[s.status] ?? s.status} /></td>
                  <td>{visibilityLabel[s.visibility]}</td>
                  <td>{s.bdUserId ? "zugeordnet" : <Status label="Zuordnung offen" />}</td>
                  <td>{fmtDate(s.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2 className="font-semibold mb-2">Bedarfe ({opportunities.filter((o) => o.status !== "BEENDET").length} offen)</h2>
        <p className="muted text-sm mb-2">Jeder Bedarf hat einen eigenen Zustand; es gibt keinen zusammengefassten Angebots- oder Pipelinestatus je Kunde.</p>
        {opportunities.length === 0 ? <p className="muted text-sm">Noch kein Bedarf erfasst. Bedarfe entstehen im Setup.</p> : (
          <table className="list">
            <thead><tr><th>Bedarf</th><th>Setup</th><th>Status</th><th>Bestätigt</th></tr></thead>
            <tbody>{opportunities.map((o) => <tr key={o.id}><td><Link href={`/bedarfe/${o.id}`}>{o.title}</Link></td><td><Link href={`/setups/${o.setupId}`}>{o.setupName}</Link></td><td><Status label={opportunityStatusLabel[o.status] ?? o.status} /></td><td>{o.confirmedAt ? fmtDate(o.confirmedAt) : "–"}</td></tr>)}</tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2 className="font-semibold mb-2">Personen & Zugang ({people.length})</h2>
        {people.length === 0 ? <p className="muted text-sm">Noch keine Personen erfasst. Personen werden im jeweiligen Setup gepflegt.</p> : (
          <table className="list">
            <thead><tr><th>Person</th><th>Funktion</th><th>Beziehungen (Halter · Stand)</th></tr></thead>
            <tbody>
              {people.map(({ person, currentFunction, relationships }) => (
                <tr key={person.id}>
                  <td>{person.displayName}</td>
                  <td>{currentFunction?.functionTitle ?? <span className="muted">unbekannt</span>}</td>
                  <td className="text-sm">{relationships.length === 0 ? <span className="muted">keine dokumentiert</span> : relationships.map((r) => <div key={r.id}>{r.holderName} · <Status label={relationshipStateLabel[r.state] ?? r.state} /></div>)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {setups.length > 0 && <p className="muted text-sm mt-2">Pflege je Setup: {setups.map((s, i) => <span key={s.id}>{i > 0 && ", "}<Link href={`/setups/${s.id}/personen`}>{s.name}</Link></span>)}</p>}
      </section>

      {mayCreate && (
        <details className="card" open={setups.length === 0}>
          <summary>Setup anlegen</summary>
          <form action={createSetupAction} className="mt-3 grid sm:grid-cols-2 gap-3">
            <input type="hidden" name="accountId" value={account.id} />
            <div className="sm:col-span-2"><label className="label" htmlFor="name">Verständlicher Setup-Name</label><input id="name" name="name" className="input" required minLength={3} placeholder="z. B. Plattformteam" /></div>
            <div className="sm:col-span-2">
              <label className="label" htmlFor="contextNote">Kontextsatz (optional – leer lassen für bewussten Entwurf)</label>
              <textarea id="contextNote" name="contextNote" className="textarea" placeholder="Was läuft hier? Ein Satz genügt." />
            </div>
            <div>
              <label className="label" htmlFor="bdUserId">Zuständiger BD</label>
              <select id="bdUserId" name="bdUserId" className="select" defaultValue="">
                <option value="">– Zuordnung offen (erscheint im Eingang) –</option>
                {bdUsers.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="visibility">Sichtbarkeit</label>
              <select id="visibility" name="visibility" className="select" defaultValue="MITGLIEDER">
                {schema.setupVisibilityEnum.enumValues.map((v) => <option key={v} value={v}>{visibilityLabel[v]}</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="creatorContribution">Mein vereinbarter Beitrag</label>
              <select id="creatorContribution" name="creatorContribution" className="select" defaultValue="ANKER_KONTEXT">
                {schema.membershipContributionEnum.enumValues.map((v) => <option key={v} value={v}>{contributionLabel[v]}</option>)}
              </select>
            </div>
            <div><label className="label" htmlFor="contributionNote">Erläuterung zum Beitrag (sachlich, optional)</label><input id="contributionNote" name="contributionNote" className="input" placeholder="z. B. Kontext beitragen, keine Ansprache neuer Personen" /></div>
            <div className="sm:col-span-2"><button className="btn" type="submit">Setup anlegen</button></div>
          </form>
        </details>
      )}
    </div>
  );
}
