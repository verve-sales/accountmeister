"use client";

import { useRef, useState } from "react";

/**
 * „Vorschlagen lassen“ (Etappe 9): holt einen KI-Vorschlag für das umgebende Formular und trägt ihn in die
 * Felder ein. Nichts wird gespeichert – der Nutzer prüft, ändert und klickt selbst auf Speichern.
 * Felder werden über ihren name-Attribut im nächsten <form> gefunden.
 */
export type SuggestField = { name: string; label: string; options?: string[] };

export function SuggestButton({ kind, accountId, setupId, opportunityId, fields, label = "Vorschlagen lassen" }: { kind: "VORHABEN" | "SETUP" | "CHANCE" | "MEDDPICC"; accountId?: string; setupId?: string; opportunityId?: string; fields: SuggestField[]; label?: string }) {
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<{ text: string; kind: "ok" | "hinweis" | "fehler"; missing?: string[]; quote?: string } | null>(null);
  const ref = useRef<HTMLSpanElement>(null);

  async function run() {
    const form = ref.current?.closest("form");
    if (!form || busy) return;
    setBusy(true);
    setInfo(null);
    try {
      const res = await fetch("/api/vorschlag", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, accountId: accountId ?? "", setupId: setupId ?? "", opportunityId: opportunityId ?? "", fields }) });
      const j = (await res.json().catch(() => ({}))) as { error?: string; suggestion?: { fields: Record<string, string>; rationale: string; evidenceQuote: string; missing: string[] } | null; note?: string; missing?: string[] };
      if (!res.ok) throw new Error(j.error ?? "Fehler");
      if (!j.suggestion) {
        setInfo({ text: j.note ?? "Kein Vorschlag möglich.", kind: "hinweis", missing: j.missing });
        return;
      }
      let filled = 0;
      for (const [name, value] of Object.entries(j.suggestion.fields)) {
        const el = form.elements.namedItem(name);
        if (!el) continue;
        const target = el instanceof RadioNodeList ? null : (el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement);
        if (!target) continue;
        if (target instanceof HTMLSelectElement) {
          if ([...target.options].some((o) => o.value === value)) {
            target.value = value;
            filled++;
          }
        } else {
          target.value = value;
          filled++;
        }
        target.dispatchEvent(new Event("input", { bubbles: true }));
      }
      setInfo({ text: `${filled} Feld(er) vorbelegt. ${j.suggestion.rationale}`.trim(), kind: "ok", missing: j.suggestion.missing, quote: j.suggestion.evidenceQuote });
    } catch (e) {
      setInfo({ text: e instanceof Error ? e.message : "Fehler", kind: "fehler" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <span ref={ref} className="inline-flex flex-col items-start gap-1" style={{ maxWidth: 480 }}>
      <button type="button" className="btn btn-secondary btn-small" onClick={run} disabled={busy} title="KI belegt die Felder aus dem bekannten Kundenkontext vor – nichts wird ohne Speichern angelegt.">
        {busy ? "…" : label}
      </button>
      {info && (
        <span className={`text-xs ${info.kind === "fehler" ? "error" : "muted"}`} role={info.kind === "fehler" ? "alert" : "status"}>
          {info.text}
          {info.quote && <> · Textstelle: „{info.quote.length > 120 ? `${info.quote.slice(0, 117)}…` : info.quote}“</>}
          {info.missing && info.missing.length > 0 && <> · Fehlt: {info.missing.join(" ")}</>}
        </span>
      )}
    </span>
  );
}
