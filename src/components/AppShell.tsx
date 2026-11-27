"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Icon } from "./Icon";
import { TableTools } from "./TableTools";
import { FormControls } from "./FormControls";
import { Peek } from "./Peek";

export type NavItem = { href: string; label: string; icon: string; badge?: number };
export type NavSection = { label: string | null; icon?: string; items: NavItem[] };

/** e66: Detailseiten ohne eigenen Menüpunkt dem passenden Bereich zuordnen (nur für die Markierung in der Seitenleiste). */
const AREA_PREFIX: Record<string, string[]> = {
  Heute: ["/vorgaenge", "/suche", "/eingang", "/team"],
  Kunden: ["/kunden", "/setups", "/health", "/quellen", "/interviews", "/meine-bds"],
  Pipeline: ["/bedarfe", "/chancen", "/besetzung"],
  Einsätze: ["/einsaetze", "/assignments", "/auftragseingang"],
  Steuerung: ["/weeklys", "/meine-principals", "/kundenverantwortliche", "/ziele", "/fuehrung", "/team", "/ceo"],
  Operations: ["/vertragsbuero", "/sales-ops", "/bereinigung", "/moco"],
  Einrichtung: ["/verwaltung"],
  "Wissen & Werkzeuge": ["/vorgehen", "/artefakte", "/provision", "/hilfe"],
};

/** e73: Detailseiten markieren den Menüpunkt, unter dem sie fachlich liegen (Seitenleiste und Brotkrume). */
const ITEM_PREFIX: [string, string][] = [
  ["/bedarfe", "/chancen"],
  ["/einsaetze", "/assignments"],
  ["/setups", "/kunden"],
  ["/health", "/kunden"],
  ["/quellen", "/kunden"],
  ["/interviews", "/kunden"],
  ["/vorgaenge", "/meine-arbeit"],
  ["/team", "/meine-arbeit"],
  ["/meine-principals", "/kundenverantwortliche"],
  ["/vertragsbuero", "/sales-ops"],
  ["/fuehrung", "/ziele"],
];

/**
 * e64: Eine Oberfläche für Accountmeister und Assignmentmanager – feste Seitenleiste mit Bereichen statt zwei
 * Kopfzeilen und App-Schalter. Auf schmalen Bildschirmen wird die Leiste zur Schublade (Menü-Knopf in der Kopfzeile).
 * Rein Darstellung: dieselben Ziele wie zuvor, die Rechte prüft weiterhin der Server.
 */
export function AppShell({ sections, brand, topbar, children }: { sections: NavSection[]; brand: ReactNode; topbar: ReactNode; children: ReactNode }) {
  const path = usePathname() ?? "/";
  const [open, setOpen] = useState(false);
  const [lastPath, setLastPath] = useState(path);
  if (path !== lastPath) {
    setLastPath(path);
    setOpen(false);
  }
  // aktiver Eintrag: längster passender Pfad (Kontaktpate und Abfrage ignoriert)
  const all = sections.flatMap((s) => s.items.map((i) => i.href.split(/[?#]/)[0]!));
  const direct = all.filter((h) => path === h || (h !== "/" && path.startsWith(`${h}/`))).sort((a, b) => b.length - a.length)[0];
  const mapped = ITEM_PREFIX.find(([p]) => path === p || path.startsWith(`${p}/`))?.[1];
  const active = direct ?? (mapped && all.includes(mapped) ? mapped : undefined);
  // Bereich: über die Menüpunkte, sonst über bekannte Pfadanfänge (Detailseiten)
  let activeArea = active ? sections.findIndex((s) => s.items.some((it) => it.href.split(/[?#]/)[0] === active)) : -1;
  if (activeArea < 0) activeArea = sections.findIndex((s) => (AREA_PREFIX[s.label ?? ""] ?? []).some((p) => path === p || path.startsWith(`${p}/`)));
  const area = activeArea >= 0 ? sections[activeArea] : undefined;
  const activeItem = area?.items.find((it) => it.href.split(/[?#]/)[0] === active);
  const areaLabel = area?.label ?? null;
  // e64: Seitentitel aus der Überschrift (Tabs, Verlauf, Lesezeichen) und Spaltennamen für die Kartenansicht auf dem Handy
  useEffect(() => {
    const apply = () => {
      const h1 = document.querySelector("main.page h1");
      const t = h1?.textContent?.replace(/\s+/g, " ").trim();
      if (t) document.title = [t, areaLabel && areaLabel !== t ? areaLabel : null, "Accountmeister"].filter(Boolean).join(" · ");
      for (const table of Array.from(document.querySelectorAll<HTMLTableElement>("main.page table.list"))) {
        const heads = Array.from(table.querySelectorAll("thead th")).map((th) => th.textContent?.trim() ?? "");
        if (!heads.length) continue;
        table.classList.add("stackable");
        for (const row of Array.from(table.querySelectorAll("tbody tr"))) {
          Array.from(row.children).forEach((td, i) => { if (heads[i] && !td.hasAttribute("data-label")) td.setAttribute("data-label", heads[i]!); });
        }
      }
    };
    apply();
    const mo = new MutationObserver(() => apply());
    const main = document.querySelector("main.page");
    if (main) mo.observe(main, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [path, areaLabel]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="shell" data-nav={open ? "open" : "closed"}>
      <aside className="sidebar" aria-label="Navigation">
        <div className="sidebar-brand">{brand}</div>
        <nav aria-label="Hauptnavigation" className="sidebar-nav">
          {sections.map((s, i) => {
            const isActive = i === activeArea;
            return (
              <div key={s.label ?? i} className={isActive && s.items.length > 1 ? "nav-area nav-area-open" : "nav-area"}>
                <Link href={s.items[0]!.href} className="nav-item" aria-current={isActive ? "page" : undefined}>
                  <Icon name={s.icon ?? s.items[0]!.icon} size={17} />
                  <span className="nav-item-label">{s.label ?? s.items[0]!.label}</span>
                </Link>
                {isActive && s.items.length > 1 && (
                  <div className="nav-sub">
                    {s.items.map((it) => {
                      const base = it.href.split(/[?#]/)[0];
                      return (
                        <Link key={it.href} href={it.href} className="nav-subitem" aria-current={base === active && !it.href.includes("#") ? "page" : undefined}>
                          {it.label}
                          {it.badge ? <span className="nav-badge">{it.badge > 99 ? "99+" : it.badge}</span> : null}
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>
      </aside>
      <div className="sidebar-scrim" onClick={() => setOpen(false)} aria-hidden="true" />
      <div className="shell-main">
        <header className="topbar">
          <button type="button" className="icon-btn nav-toggle" onClick={() => setOpen((o) => !o)} aria-label={open ? "Navigation schließen" : "Navigation öffnen"} aria-expanded={open}>
            <Icon name={open ? "x" : "menu"} size={20} />
          </button>
          {topbar}
        </header>
        <main className="page">
          {area && (
            <nav className="crumbs auto-crumbs" aria-label="Pfad">
              <Link href={area.items[0]!.href}>{area.label}</Link>
              {activeItem && activeItem.label !== area.label && (path === activeItem.href.split(/[?#]/)[0] ? <span>{activeItem.label}</span> : <Link href={activeItem.href}>{activeItem.label}</Link>)}
            </nav>
          )}
          {children}
        </main>
        <TableTools />
        <FormControls />
        <Peek />
      </div>
    </div>
  );
}
