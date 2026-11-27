import Link from "next/link";
import { Segmented } from "@/components/ViewSwitch";
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
      <Segmented label="Ansicht" items={[{ href: "/uebergaben", label: "offen", active: filter === "offen" }, { href: "/uebergaben?f=alle", label: "alle", active: filter === "alle" }]} />
      <section className="card">
        {rows.length === 0 ? <p className="empty">{filter === "offen" ? "Keine offenen Übergaben." : "Noch keine Übergaben."}</p> : (
          <div className="table-wrap"><table className="list text-sm">
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
          </table></div>
        )}
      </section>
      <p className="muted text-xs">Wer zum Backoffice gehört, legt die Verwaltung im Team „Backoffice“ fest. Sales Operations und Geschäftsführung sehen die Übergaben ebenfalls.</p>
    </div>
  );
}
