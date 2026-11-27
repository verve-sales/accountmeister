import Link from "next/link";
import { getConfig } from "@/lib/config";

/** Reiter eines Projekts (Etappe 9): ein Ort für Überblick, Strategiefaden, Personen & Zugang, Artefakte, Weeklys. */
export function SetupTabs({ setupId, active }: { setupId: string; active: "ueberblick" | "strategie" | "personen" | "artefakte" }) {
  const tabs = [
    { key: "ueberblick", href: `/setups/${setupId}`, label: "Überblick" },
    // e77: dieselbe Reiterleiste wie auf der Projektseite (Arbeit, Wissen, Einstellungen sind Reiter dort)
    { key: "arbeit", href: `/setups/${setupId}?reiter=arbeit`, label: "Arbeit" },
    { key: "wissen", href: `/setups/${setupId}?reiter=wissen`, label: "Wissen" },
    { key: "einstellungen", href: `/setups/${setupId}?reiter=einstellungen`, label: "Einstellungen" },
    { key: "strategie", href: `/setups/${setupId}/strategie`, label: "Strategiefaden" },
    { key: "personen", href: `/setups/${setupId}/personen`, label: "Personen & Zugang" },
    // e44: der Vorlagenkatalog ist standardmäßig ausgeblendet (FEATURE_ARTEFAKTE)
    ...(getConfig().FEATURE_ARTEFAKTE === "true" || active === "artefakte" ? [{ key: "artefakte", href: `/setups/${setupId}/artefakte`, label: "Artefakte" }] : []),
  ];
  return (
    <nav aria-label="Projekt-Bereiche" className="tabs detail-tabs">
      {tabs.map((t) => {
        const isActive = t.key === active;
        return (
          <Link key={t.key} href={t.href} aria-current={isActive ? "page" : undefined} className="tab">
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
