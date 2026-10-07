import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { getConfig } from "@/lib/config";
import { engagementFilterValues, engagementStatusLabel, listEngagements, type EngagementFilter, type MoodMark } from "@/modules/engagements/service";
import { renewalStatusLabel } from "@/modules/engagements/care";
import { Feedback } from "@/components/Feedback";
import { fmtDate } from "@/lib/labels";

const FILTERS: { key: EngagementFilter; label: string }[] = [
  { key: "alle", label: "alle" },
  { key: "aktiv", label: "aktiv" },
  { key: "betreuung", label: "meine Betreuung" },
  { key: "enden_90", label: "enden ≤ 90 Tage" },
  { key: "enden_30", label: "≤ 30" },
  { key: "checkin_ueberfaellig", label: "Check-in überfällig" },
  { key: "vertrag_offen", label: "Unterlagen offen" },
  { key: "abgeschlossen", label: "abgeschlossen" },
];
const RED = "#c0392b";
const MOOD: Record<MoodMark["mood"], { label: string; color: string }> = { POSITIV: { label: "positiv", color: "#2f7d32" }, MITTEL: { label: "mittel", color: "#b7791f" }, NEGATIV: { label: "negativ", color: RED } };

function Mood({ m, side }: { m: MoodMark | null; side: string }) {
  if (!m) return <span className="muted">{side}: –</span>;
  const c = MOOD[m.mood];
  return <span title={m.note ?? undefined}>{side}: <span style={{ color: c.color, fontWeight: 600 }}>{c.label}</span> <span className="muted">({fmtDate(m.at)})</span></span>;
}

export default async function EinsaetzePage({ searchParams }: { searchParams: Promise<{ fehler?: string; ok?: string; f?: string; q?: string }> }) {
  if (getConfig().FEATURE_BESETZUNG !== "true") notFound();
  const sp = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  const filter = (engagementFilterValues as readonly string[]).includes(sp.f ?? "") ? (sp.f as EngagementFilter) : "alle";
  const q = (sp.q ?? "").trim();
  const { items, counts } = await listEngagements(actor, filter, q);
  const qs = q ? `&q=${encodeURIComponent(q)}` : "";
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-semibold">Einsätze</h1>
        <span className="muted text-sm">Wer ist wo bis wann – mit Stimmung aus den Check-ins und Stand der Verlängerung. Stundenzettel bleiben in Moco.</span>
        <Link href="/besetzung" className="text-sm ml-auto">Besetzungen</Link>
      </div>
      <Feedback params={sp} />
      <form method="get" action="/einsaetze" className="flex flex-wrap gap-2 items-center text-sm">
        <input type="hidden" name="f" value={filter} />
        <input name="q" className="input" defaultValue={q} placeholder="Kunde, Person oder Einsatz suchen …" aria-label="Suchen" style={{ width: 360 }} />
        <button className="btn btn-small" type="submit">Suchen</button>
        {q && <Link href={`/einsaetze?f=${filter}`} className="muted text-xs">zurücksetzen</Link>}
      </form>
      <nav aria-label="Filter" className="flex flex-wrap gap-2 text-sm">
        {FILTERS.map((f) => (
          <Link key={f.key} href={`/einsaetze?f=${f.key}${qs}`} className={`btn btn-small${filter === f.key ? "" : " btn-secondary"}`} aria-current={filter === f.key ? "page" : undefined}>
            {f.label} ({counts[f.key]})
          </Link>
        ))}
      </nav>
      <section className="card">
        {items.length === 0 ? (
          <p className="muted text-sm">{q ? `Nichts gefunden für „${q}“.` : "Keine Einsätze in diesem Filter. Einsätze entstehen mit der bestätigten Auswahl an einer Position oder aus Moco."}</p>
        ) : (
          <table className="list text-sm">
            <thead>
              <tr><th>Person · Kunde</th><th>Einsatz</th><th>Ende</th><th>Stimmung</th><th>Verlängerung</th><th>Betreuung</th></tr>
            </thead>
            <tbody>
              {items.map((e) => {
                const endSoon = e.daysToEnd !== null && e.daysToEnd <= 30 && e.status === "AKTIV";
                const renewalOpen = !e.renewalStatus || e.renewalStatus === "ZU_KLAEREN";
                return (
                  <tr key={e.id} style={{ borderLeft: `3px solid ${e.checkinOverdue || endSoon ? RED : e.status === "AKTIV" ? "#2f7d32" : "var(--border)"}` }}>
                    <td>
                      <Link href={`/einsaetze/${e.id}`}><strong>{e.personName}</strong></Link>{e.internalUserId ? <span className="muted text-xs"> (intern)</span> : null}
                      <div className="muted text-xs">{e.accountName} · BD {e.bdName}</div>
                    </td>
                    <td>
                      <div>{e.title}</div>
                      <div className="muted text-xs"><span className="status">{engagementStatusLabel[e.status] ?? e.status}</span>{e.mocoProjectId ? ` · Moco ${e.mocoProjectId}` : ""}{e.procurement.complete === false && !e.procurementException ? <span style={{ color: "#b7791f" }}> · Unterlagen {e.procurement.required.filter((r) => r.ok).length}/{e.procurement.required.length}</span> : null}</div>
                    </td>
                    <td style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                      {e.plannedEnd ? <>{fmtDate(e.plannedEnd)}<div className={`text-xs ${endSoon ? "" : "muted"}`} style={endSoon ? { color: RED, fontWeight: 600 } : undefined}>{e.daysToEnd !== null ? `${e.daysToEnd} Tage` : ""}</div></> : <span className="muted">offen</span>}
                    </td>
                    <td className="text-xs">
                      <div><Mood m={e.moodKunde} side="Kunde" /></div>
                      {e.freelancerId ? <div><Mood m={e.moodFreelancer} side="Freelancer" /></div> : null}
                      {e.nextCheckin && <div style={e.checkinOverdue ? { color: RED, fontWeight: 600 } : undefined} className={e.checkinOverdue ? "" : "muted"}>nächster {fmtDate(e.nextCheckin)}{e.checkinOverdue ? " (überfällig)" : ""}</div>}
                    </td>
                    <td className="text-xs">
                      {e.renewalStatus ? <>{renewalStatusLabel[e.renewalStatus] ?? e.renewalStatus}{e.renewalTo && e.renewalStatus !== "ZU_KLAEREN" ? <> bis {fmtDate(e.renewalTo)}</> : null}</> : <span className="muted">–</span>}
                      {renewalOpen && ["AKTIV", "PAUSIERT", "GEPLANT", "ENDET"].includes(e.status) && <div><Link href={`/einsaetze/${e.id}#verlaengerung`}>anstoßen</Link></div>}
                    </td>
                    <td className="text-xs">{e.careNames.length ? e.careNames.map((n) => n.replace(/ \((Kundenbetreuung|Freelancer-Betreuung)\)$/, "")).join(", ") : <span style={{ color: "#b7791f" }}>offen</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
