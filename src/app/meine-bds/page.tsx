import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { buildPortfolio, canBrowsePortfolio } from "@/modules/portfolio/service";
import { HealthBadge } from "@/components/HealthBadge";
import { Feedback, type SearchParams } from "@/components/Feedback";
import { fmtDate } from "@/lib/labels";

const RED = "#c0392b";

export default async function MeineBdsPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  if (!canBrowsePortfolio(actor)) notFound();
  const { byBd, rows } = await buildPortfolio(actor);
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-semibold">Meine BDs</h1>
        <span className="muted text-sm">{rows.length} Kunden bei {byBd.length} BDs – eine Zeile je Kunde, Klick öffnet die Kurzfassung zum Durchgehen.</span>
      </div>
      <Feedback params={sp} />
      {byBd.length === 0 && <p className="card muted text-sm">Keine zugeordneten Kunden.</p>}
      {byBd.map((g) => (
        <section key={g.bdName} className="card">
          <h2 className="font-semibold mb-2">{g.bdName} <span className="muted text-sm font-normal">· {g.rows.length} Kunden · {g.rows.reduce((n, r) => n + r.runningEngagements, 0)} laufende Einsätze · {g.rows.reduce((n, r) => n + r.chancesInWork, 0)} Chancen in Arbeit</span></h2>
          <table className="list text-sm">
            <thead><tr><th>Kunde</th><th>Team</th><th>Einsätze</th><th>Nächstes Ende</th><th>Chancen</th><th>Letzter Kontakt</th><th>Offen</th><th>Ampel</th></tr></thead>
            <tbody>
              {g.rows.map((r) => (
                <tr key={r.accountId}>
                  <td><Link href={`/meine-bds/${r.accountId}`}><strong>{r.accountName}</strong></Link><div className="muted text-xs">{r.nextStep}</div></td>
                  <td className="text-xs">{r.ankerNames.length ? `Anker ${r.ankerNames.join(", ")}` : <span style={{ color: "#b7791f" }}>kein Anker</span>}</td>
                  <td style={{ fontVariantNumeric: "tabular-nums" }}>{r.runningEngagements}</td>
                  <td className="text-xs" style={{ whiteSpace: "nowrap" }}>{r.nextEnd ? <>{fmtDate(r.nextEnd)}{r.nextEndPerson ? <div className="muted">{r.nextEndPerson}</div> : null}</> : <span className="muted">–</span>}</td>
                  <td className="text-xs">{r.chancesInWork} in Arbeit{r.chancesAnticipated ? <span className="muted"> · {r.chancesAnticipated} antizipiert</span> : null}</td>
                  <td className="text-xs" style={r.daysSinceActivity > 14 ? { color: RED, fontWeight: 600 } : undefined}>{r.daysSinceActivity >= 999 ? "nie" : `vor ${r.daysSinceActivity} Tagen`}</td>
                  <td className="text-xs">{r.openDecisions ? <span style={{ color: "#b7791f", fontWeight: 600 }}>{r.openDecisions} Verlängerung(en)</span> : <span className="muted">–</span>}</td>
                  <td><HealthBadge score={r.health.score} level={r.health.level} coverage={r.health.coverage} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
      <p className="muted text-xs">Letzter Kontakt = jüngstes dokumentiertes Ereignis (Weekly, Beobachtung, Aktion, Kontakt, Check-in). Zählungen, keine Bewertungen von Personen.</p>
    </div>
  );
}
