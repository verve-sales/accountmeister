import Link from "next/link";
import type { AsgEngagement, AsgState } from "@/modules/assignments/service";
import { asgStateLabel } from "@/modules/assignments/service";
import { fmtDate } from "@/lib/labels";

export const ASG_COLOR: Record<AsgState, string> = { LAEUFT: "#2e7d6b", GEPLANT: "#8fa6a0", ENDET_BALD: "#b7791f", DRINGEND: "#c0392b", UEBERSCHRITTEN: "#7b1e13", VERLAENGERUNG: "#6a4fa3", BEENDET: "#b5b5ad" };
const MONTHS = ["Jan", "Feb", "Mrz", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];

/** Zeitleiste wie in einer Ressourcenplanung: je Person eine Zeile, je Einsatz ein Balken; Farbe = Stand. */
export function AsgTimeline({ engagements, today, monthsBack = 2, monthsAhead = 10 }: { engagements: AsgEngagement[]; today: string; monthsBack?: number; monthsAhead?: number }) {
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
  const persons = [...new Map(visible.map((e) => [e.personId, e])).values()]
    .map((p) => ({ id: p.personId, name: p.person, kind: p.kind, rows: visible.filter((e) => e.personId === p.personId) }))
    .sort((a, b) => {
      const key = (x: typeof a) => Math.min(...x.rows.filter((r) => r.state !== "BEENDET").map((r) => r.daysToEnd ?? 9999), 99999);
      return key(a) - key(b) || a.name.localeCompare(b.name, "de");
    });
  const used = [...new Set(visible.map((e) => e.state))];
  if (!persons.length) return <p className="muted text-sm">Keine Einsätze im Zeitraum.</p>;
  return (
    <div className="tl" role="table" aria-label="Zeitleiste der Einsätze">
      <div className="tl-head">
        <div />
        <div className="tl-months">{months.map((m) => <span key={m.left} style={{ left: `${m.left}%` }}>{m.label}</span>)}</div>
      </div>
      {persons.map((p) => (
        <div className="tl-row" key={p.id} role="row">
          <div className="tl-name" role="rowheader" title={p.name}><strong>{p.name}</strong>{p.kind === "INTERN" ? <span className="muted"> · intern</span> : null}</div>
          <div className="tl-track">
            {months.map((m) => <span key={m.left} className="tl-grid" style={{ left: `${m.left}%` }} />)}
            <span className="tl-today" style={{ left: `${pos(today)}%` }} title="heute" />
            {p.rows.map((e) => {
              const l = pos(e.start ?? fromIso);
              const r = pos(e.end ?? toIso);
              const tip = `${e.person} bei ${e.accountName} · ${e.start ? fmtDate(e.start) : "?"} – ${e.end ? fmtDate(e.end) : "offen"} · ${asgStateLabel[e.state]}${e.renewalTo ? ` bis ${fmtDate(e.renewalTo)}` : ""}`;
              return (
                <span key={e.id}>
                  <Link href={`/einsaetze/${e.id}`} className="tl-bar" title={tip} style={{ left: `${l}%`, width: `${Math.max(r - l, 0.8)}%`, background: ASG_COLOR[e.state] }}>{e.accountName}{e.end ? ` · bis ${fmtDate(e.end)}` : ""}</Link>
                  {e.renewalTo && e.end && e.renewalTo > e.end && <span className="tl-ext" title={`Verlängerung bis ${fmtDate(e.renewalTo)} in Arbeit`} style={{ left: `${r}%`, width: `${Math.max(pos(e.renewalTo) - r, 0)}%`, borderColor: ASG_COLOR.VERLAENGERUNG }} />}
                  {[...new Set(e.checkinDots)].filter((d) => d >= fromIso && d <= toIso).map((d) => <span key={`${e.id}-${d}`} className="tl-dot" title={`Check-in fällig ${fmtDate(d)}`} style={{ left: `${pos(d)}%`, background: d < today ? "#c0392b" : "#5f5f5a" }} />)}
                </span>
              );
            })}
          </div>
        </div>
      ))}
      <p className="muted text-xs mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {used.map((s) => <span key={s}><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: ASG_COLOR[s], marginRight: 4 }} />{asgStateLabel[s]}</span>)}
        <span><span style={{ display: "inline-block", width: 14, height: 8, border: `2px dashed ${ASG_COLOR.VERLAENGERUNG}`, marginRight: 4 }} />Verlängerung in Arbeit</span>
        <span><span style={{ display: "inline-block", width: 6, height: 6, borderRadius: 999, background: "#5f5f5a", marginRight: 4 }} />Check-in fällig</span>
        <span><span style={{ display: "inline-block", width: 0, height: 10, borderLeft: "2px solid #c0392b", marginRight: 4 }} />heute</span>
      </p>
    </div>
  );
}
