"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

/**
 * Zwei Oberflächen auf denselben Daten (e49): Accountmeister (Vertrieb) und Assignmentmanager (Sales Operations,
 * Backoffice, Geschäftsführung). Unter /assignments gilt immer der Assignmentmanager; Seiten, die beide nutzen
 * (Einsatz, Übergabe, Benachrichtigungen …), behalten die Oberfläche, aus der man kommt.
 */
const SHARED = ["/einsaetze", "/uebergaben", "/benachrichtigungen", "/einstellungen", "/hilfe", "/suche", "/quellen", "/moco", "/verwaltung/sharepoint", "/vertragsbuero", "/besetzung/freelancer"];
type App = "am" | "asg";

export function AppChrome({ initial, am, asg, children }: { initial: App; am: ReactNode; asg: ReactNode | null; children: ReactNode }) {
  const path = usePathname() ?? "/";
  const [last, setLast] = useState<App>(initial);
  const fixed: App | null = !asg ? "am" : path.startsWith("/assignments") ? "asg" : SHARED.some((p) => path === p || path.startsWith(`${p}/`)) ? null : "am";
  const app = fixed ?? last;
  // Zustand beim Rendern nachführen (kein Effekt nötig); der Cookie merkt sich die Wahl für den nächsten Seitenaufruf
  if (fixed && fixed !== last) setLast(fixed);
  useEffect(() => {
    document.cookie = `vm_app=${app}; path=/; max-age=31536000; samesite=lax`;
  }, [app]);
  return (
    <div data-app={app}>
      {app === "asg" && asg ? asg : am}
      {children}
    </div>
  );
}
