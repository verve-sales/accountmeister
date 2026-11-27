import type { ReactNode } from "react";
import { Icon } from "./Icon";

/** e68: Erklärtexte hinter ein Info-Symbol – auf Klick lesbar, sonst kein Rauschen unter jeder Karte. */
export function Hint({ children, label = "Erläuterung" }: { children: ReactNode; label?: string }) {
  return (
    <details className="hint">
      <summary aria-label={label} title={label}>
        <Icon name="info" size={14} />
        <span>{label}</span>
      </summary>
      <div className="hint-body">{children}</div>
    </details>
  );
}
