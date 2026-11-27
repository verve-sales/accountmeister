/**
 * e65: Verlaufslinie (inline SVG, serverseitig, ohne Bibliothek). Vergangenheit als volle Linie mit Fläche, Zukunft
 * (Ausblick aus geplanten Daten) gestrichelt; senkrechte Markierung „heute“. Jeder Punkt trägt einen Tooltip (title).
 * Werte bleiben zusätzlich als Text daneben bzw. in der Tabelle der Seite lesbar.
 */
export type TrendPoint = { label: string; value: number | null; future?: boolean };

export function TrendChart({ points, title, unit = "", height = 140, min }: { points: TrendPoint[]; title: string; unit?: string; height?: number; min?: number }) {
  const W = 640;
  const H = height;
  const pad = { l: 34, r: 12, t: 12, b: 24 };
  const vals = points.map((p) => p.value).filter((v): v is number => v != null);
  if (vals.length === 0) return null;
  const lo = min ?? Math.min(0, ...vals);
  const hi = Math.max(...vals, lo + 1);
  const x = (i: number) => pad.l + (points.length === 1 ? 0 : (i / (points.length - 1)) * (W - pad.l - pad.r));
  const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
  const past = points.map((p, i) => ({ ...p, i })).filter((p) => !p.future && p.value != null);
  const future = points.map((p, i) => ({ ...p, i })).filter((p, k, arr) => p.value != null && (p.future || (arr[k + 1]?.future ?? false)));
  const path = (ps: { i: number; value: number | null }[]) => ps.map((p, k) => `${k ? "L" : "M"}${x(p.i).toFixed(1)},${y(p.value!).toFixed(1)}`).join(" ");
  const area = past.length > 1 ? `${path(past)} L${x(past.at(-1)!.i).toFixed(1)},${y(lo).toFixed(1)} L${x(past[0]!.i).toFixed(1)},${y(lo).toFixed(1)} Z` : "";
  const todayIdx = points.findIndex((p) => p.future);
  const ticks = [lo, Math.round((lo + hi) / 2), hi].filter((v, i, a) => a.indexOf(v) === i);
  const step = Math.max(1, Math.ceil(points.length / 7));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title} style={{ width: "100%", height: "auto", maxHeight: H + 20, display: "block" }}>
      <title>{title}</title>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="#e7e9ee" />
          <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" fontSize="10.5" fill="#6b7383">{t}{unit}</text>
        </g>
      ))}
      {points.map((p, i) => (i % step === 0 || i === points.length - 1 ? <text key={`l${i}`} x={x(i)} y={H - 6} textAnchor="middle" fontSize="10.5" fill="#6b7383">{p.label}</text> : null))}
      {area && <path d={area} fill="#2453c7" fillOpacity="0.08" />}
      {past.length > 1 && <path d={path(past)} fill="none" stroke="#2453c7" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />}
      {future.length > 1 && <path d={path(future)} fill="none" stroke="#2453c7" strokeWidth="2" strokeDasharray="5 4" strokeOpacity="0.7" />}
      {todayIdx > 0 && (
        <g>
          <line x1={x(todayIdx - 1)} x2={x(todayIdx - 1)} y1={pad.t} y2={H - pad.b} stroke="#b42318" strokeWidth="1" strokeDasharray="3 3" />
          <text x={x(todayIdx - 1) + 4} y={pad.t + 9} fontSize="10" fill="#b42318">heute</text>
        </g>
      )}
      {points.map((p, i) => (p.value == null ? null : (
        <circle key={`p${i}`} cx={x(i)} cy={y(p.value)} r="3" fill={p.future ? "#fff" : "#2453c7"} stroke="#2453c7" strokeWidth="1.5">
          <title>{`${p.label}: ${p.value}${unit}${p.future ? " (geplant)" : ""}`}</title>
        </circle>
      )))}
    </svg>
  );
}

/** Kleine Verlaufslinie für Kennzahlen-Kacheln */
export function Sparkline({ values, futureFrom }: { values: number[]; futureFrom?: number }) {
  if (values.length < 2) return null;
  const W = 120, H = 28;
  const lo = Math.min(...values), hi = Math.max(...values, lo + 1);
  const x = (i: number) => (i / (values.length - 1)) * W;
  const y = (v: number) => 2 + (1 - (v - lo) / (hi - lo)) * (H - 4);
  const split = futureFrom ?? values.length;
  const d = (from: number, to: number) => values.slice(from, to).map((v, k) => `${k ? "L" : "M"}${x(from + k).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="sparkline" aria-hidden="true">
      <path d={d(0, split)} fill="none" stroke="#2453c7" strokeWidth="1.75" strokeLinecap="round" />
      {split < values.length && <path d={d(split - 1, values.length)} fill="none" stroke="#2453c7" strokeWidth="1.5" strokeDasharray="3 3" strokeOpacity=".6" />}
    </svg>
  );
}
