import type { ReactNode } from "react";

/**
 * Interne bzw. technische Bezüge (Briefing-Abschnitte, Entscheidungsnummern, Konfigurationsnamen) bleiben erhalten,
 * stehen aber nicht im Lesefluss: als kleines Info-Zeichen mit Tooltip bzw. als eingeklappter Bereich.
 */
export function TechRef({ children }: { children: string }) {
  return <span className="techref" title={children} aria-label={`Technischer Bezug: ${children}`}>ⓘ</span>;
}

export function TechDetails({ children, summary = "Technische Details (für die Betriebsverwaltung)" }: { children: ReactNode; summary?: string }) {
  return (
    <details className="techdetails muted text-xs mt-2">
      <summary>{summary}</summary>
      <div className="mt-1 space-y-1">{children}</div>
    </details>
  );
}
