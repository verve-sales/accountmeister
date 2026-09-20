import Link from "next/link";

/** Reiter eines Setups (Etappe 9): ein Ort für Überblick, Strategiefaden, Personen & Zugang, Artefakte, Weeklys. */
export function SetupTabs({ setupId, active }: { setupId: string; active: "ueberblick" | "strategie" | "personen" | "artefakte" }) {
  const tabs = [
    { key: "ueberblick", href: `/setups/${setupId}`, label: "Überblick" },
    { key: "strategie", href: `/setups/${setupId}/strategie`, label: "Strategiefaden" },
    { key: "personen", href: `/setups/${setupId}/personen`, label: "Personen & Zugang" },
    { key: "artefakte", href: `/setups/${setupId}/artefakte`, label: "Artefakte" },
    { key: "weeklys", href: `/weeklys?setup=${setupId}`, label: "Weeklys" },
  ] as const;
  return (
    <nav aria-label="Setup-Bereiche" className="flex flex-wrap gap-1 border-b text-sm" style={{ borderColor: "var(--border)" }}>
      {tabs.map((t) => {
        const isActive = t.key === active;
        return (
          <Link key={t.key} href={t.href} aria-current={isActive ? "page" : undefined} className="no-underline px-3 py-2" style={{ color: isActive ? "var(--text)" : undefined, fontWeight: isActive ? 600 : 400, borderBottom: isActive ? "2px solid var(--text)" : "2px solid transparent", marginBottom: -1 }}>
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
