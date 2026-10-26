/** Ist gegen Ziel (Etappe 38): Zahl in Textfarbe, dünner Balken als Fortschritt; ohne Ziel nur der Ist-Wert. */
export function TargetProgress({ actual, target, unit = "", hint }: { actual: number | null; target: number | null; unit?: string; hint?: string }) {
  if (actual === null && target === null) return <span className="muted">–</span>;
  const pct = target && actual !== null ? Math.min(100, Math.round((actual / target) * 100)) : null;
  const reached = target !== null && actual !== null && actual >= target;
  return (
    <span style={{ display: "inline-block", minWidth: 96 }} title={hint}>
      <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>{actual === null ? "–" : `${actual}${unit}`}</span>
      {target !== null ? <span className="muted"> / {target}{unit}</span> : <span className="muted text-xs"> · kein Ziel</span>}
      {pct !== null && (
        <span aria-hidden="true" style={{ display: "block", height: 4, borderRadius: 4, background: "var(--surface-2, #eceae6)", marginTop: 3 }}>
          <span style={{ display: "block", height: 4, borderRadius: 4, width: `${Math.max(pct, 3)}%`, background: reached ? "#2f7d4f" : "#2c5aa0" }} />
        </span>
      )}
    </span>
  );
}
