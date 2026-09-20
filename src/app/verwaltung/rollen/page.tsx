import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { hasRole } from "@/modules/identity/actor";
import { groupByFamily, listRoles, roleFamilyLabel, roleFamilyValues } from "@/modules/roles/catalog";
import { Feedback, type SearchParams } from "@/components/Feedback";
import { addRoleAction, setRoleActiveAction } from "../../actions";

/** Verwaltung → Rollen (E-045): der Verve-Standardrollenkatalog, auf den Chancen zeigen. */
export default async function RollenPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  if (!hasRole(actor, "ADMIN")) redirect("/start");
  const roles = await listRoles(actor.workspaceId, { includeInactive: true });
  const groups = groupByFamily(roles);
  return (
    <div className="space-y-6">
      <p className="text-sm"><Link href="/verwaltung">Verwaltung</Link> › Rollen</p>
      <h1 className="text-2xl font-semibold">Standardrollen</h1>
      <p className="muted text-sm">Auf diese Rollen zeigen Chancen (Verve-Experte, Freelancer-Experte, Ausschreibung). Deaktivierte Rollen bleiben an bestehenden Chancen erhalten, sind aber nicht mehr wählbar.</p>
      <Feedback params={params} />
      <div className="grid lg:grid-cols-2 gap-4">
        {groups.map((g) => (
          <section key={g.family} className="card">
            <h2 className="font-semibold mb-2">{g.label}</h2>
            <ul className="space-y-1 text-sm">
              {g.roles.map((r) => (
                <li key={r.id} className="flex items-baseline gap-2">
                  <span style={{ opacity: r.active ? 1 : 0.5 }}>{r.name}{r.description ? <span className="muted"> – {r.description}</span> : null}</span>
                  <form action={setRoleActiveAction} className="ml-auto">
                    <input type="hidden" name="roleId" value={r.id} />
                    <input type="hidden" name="active" value={r.active ? "false" : "true"} />
                    <button className="btn btn-secondary btn-small" type="submit">{r.active ? "Deaktivieren" : "Aktivieren"}</button>
                  </form>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <section className="card">
        <h2 className="font-semibold mb-2">Rolle ergänzen</h2>
        <form action={addRoleAction} className="grid sm:grid-cols-3 gap-3">
          <div>
            <label className="label" htmlFor="family">Rollenfamilie</label>
            <select id="family" name="family" className="select" defaultValue="DELIVERY_MANAGEMENT">{roleFamilyValues.map((f) => <option key={f} value={f}>{roleFamilyLabel[f]}</option>)}</select>
          </div>
          <div><label className="label" htmlFor="name">Rollenname</label><input id="name" name="name" className="input" required minLength={2} maxLength={120} /></div>
          <div><label className="label" htmlFor="description">Beschreibung (optional)</label><input id="description" name="description" className="input" maxLength={400} /></div>
          <div className="sm:col-span-3"><button className="btn" type="submit">Rolle ergänzen</button></div>
        </form>
      </section>
    </div>
  );
}
