"use client";

import { useEffect, useState, type ReactNode } from "react";

/**
 * e65: Reiter für lange Detailseiten (Chance, Einsatz, Position). Alle Inhalte werden weiterhin gerendert; die Reiter
 * blenden nur Abschnitte ein und aus. Sprungmarken (#auftrag usw.) öffnen automatisch den passenden Reiter, die Wahl steht
 * in der Adresse (?reiter=…), damit Links und „Zurück“ funktionieren.
 */
export type TabDef = { key: string; label: string; count?: number | null };

export function TabPanel({ tab, initial, children }: { tab: string; initial: string; children: ReactNode }) {
  return (
    <div data-tab={tab} hidden={tab !== initial} className="space-y-6">
      {children}
    </div>
  );
}

export function DetailTabsBar({ tabs, initial, label = "Bereiche" }: { tabs: TabDef[]; initial: string; label?: string }) {
  const [active, setActive] = useState(initial);
  const show = (key: string, push = true) => {
    setActive(key);
    for (const p of Array.from(document.querySelectorAll<HTMLElement>("main.page [data-tab]"))) p.hidden = p.dataset.tab !== key;
    if (push) {
      const u = new URL(location.href);
      u.searchParams.set("reiter", key);
      u.hash = "";
      history.replaceState(history.state, "", u.toString());
    }
  };
  useEffect(() => {
    const fromHash = () => {
      const id = decodeURIComponent(location.hash.slice(1));
      const el = id ? document.getElementById(id) : null;
      const panel = el?.closest<HTMLElement>("[data-tab]");
      if (panel && panel.dataset.tab && panel.hidden) {
        setActive(panel.dataset.tab);
        for (const p of Array.from(document.querySelectorAll<HTMLElement>("main.page [data-tab]"))) p.hidden = p !== panel;
        requestAnimationFrame(() => el?.scrollIntoView({ block: "start" }));
      }
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    // Klicks auf Sprungmarken innerhalb der Seite (z. B. „Nächster Schritt“) ebenfalls auflösen
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement | null)?.closest?.("a[href^='#']");
      if (a) setTimeout(fromHash, 0);
    };
    document.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("hashchange", fromHash);
      document.removeEventListener("click", onClick);
    };
  }, []);
  return (
    <nav className="tabs detail-tabs" aria-label={label} role="tablist">
      {tabs.map((t) => (
        <button key={t.key} type="button" role="tab" aria-selected={active === t.key} className="tab" aria-current={active === t.key ? "page" : undefined} onClick={() => show(t.key)}>
          {t.label}
          {t.count != null && <span className="tab-count">{t.count}</span>}
        </button>
      ))}
    </nav>
  );
}
