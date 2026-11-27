"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Icon } from "./Icon";

export type NavItem = { href: string; label: string; icon: string; badge?: number };
export type NavSection = { label: string | null; items: NavItem[] };

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
  // e64: Seitentitel aus der Überschrift (Tabs, Verlauf, Lesezeichen) und Spaltennamen für die Kartenansicht auf dem Handy
  useEffect(() => {
    const apply = () => {
      const h1 = document.querySelector("main.page h1");
      const t = h1?.textContent?.replace(/\s+/g, " ").trim();
      if (t) document.title = `${t} · Accountmeister`;
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
  }, [path]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  // aktiver Eintrag: längster passender Pfad (Anker und Abfrage ignoriert)
  const all = sections.flatMap((s) => s.items.map((i) => i.href.split(/[?#]/)[0]!));
  const active = all.filter((h) => path === h || (h !== "/" && path.startsWith(`${h}/`))).sort((a, b) => b.length - a.length)[0];
  return (
    <div className="shell" data-nav={open ? "open" : "closed"}>
      <aside className="sidebar" aria-label="Navigation">
        <div className="sidebar-brand">{brand}</div>
        <nav aria-label="Hauptnavigation" className="sidebar-nav">
          {sections.map((s, i) => (
            <div key={s.label ?? i} className="nav-section">
              {s.label && <div className="nav-section-label">{s.label}</div>}
              {s.items.map((it) => {
                const base = it.href.split(/[?#]/)[0];
                const isActive = base === active && !it.href.includes("#");
                return (
                  <Link key={it.href} href={it.href} className="nav-item" aria-current={isActive ? "page" : undefined}>
                    <Icon name={it.icon} size={17} />
                    <span className="nav-item-label">{it.label}</span>
                    {it.badge ? <span className="nav-badge">{it.badge > 99 ? "99+" : it.badge}</span> : null}
                  </Link>
                );
              })}
            </div>
          ))}
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
        <main className="page">{children}</main>
      </div>
    </div>
  );
}
