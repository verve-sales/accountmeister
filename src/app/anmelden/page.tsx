import { redirect } from "next/navigation";
import { getConfig } from "@/lib/config";
import { listDevLoginUsers } from "@/modules/identity/dev-login";
import { getCurrentActor } from "@/modules/identity/session";
import { devLoginAction } from "../actions";
import { Feedback, type SearchParams } from "@/components/Feedback";

export default async function AnmeldenPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  if (await getCurrentActor()) redirect("/meine-arbeit");
  const cfg = getConfig();
  if (cfg.AUTH_MODE !== "development") {
    return (
      <section className="card max-w-lg">
        <h1 className="text-xl font-semibold mb-2">Anmeldung</h1>
        <p className="muted">Die Unternehmensanmeldung (OIDC) ist noch nicht konfiguriert. Entscheidung zum Anbieter steht aus (Briefing 2.3).</p>
      </section>
    );
  }
  const users = await listDevLoginUsers();
  return (
    <section className="card max-w-lg">
      <h1 className="text-xl font-semibold mb-1">Entwicklungsanmeldung</h1>
      <p className="muted mb-4 text-sm">Nur lokal. Wählen Sie eine fiktive Person, um die Anwendung aus ihrer Rollensicht zu nutzen.</p>
      <Feedback params={params} />
      <form action={devLoginAction} className="space-y-3">
        <label className="label" htmlFor="userId">Fiktive Person</label>
        <select id="userId" name="userId" className="select" required defaultValue="">
          <option value="" disabled>Bitte wählen …</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.displayName} – {u.roles.join(", ") || "ohne Rolle"}
            </option>
          ))}
        </select>
        <button className="btn" type="submit">Anmelden</button>
      </form>
    </section>
  );
}
