"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Lädt die Seite leise nach, solange im Hintergrund etwas läuft (Eingangs-Auswertung). */
export function AutoRefresh({ everyMs = 5000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(t);
  }, [router, everyMs]);
  return null;
}
