import Link from "next/link";
import type { ReactNode } from "react";
import type { GfOverview } from "@/modules/overview/gf";
import { DAYS_PER_MONTH } from "@/modules/overview/gf";
import { HealthBadge } from "@/components/HealthBadge";
import { fmtDate, opportunityStatusLabel } from "@/lib/labels";
import { EXPIRY_WINDOW_LABEL } from "@/lib/window";

const AMPEL: Record<string, string> = { ROT: "#c0392b", GELB: "#b7791f", GRUEN: "#2f7d32" };
const eur = (n: number) => `${new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 }).format(n)} €`;
const MOOD: Record<string, string> = { POSITIV: "positiv", MITTEL: "mittel", NEGATIV: "negativ" };

function Kpi({ value, label, href, warn }: { value: ReactNode; label: string; href: string; warn?: boolean }) {
  return (
    <Link href={href} className="no-underline p-3" style={{ background: "var(--surface-2)", borderRadius: 8, display: "block", color: "var(--text)" }}>
      <div className="text-2xl font-semibold" style={{ fontVariantNumeric: "tabular-nums", color: warn ? "#c0392b" : undefined }}>{value}</div>
      <div className="muted text-xs">{label}</div>
    </Link>
  );
}

/** Kopfzeile mit Kennzahlen – jede Zahl springt zu ihrem Block. */
export function GfKpis({ o }: { o: GfOverview }) {
  const k = o.kpis;
  return (
    <section className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3" aria-label="Kennzahlen">
      <Kpi value={k.heads} label="Köpfe im Einsatz" href="/einsaetze" />
      <Kpi value={k.endingUndecided} label={`enden in ${EXPIRY_WINDOW_LABEL}, offen`} href="#laeuft-aus" warn={k.endingUndecided > 0} />
      <Kpi value={k.pipelinePerDay ? eur(k.pipelinePerDay) : "–"} label={`Pipeline VK/Tag · ${k.pipelineCount} Chancen`} href="#pipeline" />
      <Kpi value={<>{k.red} <span className="text-base font-normal">rot</span><span className="muted text-base font-normal"> · {k.yellow} gelb</span></>} label="Kunden mit Handlungsbedarf" href="#kunden" warn={k.red > 0} />
      <Kpi value={k.teamOverdue} label="überfällig im Team" href="#team" warn={k.teamOverdue > 0} />
      <Kpi value={k.openSuggestions} label="offene KI-Vorschläge" href="/benachrichtigungen" />
    </section>
  );
}

export function GfExpiring({ o }: { o: GfOverview }) {
  return (
    <section className="card" id="laeuft-aus">
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className="font-semibold">Laufen aus in {EXPIRY_WINDOW_LABEL} ({o.expiring.length})</h2>
        <Link href="/einsaetze?f=enden_8w" className="text-sm ml-auto">alle Einsätze</Link>
      </div>
      {o.expiring.length === 0 ? <p className="muted text-sm mt-1">Kein Einsatz endet in den nächsten {EXPIRY_WINDOW_LABEL}.</p> : (
        <table className="list text-sm mt-1">
          <thead><tr><th>Person</th><th>Kunde</th><th>Ende</th><th>Verlängerung</th><th>BD</th><th>Stimmung</th></tr></thead>
          <tbody>
            {o.expiring.map((e) => (
              <tr key={e.engagementId}>
                <td><Link href={`/einsaetze/${e.engagementId}#verlaengerung`}><strong>{e.person}</strong></Link></td>
                <td><Link href={`/kunden/${e.accountId}`}>{e.accountName}</Link></td>
                <td style={{ whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", color: e.urgent ? "#c0392b" : undefined, fontWeight: e.urgent ? 600 : undefined }}>{fmtDate(e.end)} · {e.daysToEnd < 0 ? `seit ${-e.daysToEnd} T.` : `${e.daysToEnd} T.`}</td>
                <td style={{ color: e.decided ? "#2f7d32" : undefined }}>{e.renewal}</td>
                <td>{e.owner}</td>
                <td className="muted">{e.mood ? MOOD[e.mood] ?? e.mood : "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function GfCustomers({ o }: { o: GfOverview }) {
  return (
    <section className="card" id="kunden">
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className="font-semibold">Kunden ({o.customers.length})</h2>
        <Link href="/kundenrunde" className="text-sm ml-auto">Kundenrunde</Link>
      </div>
      {o.customers.length === 0 ? <p className="muted text-sm mt-1">Keine Bestandskunden.</p> : (
        <table className="list text-sm mt-1">
          <thead><tr><th></th><th>Kunde</th><th>Health · Datenlage</th><th style={{ textAlign: "right" }}>Köpfe</th><th>Nächstes Ende</th><th>Verantwortlich</th><th>Warum</th></tr></thead>
          <tbody>
            {o.customers.map((c) => (
              <tr key={c.accountId}>
                <td><span aria-label={c.ampel} title={c.ampel} style={{ display: "inline-block", width: 10, height: 10, borderRadius: 999, background: AMPEL[c.ampel] }} /></td>
                <td><Link href={`/kunden/${c.accountId}`}><strong>{c.name}</strong></Link></td>
                <td style={{ whiteSpace: "nowrap" }}>{c.level ? <Link href={`/kunden/${c.accountId}/health`} className="no-underline"><HealthBadge score={c.score} level={c.level as never} coverage={c.coverage ?? 0} /></Link> : "–"}{c.coverage != null && <span className="muted text-xs"> {c.coverage} %</span>}</td>
                <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{c.heads}{c.headsDelta !== 0 && <span style={{ color: c.headsDelta < 0 ? "#c0392b" : "#2f7d32" }}> ({c.headsDelta > 0 ? "+" : ""}{c.headsDelta})</span>}</td>
                <td style={{ whiteSpace: "nowrap" }}>{c.nextEnd ? fmtDate(c.nextEnd) : "–"}</td>
                <td>{c.owner}</td>
                <td style={{ color: c.ampel === "GRUEN" ? undefined : AMPEL[c.ampel] }}>{c.sentence}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function GfPipeline({ o }: { o: GfOverview }) {
  return (
    <section className="card" id="pipeline">
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className="font-semibold">Pipeline ({o.pipeline.length})</h2>
        <span className="muted text-xs">sortiert nach „hängt am längsten“ · VK/Tag = Verkaufssatz × Köpfe{o.kpis.pipelinePerDay ? ` · zusammen ${eur(o.kpis.pipelinePerDay)}/Tag ≈ ${eur(o.kpis.pipelinePerDay * DAYS_PER_MONTH)}/Monat bei ${DAYS_PER_MONTH} Tagen` : ""}</span>
      </div>
      {o.pipeline.length === 0 ? <p className="muted text-sm mt-1">Keine offenen Chancen.</p> : (
        <table className="list text-sm mt-1">
          <thead><tr><th>Chance</th><th>Kunde</th><th>Stufe</th><th style={{ textAlign: "right" }}>seit</th><th>Verantwortlich</th><th style={{ textAlign: "right" }}>Köpfe</th><th style={{ textAlign: "right" }}>VK/Tag</th><th>Nächster Schritt</th></tr></thead>
          <tbody>
            {o.pipeline.map((p) => (
              <tr key={p.opportunityId}>
                <td><Link href={`/bedarfe/${p.opportunityId}`}><strong>{p.title}</strong></Link></td>
                <td><Link href={`/kunden/${p.accountId}`}>{p.accountName}</Link></td>
                <td>{opportunityStatusLabel[p.status] ?? p.status}</td>
                <td style={{ textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", color: p.daysInStage > 30 ? "#b7791f" : undefined }}>{p.daysInStage} T.</td>
                <td>{p.owner}</td>
                <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{p.heads}</td>
                <td style={{ textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{p.vkPerDay ? eur(p.vkPerDay) : <span className="muted">–</span>}</td>
                <td style={{ color: p.overdue ? "#c0392b" : undefined }}>{p.next ? <>{p.next}{p.nextDue ? <span className="muted"> · {fmtDate(p.nextDue)}</span> : null}</> : <span className="muted" style={{ whiteSpace: "nowrap" }}>keiner geplant</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function GfTeam({ o }: { o: GfOverview }) {
  return (
    <section className="card" id="team">
      <h2 className="font-semibold">Team – wo etwas liegt</h2>
      {o.team.length === 0 ? <p className="muted text-sm mt-1">Niemand hat offene Aufgaben.</p> : (
        <table className="list text-sm mt-1">
          <thead><tr><th>Person</th><th style={{ textAlign: "right" }}>offen</th><th style={{ textAlign: "right" }}>überfällig</th><th>älteste überfällig</th><th>zuletzt aktiv</th></tr></thead>
          <tbody>
            {o.team.map((t) => (
              <tr key={t.userId}>
                <td><strong>{t.name}</strong></td>
                <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{t.open}</td>
                <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: t.overdue ? "#c0392b" : undefined, fontWeight: t.overdue ? 600 : undefined }}>{t.overdue}</td>
                <td>{t.oldestOverdue ? fmtDate(t.oldestOverdue) : "–"}</td>
                <td className="muted">{t.lastActive ? fmtDate(t.lastActive) : "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted text-xs mt-2">Gezählt: angenommene Aufgaben, Arbeitsaufträge und angefragte Übergaben je Person.</p>
    </section>
  );
}
