import Link from "next/link";

/**
 * e73: Genau zwei Umschalter-Bausteine für alle Seiten.
 * - Segmented: Ansichten derselben Menge (Board/Liste, offen/alle, Meine/Team) – eine Auswahl, kein Zähler nötig.
 * - Pills: Teilmengen mit Zähler (Filter); Zähler 0 abgeschwächt. Ein einzelner Pill kann als Schalter dienen (toggle).
 * Beide bleiben Links (Adresse = Zustand), damit Zurück, Lesezeichen und Teilen funktionieren.
 */
export type SwitchItem = { href: string; label: string; active: boolean; count?: number | null; title?: string };

export function Segmented({ items, label, className = "" }: { items: SwitchItem[]; label: string; className?: string }) {
  return (
    <nav className={`seg ${className}`} aria-label={label}>
      {items.map((i) => (
        <Link key={i.href + i.label} href={i.href} className="seg-item" aria-current={i.active ? "page" : undefined} title={i.title} scroll={false}>
          {i.label}
          {i.count != null && <span className="seg-count">{i.count}</span>}
        </Link>
      ))}
    </nav>
  );
}

export function Pills({ items, label, className = "", toggle = false }: { items: SwitchItem[]; label: string; className?: string; toggle?: boolean }) {
  return (
    <nav className={`pills ${className}`} aria-label={label}>
      {items.map((i) => (
        <Link
          key={i.href + i.label}
          href={i.href}
          className="pill"
          aria-current={!toggle && i.active ? "page" : undefined}
          aria-pressed={toggle ? i.active : undefined}
          data-empty={i.count === 0 && !i.active ? "" : undefined}
          title={i.title}
          scroll={false}
        >
          {toggle && <span className="pill-check" aria-hidden="true">{i.active ? "✓" : "+"}</span>}
          {i.label}
          {i.count != null && <span className="pill-count">{i.count}</span>}
        </Link>
      ))}
    </nav>
  );
}
