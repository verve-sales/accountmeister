import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { getConfig } from "@/lib/config";
import { engagementFilterValues, engagementStatusLabel, listEngagements, type EngagementFilter } from "@/modules/engagements/service";
import { renewalStatusLabel } from "@/modules/engagements/care";
import { Feedback } from "@/components/Feedback";
import { fmtDate } from "@/lib/labels";

const FILTERS: { key: EngagementFilter; label: string }[] = [
  { key: "alle", label: "alle" },
  { key: "aktiv", label: "aktiv" },
  { key: "betreuung", label: "meine Betreuung" },
  { key: "vertrag_offen", label: "Vertragslage offen" },
  { key: "enden_30", label: "enden ≤ 30 Tage" },
  { key: "enden_60", label: "≤ 60" },
  { key: "enden_90", label: "≤ 90" },
  { key: "checkin_ueberfaellig", label: "Check-in überfällig" },
  { key: "abgeschlossen", label: "abgeschlossen" },
];
const RED = "#c0392b";

export default async function EinsaetzePage({ searchParams }: { searchParams: Promise<{ fehler?: string; ok?: string; f?: string }> }) {
  if (getConfig().FEATURE_BESETZUNG !== "true") notFound();
  const sp = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  const filter = (engagementFilterValues as readonly string[]).includes(sp.f ?? "") ? (sp.f as EngagementFilter) : "alle";
  const { items, counts } = await listEngagements(actor, filter);
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-semibold">Einsätze</h1>
        <span className="muted text-sm">Einsatzakten aus bestätigten Auswahlen: Betreuung, Vertragslage, Konditionen, Check-ins, Verlängerung. Stundenzettel bleiben in Moco.</span>
        <Link href="/besetzung" className="text-sm ml-auto">Besetzungen</Link>
      </div>
      <Feedback params={sp} />
      <nav aria-label="Filter" className="flex flex-wrap gap-2 text-sm">
        {FILTERS.map((f) => (
          <Link key={f.key} href={`/einsaetze?f=${f.key}`} className={`btn btn-small${filter === f.key ? "" : " btn-secondary"}`} aria-current={filter === f.key ? "page" : undefined}>
            {f.label} ({counts[f.key]})
          </Link>
        ))}
      </nav>
      <section className="card">
        {items.length === 0 ? (
          <p className="muted text-sm">Keine Einsätze in diesem Filter. Einsätze entstehen mit der bestätigten Auswahl an einer Position.</p>
        ) : (
          <ul className="space-y-2">
            {items.map((e) => (
              <li key={e.id} className="text-sm" style={{ borderLeft: `3px solid ${e.checkinOverdue || (e.daysToEnd !== null && e.daysToEnd <= 30 && e.status === "AKTIV") ? RED : e.status === "AKTIV" ? "#2f7d32" : "var(--border)"}`, paddingLeft: ".6rem" }}>
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <Link href={`/einsaetze/${e.id}`}><strong>{e.title}</strong></Link>
                  <span className="status">{engagementStatusLabel[e.status] ?? e.status}</span>
                  <span className="muted text-xs">{e.accountName} · BD {e.bdName}</span>
                </div>
                <div className="muted text-xs">
                  {e.plannedStart ? `Start ${fmtDate(e.actualStart ?? e.plannedStart)}` : ""}{e.plannedEnd ? ` · Ende ${fmtDate(e.plannedEnd)}${e.daysToEnd !== null ? ` (${e.daysToEnd} Tage)` : ""}` : " · Ende offen"}
                  {" · Vertragslage: "}{e.procurement.complete === true ? "vollständig" : e.procurementException ? "Ausnahme" : e.procurement.complete === false ? `${e.procurement.required.filter((r) => r.ok).length}/${e.procurement.required.length}` : "kein Profil"}
                  {e.careNames.length ? ` · Betreuung: ${e.careNames.join(", ")}` : " · Betreuung offen"}
                  {e.nextCheckin ? <span style={e.checkinOverdue ? { color: RED, fontWeight: 600 } : undefined}> · Check-in {fmtDate(e.nextCheckin)}{e.checkinOverdue ? " (überfällig)" : ""}</span> : ""}
                  {e.renewalStatus ? ` · Verlängerung: ${renewalStatusLabel[e.renewalStatus] ?? e.renewalStatus}` : ""}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
