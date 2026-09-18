import Link from "next/link";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { getCurrentActor } from "@/modules/identity/session";
import { listReviews } from "@/modules/reviews/service";
import { listMySetups } from "@/modules/setups/service";
import { Feedback } from "@/components/Feedback";
import { Status } from "@/components/Status";
import { fmtDate, reviewStatusLabel } from "@/lib/labels";
import { createReviewAction } from "../actions";

export default async function WeeklysPage({ searchParams }: { searchParams: Promise<{ fehler?: string; ok?: string; setup?: string }> }) {
  const params = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  const [lists, mySetups, users] = await Promise.all([listReviews(actor), listMySetups(actor), db.query.users.findMany({ where: eq(schema.users.status, "ACTIVE"), orderBy: (u, { asc }) => [asc(u.displayName)] })]);
  const preselected = params.setup ?? "";
  const nextMonday = (() => {
    const d = new Date();
    const day = d.getDay();
    d.setDate(d.getDate() + ((8 - day) % 7 || 7));
    return d.toISOString().slice(0, 10);
  })();

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Weeklys</h1>
      <Feedback params={params} />
      <section className="card">
        <h2 className="font-semibold mb-2">Anstehend ({lists.upcoming.length})</h2>
        {lists.upcoming.length === 0 ? <p className="muted text-sm">Keine anstehenden Weeklys in Ihrem Berechtigungsbereich.</p> : <ReviewTable rows={lists.upcoming} />}
      </section>
      {lists.open.length > 0 && (
        <section className="card">
          <h2 className="font-semibold mb-2">Noch nicht bestätigt ({lists.open.length})</h2>
          <ReviewTable rows={lists.open} />
        </section>
      )}
      <section className="card">
        <h2 className="font-semibold mb-2">Bestätigt ({lists.past.length})</h2>
        {lists.past.length === 0 ? <p className="muted text-sm">Noch kein bestätigtes Weekly.</p> : <ReviewTable rows={lists.past} />}
      </section>
      {mySetups.length > 0 && (
        <details className="card" open={!!preselected}>
          <summary>Weekly anlegen</summary>
          <form action={createReviewAction} className="mt-3 grid sm:grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="setupId">Setup</label>
              <select id="setupId" name="setupId" className="select" required defaultValue={preselected}>
                <option value="" disabled>Bitte wählen …</option>
                {mySetups.map((s) => <option key={s.id} value={s.id}>{s.accountName} – {s.name}</option>)}
              </select>
            </div>
            <div><label className="label" htmlFor="scheduledFor">Termin</label><input id="scheduledFor" name="scheduledFor" type="date" className="input" required defaultValue={nextMonday} /></div>
            <div className="sm:col-span-2"><label className="label" htmlFor="title">Titel (optional)</label><input id="title" name="title" className="input" placeholder="z. B. Weekly Plattformteam KW 40" /></div>
            <fieldset className="sm:col-span-2">
              <legend className="label">Teilnehmende (leer = alle Setup-Beteiligten)</legend>
              <div className="flex flex-wrap gap-3 text-sm">
                {users.map((u) => (
                  <label key={u.id} className="flex items-center gap-1"><input type="checkbox" name="participantIds" value={u.id} /> {u.displayName}</label>
                ))}
              </div>
            </fieldset>
            <div className="sm:col-span-2"><button className="btn" type="submit">Weekly anlegen</button></div>
          </form>
        </details>
      )}
      <p className="muted text-sm">Principal-/BD-Weeklys und CEO-/Principal-Zielgespräche folgen in Etappe 4.</p>
    </div>
  );
}

type ReviewRow = Awaited<ReturnType<typeof listReviews>>["upcoming"][number];

function ReviewTable({ rows }: { rows: ReviewRow[] }) {
  return (
    <table className="list">
      <thead><tr><th>Weekly</th><th>Setup</th><th>Kunde</th><th>Termin</th><th>Status</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td><Link href={`/weeklys/${r.id}`}>{r.title}</Link></td>
            <td>{r.setupId && <Link href={`/setups/${r.setupId}`}>{r.setupName}</Link>}</td>
            <td>{r.accountName}</td>
            <td>{fmtDate(r.scheduledFor)}</td>
            <td><Status label={reviewStatusLabel[r.status] ?? r.status} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
