import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { getConfig } from "@/lib/config";
import { DomainError } from "@/lib/errors";
import { listFreelancerPool } from "@/modules/staffing/service";
import { Feedback, type SearchParams } from "@/components/Feedback";
import { fmtDate } from "@/lib/labels";

export default async function FreelancerPoolPage({ searchParams }: { searchParams: SearchParams }) {
  if (getConfig().FEATURE_BESETZUNG !== "true") notFound();
  const sp = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  let rows;
  try {
    rows = await listFreelancerPool(actor);
  } catch (e) {
    if (e instanceof DomainError) notFound();
    throw e;
  }
  return (
    <div className="space-y-5">
      <p className="text-sm"><Link href="/besetzung">Besetzungen</Link></p>
      <h1 className="text-2xl font-semibold">Freelancer-Pool (Minimalstamm)</h1>
      <p className="muted text-sm">Nur Stammdaten: Name, erlaubte Kontaktdaten, Firma, Skills, zuletzt bestätigte Verfügbarkeit, externe CV-/Tool-Referenzen. Keine Bank-, Ausweis- oder Steuerdaten. Kandidaturen entstehen an der Position.</p>
      <Feedback params={sp} />
      <section className="card" style={{ overflowX: "auto" }}>
        {rows.length === 0 ? (
          <p className="muted text-sm">Noch keine Freelancer erfasst.</p>
        ) : (
          <table className="list text-sm">
            <thead><tr><th>Name</th><th>Firma</th><th>Skills</th><th>Verfügbarkeit</th><th>Kandidaturen</th><th>ID</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td><Link href={`/besetzung/freelancer/${r.id}`}>{r.displayName}</Link></td>
                  <td>{r.company ?? "–"}</td>
                  <td>{r.skills ?? "–"}</td>
                  <td>{r.availabilityNote ? `${r.availabilityNote} (Stand ${fmtDate(r.availabilityAsOf)})` : "–"}</td>
                  <td>{r.candidacyCount}</td>
                  <td><code className="text-xs">{r.id}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
