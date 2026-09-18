import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { listVisibleAccounts, getUsersByIds } from "@/modules/accounts/service";
import { canCreateAccount } from "@/modules/identity/authz";
import { Feedback, type SearchParams } from "@/components/Feedback";
import { Status } from "@/components/Status";
import { createAccountAction } from "../actions";
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

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Kunden</h1>
      <Feedback params={params} />
      <section className="card">
        {accounts.length === 0 ? (
          <p className="muted text-sm">Keine Kunden in Ihrem Berechtigungsbereich.</p>
        ) : (
          <table className="list">
            <thead><tr><th>Kunde</th><th>Typ</th><th>Zuständiger BD</th><th>Status</th></tr></thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id}>
                  <td><Link href={`/kunden/${a.id}`}>{a.name}</Link>{a.isDemo && <span className="muted text-sm"> · Demo</span>}</td>
                  <td>{a.orgType}</td>
                  <td>{a.responsibleBdUserId ? bdNames.get(a.responsibleBdUserId) : <Status label="offen" />}</td>
                  <td><Status label={a.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {canCreateAccount(actor) && (
        <details className="card">
          <summary>Kunde anlegen</summary>
          <form action={createAccountAction} className="mt-3 grid sm:grid-cols-2 gap-3">
            <div><label className="label" htmlFor="name">Name der Organisation</label><input id="name" name="name" className="input" required minLength={2} /></div>
            <div>
              <label className="label" htmlFor="orgType">Organisationstyp</label>
              <select id="orgType" name="orgType" className="select" defaultValue="SONSTIGE">
                {schema.orgTypeEnum.enumValues.map((v) => <option key={v} value={v}>{v}</option>)}
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
