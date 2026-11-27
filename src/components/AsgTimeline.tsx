import Link from "next/link";
import type { AsgEngagement, AsgOpportunity, AsgOppPhase, AsgState } from "@/modules/assignments/service";
import { asgOppPhaseLabel, asgStateLabel } from "@/modules/assignments/service";
import { fmtDate } from "@/lib/labels";

export const ASG_COLOR: Record<AsgState, string> = { LAEUFT: "#2e7d6b", GEPLANT: "#8fa6a0", ENDET_BALD: "#b7791f", DRINGEND: "var(--danger)", UEBERSCHRITTEN: "#7b1e13", VERLAENGERUNG: "#6a4fa3", BEENDET: "#b5b5ad" };
/** e55: Chancen in einer Farbe, von hell (vermutet) nach kräftig (ausgewählt) – die Phase ist zusätzlich beschriftet. */
export const OPP_STYLE: Record<AsgOppPhase, { background: string; color: string; border: string }> = {
  VERMUTET: { background: "transparent", color: "#2f5f9e", border: "1.5px dotted #2f5f9e" },
  ANFRAGE: { background: "#e6edf7", color: "#1f3f6b", border: "1.5px dashed #2f5f9e" },
  BESTAETIGT: { background: "#c9d7ec", color: "#1f3f6b", border: "1.5px solid #2f5f9e" },
  ANGEBOT: { background: "#4f76b3", color: "#fff", border: "1.5px solid #4f76b3" },
  AUSWAHL: { background: "#1f3f6b", color: "#fff", border: "1.5px solid #1f3f6b" },
};
/** e60: Verlängerung hinter dem Einsatz – gleiche Logik wie bei den Chancen, in der Verlängerungsfarbe */
const REN_STYLE: Record<string, { label: string; short: string; border: string; background: string }> = {
  MOEGLICH: { label: "möglich, noch zu früh", short: "möglich", border: "dotted", background: "transparent" },
  ZU_KLAEREN: { label: "zu klären", short: "", border: "dotted", background: "transparent" },
  IN_ABSTIMMUNG: { label: "in Abstimmung", short: "in Abstimmung", border: "dashed", background: "#6a4fa31a" },
  ANGEBOTEN: { label: "Angebot verschickt", short: "Angebot", border: "solid", background: "#6a4fa355" },
};
const PHASES: AsgOppPhase[] = ["VERMUTET", "ANFRAGE", "BESTAETIGT", "ANGEBOT", "AUSWAHL"];
/** e62: Spuren je Person – überlappende Einsätze bekommen eine eigene Zeile */
const LANE = 1.95;
const spanEnd = (e: Pick<AsgEngagement, "end" | "renewalTo">) => (e.renewalTo && e.renewalTo > (e.end ?? "") ? e.renewalTo : e.end ?? "9999-12-31");
export function lanes(rows: Pick<AsgEngagement, "id" | "start" | "end" | "renewalTo">[]): Map<string, number> {
  const ends: string[] = [];
  const out = new Map<string, number>();
  for (const e of [...rows].sort((a, b) => (a.start ?? "").localeCompare(b.start ?? ""))) {
    const start = e.start ?? "0000-01-01";
    let k = ends.findIndex((end) => end < start);
    if (k < 0) k = ends.length;
    ends.splice(k, 1, spanEnd(e));
    out.set(e.id, k);
  }
  return out;
}
const laneOf = (rows: AsgEngagement[], e: AsgEngagement) => lanes(rows).get(e.id) ?? 0;
const laneCount = (rows: AsgEngagement[]) => (rows.length ? Math.max(...lanes(rows).values()) + 1 : 0);
const MONTHS = ["Jan", "Feb", "Mrz", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];

/** Zeitleiste wie in einer Ressourcenplanung: je Person eine Zeile, je Einsatz ein Balken; Farbe = Stand. */
export function AsgTimeline({ engagements, opportunities = [], today, monthsBack = 2, monthsAhead = 10 }: { engagements: AsgEngagement[]; opportunities?: AsgOpportunity[]; today: string; monthsBack?: number; monthsAhead?: number }) {
  const t = new Date(`${today}T00:00:00Z`);
  const from = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - monthsBack, 1));
  const to = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + monthsAhead + 1, 1));
  const span = to.getTime() - from.getTime();
  const pos = (iso: string) => Math.min(100, Math.max(0, ((new Date(`${iso}T00:00:00Z`).getTime() - from.getTime()) / span) * 100));
  const months: { label: string; left: number }[] = [];
  for (let d = new Date(from); d < to; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) months.push({ label: `${MONTHS[d.getUTCMonth()]}${d.getUTCMonth() === 0 || months.length === 0 ? ` ${String(d.getUTCFullYear()).slice(2)}` : ""}`, left: ((d.getTime() - from.getTime()) / span) * 100 });
  const fromIso = from.toISOString().slice(0, 10);
  const toIso = to.toISOString().slice(0, 10);
  const visible = engagements.filter((e) => (e.end ?? "9999") >= fromIso && (e.start ?? "0000") <= toIso);
  const opps = opportunities.filter((o) => o.end >= fromIso && o.start <= toIso);
  const persons = [...new Map([...visible, ...opps].map((e) => [e.personId, { personId: e.personId, person: e.person, kind: e.kind }])).values()]
    .map((p) => ({ id: p.personId, name: p.person, kind: p.kind, rows: visible.filter((e) => e.personId === p.personId), opps: opps.filter((o) => o.personId === p.personId) }))
    .sort((a, b) => {
      const key = (x: typeof a) => Math.min(...x.rows.filter((r) => r.state !== "BEENDET").map((r) => r.daysToEnd ?? 9999), x.rows.length ? 99999 : 99998);
      return key(a) - key(b) || a.name.localeCompare(b.name, "de");
    });
  const used = [...new Set(visible.map((e) => e.state))];
  const usedPhases = PHASES.filter((ph) => opps.some((o) => o.phase === ph));
  if (!persons.length) return <p className="muted text-sm">Keine Einsätze im Zeitraum.</p>;
  return (
    <div className="tl" role="table" aria-label="Zeitleiste der Einsätze">
      <div className="tl-head">
        <div />
        <div className="tl-months">{months.map((m) => <span key={m.left} style={{ left: `${m.left}%` }}>{m.label}</span>)}</div>
      </div>
      {persons.map((p) => (
        <div className="tl-row" key={p.id} role="row" style={{ minHeight: `${0.7 + laneCount(p.rows) * LANE + p.opps.length * 1.45}rem` }}>
          <div className="tl-name" role="rowheader" title={p.name}><strong>{p.name}</strong>{p.kind === "INTERN" ? <span className="muted"> · intern</span> : null}</div>
          <div className="tl-track">
            {months.map((m) => <span key={m.left} className="tl-grid" style={{ left: `${m.left}%` }} />)}
            <span className="tl-today" style={{ left: `${pos(today)}%` }} title="heute" />
            {p.rows.map((e) => {
              // e62: parallele Einsätze derselben Person untereinander statt übereinander
              const top = `${0.35 + laneOf(p.rows, e) * LANE}rem`;
              const l = pos(e.start ?? fromIso);
              const r = pos(e.end ?? toIso);
              const tip = `${e.person} bei ${e.accountName} · ${e.start ? fmtDate(e.start) : "?"} – ${e.end ? fmtDate(e.end) : "offen"} · ${asgStateLabel[e.state]}${e.renewalTo ? ` bis ${fmtDate(e.renewalTo)}` : ""}`;
              return (
                <span key={e.id}>
                  <Link href={`/einsaetze/${e.id}`} className="tl-bar" title={tip} style={{ top, left: `${l}%`, width: `${Math.max(r - l, 0.8)}%`, background: ASG_COLOR[e.state] }}>{e.accountName}{e.end ? ` · bis ${fmtDate(e.end)}` : ""}</Link>
                  {e.renewalTo && e.end && e.renewalTo > e.end && (() => {
                    const ph = REN_STYLE[e.renewalStatus ?? ""] ?? REN_STYLE.IN_ABSTIMMUNG!;
                    return <span className="tl-ext" title={`Verlängerung bis ${fmtDate(e.renewalTo)} · ${ph.label}`} style={{ top, left: `${r}%`, width: `${Math.max(pos(e.renewalTo) - r, 0)}%`, borderColor: ASG_COLOR.VERLAENGERUNG, borderStyle: ph.border, background: ph.background, color: "#4b3778", fontSize: ".7rem", lineHeight: "1.1rem", paddingLeft: ".3rem", overflow: "hidden", whiteSpace: "nowrap" }}>{ph.short}</span>;
                  })()}
                  {[...new Set(e.checkinDots)].filter((d) => d >= fromIso && d <= toIso).map((d) => <span key={`${e.id}-${d}`} className="tl-dot" title={`Check-in fällig ${fmtDate(d)}`} style={{ top: `calc(${top} + 1.45rem)`, left: `${pos(d)}%`, background: d < today ? "var(--danger)" : "#5f5f5a" }} />)}
                </span>
              );
            })}
            {p.opps.map((o, oi) => {
              const l = pos(o.start);
              const r = pos(o.end);
              const st = OPP_STYLE[o.phase];
              const tip = `${o.href ? "Angebot" : "Chance"}: ${o.person} bei ${o.accountName} – ${o.title} · ${asgOppPhaseLabel[o.phase]} · ${fmtDate(o.start)} – ${fmtDate(o.end)}${o.estimated ? " (Zeitraum geschätzt)" : ""}${o.conflict ? ` · Achtung: ${o.conflict}` : ""}${o.note ? ` · ${o.note}` : ""}`;
              return <Link key={o.id} href={o.href ?? `/bedarfe/${o.opportunityId}`} className="tl-bar tl-opp" title={tip} style={{ top: `${0.35 + laneCount(p.rows) * LANE + oi * 1.45}rem`, left: `${l}%`, width: `${Math.max(r - l, 0.8)}%`, ...st, outline: o.conflict ? "2px solid #c0392b" : undefined, outlineOffset: 1 }}>{o.accountName} · {o.href ? "Angebot" : asgOppPhaseLabel[o.phase]}</Link>;
            })}
          </div>
        </div>
      ))}
      <p className="muted text-xs mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {used.map((s) => <span key={s}><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: ASG_COLOR[s], marginRight: 4 }} />{asgStateLabel[s]}</span>)}
        {(["MOEGLICH", "IN_ABSTIMMUNG", "ANGEBOTEN"] as const).filter((k) => visible.some((e) => e.renewalStatus === k && e.renewalTo)).map((k) => <span key={k}><span style={{ display: "inline-block", width: 14, height: 8, border: `2px ${REN_STYLE[k]!.border} ${ASG_COLOR.VERLAENGERUNG}`, background: REN_STYLE[k]!.background, marginRight: 4 }} />Verlängerung {REN_STYLE[k]!.label}</span>)}
        <span><span style={{ display: "inline-block", width: 6, height: 6, borderRadius: 999, background: "#5f5f5a", marginRight: 4 }} />Check-in fällig</span>
        <span><span style={{ display: "inline-block", width: 0, height: 10, borderLeft: "2px solid #c0392b", marginRight: 4 }} />heute</span>
        {usedPhases.length > 0 && <span className="muted">Chancen:</span>}
        {usedPhases.map((ph) => <span key={ph}><span style={{ display: "inline-block", width: 14, height: 10, borderRadius: 2, boxSizing: "border-box", background: OPP_STYLE[ph].background, border: OPP_STYLE[ph].border, marginRight: 4 }} />{asgOppPhaseLabel[ph]}</span>)}
        {opps.some((o) => o.conflict) && <span><span style={{ display: "inline-block", width: 14, height: 10, borderRadius: 2, outline: "2px solid #c0392b", marginRight: 4 }} />überschneidet sich</span>}
      </p>
    </div>
  );
}
