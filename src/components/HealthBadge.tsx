import type { Level } from "@/modules/health/service";
import { levelLabel } from "@/modules/health/service";

/** Sattelfestigkeit als Zahl + Stufe. Farbe nie allein: Stufe steht immer als Text daneben. */
const tone: Record<Level, { bg: string; fg: string }> = {
  SATTELFEST: { bg: "var(--ok-soft)", fg: "var(--ok)" },
  WACKELIG: { bg: "var(--warn-soft)", fg: "var(--warn)" },
  GEFAEHRDET: { bg: "#fdecec", fg: "#8a1c1c" },
  UNKLAR: { bg: "var(--surface-2)", fg: "var(--muted)" },
};

export function HealthBadge({ score, level, coverage, size = "small" }: { score: number | null; level: Level; coverage: number; size?: "small" | "large" }) {
  const t = tone[level];
  if (size === "large") {
    return (
      <div className="flex flex-wrap items-baseline gap-3">
        <span className="text-4xl font-semibold" style={{ color: t.fg, fontVariantNumeric: "tabular-nums" }}>{score ?? "–"}</span>
        <span className="muted text-sm">/ 100</span>
        <span className="status" style={{ background: t.bg, color: t.fg, borderColor: "transparent" }}>{levelLabel[level]}</span>
        <span className="muted text-sm">Datenlage {coverage} %</span>
      </div>
    );
  }
  return (
    <span className="status" style={{ background: t.bg, color: t.fg, borderColor: "transparent" }} title={`Datenlage ${coverage} %`}>
      {score ?? "–"} · {levelLabel[level]}
    </span>
  );
}
