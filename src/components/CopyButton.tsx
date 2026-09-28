"use client";

import { useState } from "react";

/** Kopiert einen Entwurf in die Zwischenablage – zum Einfügen in Outlook, Teams usw. Nichts wird versendet. */
export function CopyButton({ text, label = "Kopieren" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-secondary btn-small"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          setDone(false);
        }
      }}
    >
      {done ? "Kopiert" : label}
    </button>
  );
}
