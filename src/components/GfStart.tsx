import Link from "next/link";
import { Hint } from "@/components/Hint";
import type { ReactNode } from "react";
import type { GfOverview } from "@/modules/overview/gf";
import { DAYS_PER_MONTH } from "@/modules/overview/gf";
import { HealthBadge } from "@/components/HealthBadge";
import { fmtDate, opportunityStatusLabel } from "@/lib/labels";
import { EXPIRY_WINDOW_LABEL } from "@/lib/window";
import { KpiTile } from "@/components/Kpi";
import { BarChart, CHART_COLORS } from "@/components/charts/BarChart";
import { Sparkline, TrendChart } from "@/components/charts/TrendChart";
import { CHANCE_STEPS } from "@/lib/chanceStages";

const AMPEL: Record<string, string> = { ROT: "var(--danger)", GELB: "#b7791f", GRUEN: "#2f7d32" };
const AMPEL_LABEL: Record<string, string> = { ROT: "dringend", GELB: "beobachten", GRUEN: "keiner" };
const eur = (n: number) => `${new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 }).format(n)} €`;
const MOOD: Record<string, string> = { POSITIV: "positiv", MITTEL: "mittel", NEGATIV: "negativ" };

function Kpi({ value, label, href, warn }: { value: ReactNode; label: string; href: string; warn?: boolean }) {
  return <KpiTile value={value} label={label} href={href} tone={warn ? "danger" : null} />;
}

/** Kopfzeile mit Kennzahlen – jede Zahl springt zu ihrem Block. */
export function GfKpis({ o }: { o: GfOverview }) {
  const k = o.kpis;
  return (
    <section className="kpi-row" aria-label="Kennzahlen">
      <KpiTile value={k.persons} label={<>Köpfe im Einsatz<span className="muted"> · {k.heads} Einsätze</span><Sparkline values={o.headsTrend.map((p) => p.value)} futureFrom={13} /></>} href="#koepfe" />
      <Kpi value={k.endingUndecided} label={`enden in ${EXPIRY_WINDOW_LABEL}, offen`} href="#laeuft-aus" warn={k.endingUndecided > 0} />
      {k.revenueMonth != null && <Kpi value={eur(k.revenueMonth)} label={`Umsatz je Monat, laufend${k.expiringMonth ? ` · ${eur(k.expiringMonth)} davon ohne Entscheidung` : ""}`} href="#laeuft-aus" />}
      <Kpi value={k.pipelinePerDay ? eur(k.pipelinePerDay * 20) : "–"} label={`Pipeline je Monat · ${k.pipelineCount} Chancen`} href="#pipeline" />
      <Kpi value={<>{k.red} <span className="text-base font-medium">dringend</span><span className="muted text-sm font-normal"> · {k.yellow} beobachten</span></>} label="Kunden mit Handlungsbedarf" href="#kunden" warn={k.red > 0} />
      <Kpi value={k.teamOverdue} label="überfällig im Team" href="#team" warn={k.teamOverdue > 0} />
      {k.openSuggestions > 0 && <Kpi value={k.openSuggestions} label="offene KI-Vorschläge" href="/start#vorschlaege" />}
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
      {o.expiring.length === 0 ? <p className="empty">Kein Einsatz endet in den nächsten {EXPIRY_WINDOW_LABEL}.</p> : (
        <div className="table-wrap"><table className="list text-sm mt-1">
          <thead><tr><th>Person</th><th>Kunde</th><th>Ende</th><th>Verlängerung</th><th>BD</th><th>Stimmung</th></tr></thead>
          <tbody>
            {o.expiring.map((e) => (
              <tr key={e.engagementId}>
                <td><Link href={`/einsaetze/${e.engagementId}#verlaengerung`}><strong>{e.person}</strong></Link></td>
                <td><Link href={`/kunden/${e.accountId}`}>{e.accountName}</Link></td>
                <td style={{ whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", color: e.urgent ? "var(--danger)" : undefined, fontWeight: e.urgent ? 600 : undefined }}>{fmtDate(e.end)} · {e.daysToEnd < 0 ? `seit ${-e.daysToEnd} T.` : `${e.daysToEnd} T.`}</td>
                <td style={{ color: e.decided ? "#2f7d32" : undefined }}>{e.renewal}</td>
                <td>{e.owner}</td>
                <td className="muted">{e.mood ? MOOD[e.mood] ?? e.mood : "–"}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </section>
  );
}

export function GfCustomers({ o }: { o: GfOverview }) {
  return (
    <section className="card" id="kunden">
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className="font-semibold">Bestandskunden ({o.customers.length})</h2>
        <Link href="/kundenrunde" className="text-sm ml-auto">Zur Kundenrunde</Link><Link href="/kunden" className="text-sm">alle Kunden</Link>
      </div>
      {o.customers.length === 0 ? <p className="empty">Keine Bestandskunden.</p> : (
        <div className="table-wrap"><table className="list text-sm mt-1">
          <thead><tr><th title="Handlungsbedarf laut Kundenrunde">Bedarf</th><th>Kunde</th><th>Health · Datenlage</th><th style={{ textAlign: "right" }}>Köpfe</th><th>Nächstes Ende</th><th>Verantwortlich</th><th>Warum</th></tr></thead>
          <tbody>
            {o.customers.map((c) => (
              <tr key={c.accountId}>
                <td><span aria-label={AMPEL_LABEL[c.ampel]} title={`Handlungsbedarf: ${AMPEL_LABEL[c.ampel]}`} style={{ display: "inline-block", width: 10, height: 10, borderRadius: 999, background: AMPEL[c.ampel] }} /></td>
                <td><Link href={`/kunden/${c.accountId}`}><strong>{c.name}</strong></Link></td>
                <td style={{ whiteSpace: "nowrap" }}>{c.level ? <Link href={`/kunden/${c.accountId}/health`} className="no-underline"><HealthBadge score={c.score} level={c.level as never} coverage={c.coverage ?? 0} /></Link> : "–"}{c.coverage != null && <span className="muted text-xs"> {c.coverage} %</span>}</td>
                <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{c.heads}{c.headsDelta !== 0 && <span style={{ color: c.headsDelta < 0 ? "var(--danger)" : "#2f7d32" }}> ({c.headsDelta > 0 ? "+" : ""}{c.headsDelta})</span>}</td>
                <td style={{ whiteSpace: "nowrap" }}>{c.nextEnd ? fmtDate(c.nextEnd) : "–"}</td>
                <td>{c.owner}</td>
                <td>{c.sentence}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      {o.atRiskOther.length > 0 && (
        <p className="text-sm mt-3">
          <span className="muted">Gefährdet ohne laufenden Einsatz:</span>{" "}
          {o.atRiskOther.map((a, i) => (
            <span key={a.accountId}>{i > 0 && " · "}<Link href={`/kunden/${a.accountId}`}>{a.name}</Link> <Link href={`/kunden/${a.accountId}/health`} className="no-underline"><HealthBadge score={a.score} level={a.level as never} coverage={a.coverage} /></Link></span>
          ))}
        </p>
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
      {o.pipeline.length > 0 && (
        <div className="mt-2 mb-3">
          <BarChart
            title="Pipeline je Stufe"
            labelWidth={200}
            bars={CHANCE_STEPS.filter((st) => o.pipeline.some((p) => p.status === st)).map((st, i, arr) => ({
              label: opportunityStatusLabel[st] ?? st,
              value: o.pipeline.filter((p) => p.status === st).length,
              color: CHART_COLORS.sequential[Math.min(Math.floor((i / Math.max(arr.length, 1)) * CHART_COLORS.sequential.length), CHART_COLORS.sequential.length - 1)],
              detail: "Chancen",
            }))}
          />
        </div>
      )}
      {o.pipeline.length === 0 ? <p className="empty">Keine offenen Chancen.</p> : (
        <div className="table-wrap"><table className="list text-sm mt-1">
          <thead><tr><th>Chance</th><th>Kunde</th><th>Stufe</th><th style={{ textAlign: "right" }}>seit</th><th>Verantwortlich</th><th style={{ textAlign: "right" }}>Köpfe</th><th style={{ textAlign: "right" }}>VK/Tag</th><th>Nächster Schritt</th></tr></thead>
          <tbody>
            {o.pipeline.map((p) => (
              <tr key={p.opportunityId}>
                <td><Link href={`/bedarfe/${p.opportunityId}`}><strong>{p.title}</strong></Link></td>
                <td><Link href={`/kunden/${p.accountId}`}>{p.accountName}</Link></td>
                <td>{opportunityStatusLabel[p.status] ?? p.status}{p.stageLag && <span className="chip" data-tone="warn" title="Einsatz läuft bereits – Stufe auf der Chance nachziehen" style={{ marginLeft: 6 }}>Einsatz läuft</span>}</td>
                <td style={{ textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", color: p.daysInStage > 30 ? "#b7791f" : undefined }}>{p.daysInStage} T.</td>
                <td>{p.owner}</td>
                <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{p.heads}</td>
                <td style={{ textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{p.vkPerDay ? eur(p.vkPerDay) : <span className="muted">–</span>}</td>
                <td style={{ color: p.overdue ? "var(--danger)" : undefined }}>{p.next ? <>{p.next}{p.nextDue ? <span className="muted"> · {fmtDate(p.nextDue)}</span> : null}</> : <span className="muted" style={{ whiteSpace: "nowrap" }}>keiner geplant</span>}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </section>
  );
}

export function GfTeam({ o }: { o: GfOverview }) {
  return (
    <section className="card" id="team">
      <h2 className="font-semibold">Team – wo etwas liegt</h2>
      {o.team.length === 0 ? <p className="empty">Niemand hat offene Aufgaben.</p> : (
        <div className="table-wrap"><table className="list text-sm mt-1">
          <thead><tr><th>Person</th><th style={{ textAlign: "right" }}>offen</th><th style={{ textAlign: "right" }}>überfällig</th><th>älteste überfällig</th><th>zuletzt aktiv</th></tr></thead>
          <tbody>
            {o.team.map((t) => (
              <tr key={t.userId}>
                <td><strong>{t.name}</strong></td>
                <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{t.open}</td>
                <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: t.overdue ? "var(--danger)" : undefined, fontWeight: t.overdue ? 600 : undefined }}>{t.overdue}</td>
                <td>{t.oldestOverdue ? fmtDate(t.oldestOverdue) : "–"}</td>
                <td className="muted">{t.lastActive ? fmtDate(t.lastActive) : "–"}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      <Hint>Gezählt: angenommene Aufgaben, Arbeitsaufträge und angefragte Übergaben je Person.</Hint>
    </section>
  );
}

/** e65: Köpfe im Einsatz – 12 Wochen Verlauf und 12 Wochen Ausblick (aus den geplanten Enden): zeigt die „Klippe“. */
export function GfHeadsTrend({ o }: { o: GfOverview }) {
  const t = o.headsTrend;
  const now = t[12]?.value ?? 0;
  const in12 = t.at(-1)?.value ?? 0;
  const ago12 = t[0]?.value ?? 0;
  const dm = (iso: string) => `${Number(iso.slice(8, 10))}.${Number(iso.slice(5, 7))}.`;
  return (
    <section className="card" id="koepfe">
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className="font-semibold">Köpfe im Einsatz – Verlauf und Ausblick</h2>
        <span className="muted text-sm">vor 12 Wochen {ago12} · heute {now} · in 12 Wochen {in12} ohne Verlängerung{in12 < now ? <span style={{ color: "var(--danger)" }}> ({in12 - now})</span> : null}</span>
        <Link href="/einsaetze?f=enden_8w" className="text-sm ml-auto">auslaufende Einsätze</Link>
      </div>
      <div className="mt-2">
        <TrendChart title="Köpfe im Einsatz je Woche" points={t.map((p) => ({ label: dm(p.date), value: p.value, future: p.future }))} min={0} />
      </div>
      <Hint>Gestrichelt: Stand nach den heute geplanten Enden – jede bestätigte Verlängerung hebt die Linie.</Hint>
    </section>
  );
}
