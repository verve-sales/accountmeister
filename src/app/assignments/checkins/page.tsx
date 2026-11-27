import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { asgCheckins, canUseAssignments } from "@/modules/assignments/service";
import { checkinAction } from "@/app/actions";
import { Feedback, type SearchParams } from "@/components/Feedback";
import { fmtDate } from "@/lib/labels";

export default async function AsgCheckinsPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  if (!(await canUseAssignments(actor))) notFound();
  const rows = await asgCheckins(actor);
  const groups: [string, typeof rows][] = [["Freelancer und Berater:innen", rows.filter((r) => r.side === "FREELANCER")], ["Kunden (führt der BD – hier zur Übersicht)", rows.filter((r) => r.side !== "FREELANCER")]];
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Check-ins</h1>
      <Feedback params={params} />
      {groups.map(([title, list]) => (
        <section className="card" key={title}>
          <h2 className="font-semibold">{title} ({list.length})</h2>
          {list.length === 0 ? <p className="empty">Nichts offen.</p> : (
            <div className="table-wrap"><table className="list text-sm mt-1">
              <thead><tr><th>Person</th><th>Kunde</th><th>Fällig</th><th>Zuständig</th><th>Zuletzt</th><th>Erledigen</th></tr></thead>
              <tbody>
                {list.map((c) => (
                  <tr key={c.id}>
                    <td><Link href={`/einsaetze/${c.engagementId}#checkins`}><strong>{c.person}</strong></Link></td>
                    <td>{c.accountName}</td>
                    <td style={{ whiteSpace: "nowrap", color: c.overdue ? "var(--danger)" : undefined, fontWeight: c.overdue ? 600 : undefined }}>{fmtDate(c.due)}</td>
                    <td>{c.owner}</td>
                    <td className="muted">{c.lastNote ?? "–"}</td>
                    <td>
                      <form action={checkinAction} className="flex flex-wrap gap-1 items-center">
                        <input type="hidden" name="checkinId" value={c.id} /><input type="hidden" name="version" value={c.version} /><input type="hidden" name="action" value="ERLEDIGEN" /><input type="hidden" name="back" value="/assignments/checkins" />
                        <input name="note" className="input" placeholder="Notiz (optional)" style={{ width: "12rem" }} />
                        <button className="mood-btn" data-mood="positiv" type="submit" name="mood" value="POSITIV">positiv</button>
                        <button className="mood-btn" data-mood="mittel" type="submit" name="mood" value="MITTEL">mittel</button>
                        <button className="mood-btn" data-mood="negativ" type="submit" name="mood" value="NEGATIV">negativ</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </section>
      ))}
      <p className="muted text-xs">Ein Klick auf die Stimmung erledigt den Check-in mit heutigem Datum. Ausführlich (Risiken, offene Punkte, Hinweis an den Vertrieb) am Einsatz.</p>
    </div>
  );
}
