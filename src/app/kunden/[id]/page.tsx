import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { getAccount } from "@/modules/accounts/service";
import { listSetupsForAccount } from "@/modules/setups/service";
import { canCreateSetup } from "@/modules/identity/authz";
import { DomainError } from "@/lib/errors";
import { Feedback, type SearchParams } from "@/components/Feedback";
import { Status } from "@/components/Status";
import { fmtDate, setupStatusLabel, visibilityLabel, contributionLabel } from "@/lib/labels";
import { createSetupAction } from "../../actions";
import { listPeopleForAccount } from "@/modules/people/service";
import { relationshipStateLabel } from "@/lib/labels";
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
  const people = await listPeopleForAccount(actor, id);
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
        <h2 className="font-semibold mb-2">Überblick</h2>
        <p className="muted text-sm">Der verdichtete Accountplan (A1) wird in Etappe 2 aus bestätigten Setups und Prioritäten aufgebaut. Bis dahin: Einstieg über die Projektsetups.</p>
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
