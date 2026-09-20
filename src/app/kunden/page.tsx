import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { listVisibleAccounts, getUsersByIds } from "@/modules/accounts/service";
import { canCreateAccount } from "@/modules/identity/authz";
import { Feedback, type SearchParams } from "@/components/Feedback";
import { Status } from "@/components/Status";
import { createAccountAction, startInterviewAction } from "../actions";
import { getProviderStatus } from "@/modules/suggestions/service";
import { listMyIntakes } from "@/modules/intake/service";
import { accountStatusLabel, orgTypeLabel } from "@/lib/labels";
import { db, schema } from "@/db/client";
import { eq } from "drizzle-orm";

export default async function KundenPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  const accounts = await listVisibleAccounts(actor);
  const bdNames = new Map((await getUsersByIds(accounts.map((a) => a.responsibleBdUserId).filter((x): x is string => !!x))).map((u) => [u.id, u.displayName]));
  const bdUsers = canCreateAccount(actor)
    ? await db.select({ id: schema.users.id, displayName: schema.users.displayName }).from(schema.users).innerJoin(schema.roleAssignments, eq(schema.roleAssignments.userId, schema.users.id)).where(eq(schema.roleAssignments.role, "BD"))
    : [];
  const uniqueBd = [...new Map(bdUsers.map((u) => [u.id, u])).values()];
  const ai = getProviderStatus();
  const drafts = canCreateAccount(actor) ? (await listMyIntakes(actor)).filter((p) => p.status === "ENTWURF") : [];
  const active = accounts.filter((a) => a.status !== "ARCHIVED");
  const archived = accounts.filter((a) => a.status === "ARCHIVED");

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Kunden</h1>
      <Feedback params={params} />
      <section className="card">
        {active.length === 0 ? (
          <p className="muted text-sm">Keine Kunden in Ihrem Berechtigungsbereich.</p>
        ) : (
          <table className="list">
            <thead><tr><th>Kunde</th><th>Typ</th><th>Zuständiger BD</th><th>Status</th></tr></thead>
            <tbody>
              {active.map((a) => (
                <tr key={a.id}>
                  <td><Link href={`/kunden/${a.id}`}>{a.name}</Link>{a.isDemo && <span className="muted text-sm"> · Demo</span>}</td>
                  <td>{a.orgType}</td>
                  <td>{a.responsibleBdUserId ? bdNames.get(a.responsibleBdUserId) : <Status label="offen" />}</td>
                  <td><Status label={accountStatusLabel[a.status] ?? a.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {archived.length > 0 && (
        <details className="card">
          <summary>Archivierte Kunden ({archived.length})</summary>
          <table className="list mt-2">
            <tbody>
              {archived.map((a) => (
                <tr key={a.id}>
                  <td><Link href={`/kunden/${a.id}`}>{a.name}</Link></td>
                  <td>{a.orgType}</td>
                  <td><Link href={`/kunden/${a.id}/loeschen`} className="text-sm">wiederherstellen oder löschen</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
      {canCreateAccount(actor) && (
        <section className="card">
          <h2 className="font-semibold mb-1">Kunde aus Dialog, Dokument oder Interview anlegen</h2>
          <p className="muted text-sm mb-2">Ein Gesprächsprotokoll, eine Ausschreibung oder ein Extrakt hochladen – {ai.enabled ? "die KI schlägt Organisation, Setup, Ansprechpartner, Signale und mögliche Bedarfe vor, Sie prüfen und übernehmen." : "der Text wird als Quelle geführt und Sie füllen die Anlage von Hand aus (KI ist deaktiviert)."}</p>
          <div className="flex flex-wrap gap-3 items-center">
            <Link href="/kunden?assistent=interview" className="btn">Mit dem Assistenten erfassen (Dialog)</Link>
            <Link href="/kunden/anlage/neu" className="btn btn-secondary">Dokument hochladen und Vorschlag erzeugen</Link>
            <form action={startInterviewAction}>
              <input type="hidden" name="kind" value="KUNDE_NEU" />
              <button className="btn btn-secondary" type="submit">Interview führen (neuer Kunde)</button>
            </form>
            {drafts.length > 0 && <span className="text-sm">{drafts.length} offene(r) Anlagevorschlag/-vorschläge: {drafts.map((d, i) => <span key={d.id}>{i > 0 ? ", " : ""}<Link href={`/kunden/anlage/${d.id}`}>{(d.payload as { organization?: { name?: string } | null }).organization?.name ?? "ohne Organisation"}</Link></span>)}</span>}
          </div>
        </section>
      )}
      {canCreateAccount(actor) && (
        <details className="card">
          <summary>Kunde von Hand anlegen</summary>
          <form action={createAccountAction} className="mt-3 grid sm:grid-cols-2 gap-3">
            <div><label className="label" htmlFor="name">Name der Organisation</label><input id="name" name="name" className="input" required minLength={2} /></div>
            <div>
              <label className="label" htmlFor="orgType">Organisationstyp</label>
              <select id="orgType" name="orgType" className="select" defaultValue="SONSTIGE">
                {schema.orgTypeEnum.enumValues.map((v) => <option key={v} value={v}>{orgTypeLabel[v] ?? v}</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="responsibleBdUserId">Zuständiger BD (optional)</label>
              <select id="responsibleBdUserId" name="responsibleBdUserId" className="select" defaultValue="">
                <option value="">– noch offen –</option>
                {uniqueBd.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
              </select>
            </div>
            <div className="sm:col-span-2"><button className="btn" type="submit">Anlegen</button></div>
          </form>
        </details>
      )}
    </div>
  );
}
