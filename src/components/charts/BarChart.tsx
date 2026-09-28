/**
 * Schlichte, serverseitig gerenderte Balkendiagramme (inline SVG, keine Bibliothek, kein Client-JS).
 * Farben und Maße folgen der internen dataviz-Richtlinie: dünne Balken (<=24px), am Ende gerundet,
 * an der Grundlinie eckig; Sequenz = ein Farbton (Blau), zwei Serien = das validierte Blau/Orange-Paar.
 * Jeder Balken trägt ein <title> (native Tooltip-Anzeige) und einen direkten Wertelabel an der Spitze;
 * die zugehörige Tabelle daneben bleibt die barrierefreie Textfassung derselben Zahlen.
 */

export const CHART_COLORS = {
  sequential: ["#86b6ef", "#5598e7", "#2a78d6", "#1c5cab", "#104281"], // hell → dunkel, für geordnete Stufen (Reifegrad)
  series1: "#2a78d6", // kategorial Slot 1 (Blau) – z. B. „Ist“
  series2: "#eb6834", // kategorial Slot 2 (Orange) – z. B. „Ziel“
  track: "#e2e2dc", // unbelegte Spur (heller Schritt derselben neutralen Fläche)
} as const;

const BAR_HEIGHT = 18;
const ROW_GAP = 10;
const RADIUS = 4;

/** Rechteck, an der Spitze (rechts) gerundet, an der Grundlinie (links) eckig – „4px rounded data-end, square at the baseline“. */
function roundedBarPath(width: number, height: number, radius: number): string {
  const r = Math.min(radius, height / 2, Math.max(width, 0.01));
  if (width <= 0) return "";
  if (width <= r) return `M0,0 H${width} V${height} H0 Z`;
  return `M0,0 H${width - r} Q${width},0 ${width},${r} V${height - r} Q${width},${height} ${width - r},${height} H0 Z`;
}

export type Bar = { label: string; value: number; color?: string; detail?: string };

/** Ein Balken pro Kategorie, eine Farbe je Balken (Standard: eine Sequenz von hell zu dunkel für geordnete Stufen). */
export function BarChart({ title, bars, unit = "", maxValue, labelWidth = 160 }: { title: string; bars: Bar[]; unit?: string; maxValue?: number; labelWidth?: number }) {
  const max = Math.max(maxValue ?? 0, ...bars.map((b) => b.value), 1);
  const trackWidth = 260;
  const width = labelWidth + trackWidth + 60;
  const height = bars.length * (BAR_HEIGHT + ROW_GAP);
  const fmt = (v: number) => `${v % 1 === 0 ? v : v.toFixed(1)}${unit}`;
  return (
    <figure className="my-2" role="img" aria-label={`${title}: ${bars.map((b) => `${b.label} ${fmt(b.value)}`).join(", ")}`}>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} preserveAspectRatio="xMinYMin meet">
        {bars.map((b, i) => {
          const y = i * (BAR_HEIGHT + ROW_GAP);
          const w = max > 0 ? (b.value / max) * trackWidth : 0;
          const color = b.color ?? CHART_COLORS.series1;
          return (
            <g key={i} transform={`translate(0, ${y})`}>
              <title>{`${b.label}: ${fmt(b.value)}${b.detail ? ` – ${b.detail}` : ""}`}</title>
              <text x={labelWidth - 8} y={BAR_HEIGHT / 2} textAnchor="end" dominantBaseline="middle" fontSize="12" fill="var(--muted)">
                {b.label}
              </text>
              <rect x={labelWidth} y={0} width={trackWidth} height={BAR_HEIGHT} rx={RADIUS} fill={CHART_COLORS.track} />
              <g transform={`translate(${labelWidth}, 0)`}>
                <path d={roundedBarPath(w, BAR_HEIGHT, RADIUS)} fill={color} />
              </g>
              <text x={labelWidth + Math.max(w, 0) + 8} y={BAR_HEIGHT / 2} dominantBaseline="middle" fontSize="12" fill="var(--text)">
                {fmt(b.value)}
              </text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

export type GroupedBar = { label: string; values: [number, number]; detail?: string };

/** Zwei Balken je Kategorie (z. B. Ist/Ziel) mit Legende – kategoriales Blau/Orange-Paar. */
export function GroupedBarChart({ title, legend, bars, unit = "" }: { title: string; legend: [string, string]; bars: GroupedBar[]; unit?: string }) {
  const max = Math.max(1, ...bars.flatMap((b) => b.values));
  const labelWidth = 160;
  const trackWidth = 220;
  const rowHeight = BAR_HEIGHT * 2 + 4;
  const width = labelWidth + trackWidth + 60;
  const height = bars.length * (rowHeight + ROW_GAP);
  const fmt = (v: number) => `${v % 1 === 0 ? v : v.toFixed(1)}${unit}`;
  const colors: [string, string] = [CHART_COLORS.series1, CHART_COLORS.series2];
  return (
    <figure className="my-2">
      <figcaption className="flex items-center gap-4 text-xs mb-1" style={{ color: "var(--muted)" }}>
        {legend.map((l, i) => (
          <span key={i} className="inline-flex items-center gap-1">
            <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: colors[i] }} />
            {l}
          </span>
        ))}
      </figcaption>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} preserveAspectRatio="xMinYMin meet" role="img" aria-label={`${title}: ${bars.map((b) => `${b.label} ${legend[0]} ${fmt(b.values[0])}, ${legend[1]} ${fmt(b.values[1])}`).join("; ")}`}>
        {bars.map((b, i) => {
          const y = i * (rowHeight + ROW_GAP);
          return (
            <g key={i} transform={`translate(0, ${y})`}>
              <title>{`${b.label}: ${legend[0]} ${fmt(b.values[0])}, ${legend[1]} ${fmt(b.values[1])}${b.detail ? ` – ${b.detail}` : ""}`}</title>
              <text x={labelWidth - 8} y={rowHeight / 2} textAnchor="end" dominantBaseline="middle" fontSize="12" fill="var(--muted)">
                {b.label}
              </text>
              {b.values.map((v, s) => {
                const w = (v / max) * trackWidth;
                const y2 = s * (BAR_HEIGHT + 2);
                return (
                  <g key={s}>
                    <rect x={labelWidth} y={y2} width={trackWidth} height={BAR_HEIGHT} rx={RADIUS} fill={CHART_COLORS.track} />
                    <g transform={`translate(${labelWidth}, ${y2})`}>
                      <path d={roundedBarPath(Math.max(w, 0), BAR_HEIGHT, RADIUS)} fill={colors[s]} />
                    </g>
                    <text x={labelWidth + Math.max(w, 0) + 8} y={y2 + BAR_HEIGHT / 2} dominantBaseline="middle" fontSize="11" fill="var(--text)">
                      {fmt(v)}
                    </text>
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
    </figure>
  );
}
