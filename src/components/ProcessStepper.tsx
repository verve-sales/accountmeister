/**
 * Visuelle Prozessleiste ("Wo stehen wir gerade?") – macht eine bestehende, geordnete Zustandskette (z. B.
 * Chance-Reifegrad, Setup-Stufe) auf einen Blick lesbar, statt als Fließtext mit Pfeilen. Reine Anzeige: es werden
 * keine neuen Zustände erfunden, nur vorhandene (aus VERLAUF/STAGES) visualisiert. Erfüllte Schritte: gefüllter
 * Kreis mit Häkchen; aktueller Schritt: Ring + fetter Text (aria-current="step"); künftige Schritte: schwach.
 * Ein Seitenzweig (zurückgestellt/beendet) wird als eigenes Element danach gezeigt, nicht in die Kette gemischt.
 */

export type ProcessStep = { key: string; label: string };
export type ProcessEndState = { label: string; reason?: string | null; tone?: "warn" | "muted" };

export function ProcessStepper({
  steps,
  currentKey,
  endState,
  note,
  variant = "full",
}: {
  steps: ProcessStep[];
  currentKey: string;
  endState?: ProcessEndState | null;
  note?: string | null;
  /** "full": Kreise mit Beschriftung je Schritt (Detailseiten). "compact": kleine Punktreihe + Text nur des aktuellen Schritts (Tabellenzeilen, Listen). */
  variant?: "full" | "compact";
}) {
  const idx = steps.findIndex((s) => s.key === currentKey);
  const currentLabel = idx >= 0 ? steps[idx]!.label : currentKey;

  if (variant === "compact") {
    return (
      <span className="pstepper-compact" role="img" aria-label={`Prozessstufe: ${endState ? endState.label : currentLabel}, Schritt ${Math.max(idx, 0) + 1} von ${steps.length}`}>
        <span className="pstepper-dots" aria-hidden="true">
          {steps.map((s, i) => (
            <span key={s.key} className="pstepper-dot-sm" data-state={i < idx ? "done" : i === idx ? "current" : "todo"} />
          ))}
        </span>
        {endState ? <span className={endState.tone === "warn" ? "status" : "muted text-sm"}>{endState.label}</span> : <span className="text-sm font-medium">{currentLabel}</span>}
      </span>
    );
  }

  return (
    <div className="pstepper">
      <ol className="pstepper-row" aria-label="Prozessstufe">
        {steps.map((s, i) => {
          const state = i < idx ? "done" : i === idx ? "current" : "todo";
          return (
            <li key={s.key} className="pstepper-step" aria-current={i === idx ? "step" : undefined}>
              {i > 0 && <span className="pstepper-line" data-filled={i <= idx} />}
              <span className="pstepper-dot" data-state={state} aria-hidden="true">
                {state === "done" ? "✓" : i + 1}
              </span>
              <span className={state === "current" ? "pstepper-label pstepper-label-current" : state === "done" ? "pstepper-label" : "pstepper-label muted"}>
                {s.label}
                <span className="sr-only">{state === "done" ? " – erledigt" : state === "current" ? " – aktueller Schritt" : " – noch offen"}</span>
              </span>
            </li>
          );
        })}
      </ol>
      {endState && (
        <p className="mt-2">
          <span className={endState.tone === "warn" ? "status" : "muted text-sm"}>{endState.label}</span>
          {endState.reason && <span className="muted text-sm"> · {endState.reason}</span>}
        </p>
      )}
      {note && !endState && <p className="muted text-sm mt-2">Nächster großer Schritt: {note}</p>}
    </div>
  );
}
