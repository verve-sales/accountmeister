import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { DomainError } from "@/lib/errors";
import { handoverKindLabel, handoverTask, listHandovers } from "@/modules/conversion/handover";
import { Feedback } from "@/components/Feedback";
import { fmtDate } from "@/lib/labels";

export const metadata = { title: "Übergaben ans Backoffice" };

export default async function UebergabenPage({ searchParams }: { searchParams: Promise<{ fehler?: string; ok?: string; f?: string }> }) {
  const sp = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  const filter = sp.f === "alle" ? "alle" : "offen";
  let rows;
  try {
    rows = await listHandovers(actor, filter);
  } catch (e) {
    if (e instanceof DomainError) notFound();
    throw e;
  }
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-semibold">Übergaben ans Backoffice</h1>
        <span className="muted text-sm">Beauftragt, verlängert, beendet: was in Moco zu tun ist. Quittiert wird mit dem Moco-Projekt.</span>
      </div>
      <Feedback params={sp} />
      <nav className="flex gap-2 text-sm" aria-label="Filter">
        <Link href="/uebergaben" className={`btn btn-small${filter === "offen" ? "" : " btn-secondary"}`}>offen</Link>
        <Link href="/uebergaben?f=alle" className={`btn btn-small${filter === "alle" ? "" : " btn-secondary"}`}>alle</Link>
      </nav>
      <section className="card">
        {rows.length === 0 ? <p className="muted text-sm">{filter === "offen" ? "Keine offenen Übergaben." : "Noch keine Übergaben."}</p> : (
          <table className="list text-sm">
            <thead><tr><th>Was zu tun ist</th><th>Person · Kunde</th><th>Bestellnummer</th><th>Vom</th><th>Stand</th></tr></thead>
            <tbody>
              {rows.map((h) => (
                <tr key={h.id}>
                  <td><Link href={`/uebergaben/${h.id}`}><strong>{handoverTask[h.kind] ?? h.kind}</strong></Link><div className="muted text-xs">{handoverKindLabel[h.kind] ?? h.kind}</div></td>
                  <td>{h.person}<div className="muted text-xs">{h.kunde}</div></td>
                  <td>{h.bestellnummer ?? <span className="muted">–</span>}</td>
                  <td style={{ whiteSpace: "nowrap" }}>{fmtDate(h.createdAt)}</td>
                  <td>{h.status === "QUITTIERT" ? <>quittiert{h.mocoProjectId ? <span className="muted"> · Moco {h.mocoProjectId}</span> : null}</> : <span style={{ color: "#b7791f" }}>offen</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <p className="muted text-xs">Wer zum Backoffice gehört, legt die Verwaltung im Team „Backoffice“ fest. Sales Operations und Geschäftsführung sehen die Übergaben ebenfalls.</p>
    </div>
  );
}
