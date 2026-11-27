import Link from "next/link";
import type { ReactNode } from "react";

/** e64: eine Kennzahlen-Kachel für alle Seiten – Zahl groß, Bezeichnung klein, Farbe nur bei Handlungsbedarf. */
export function KpiTile({ value, label, href, tone }: { value: ReactNode; label: ReactNode; href?: string | null; tone?: "danger" | "warn" | null }) {
  const body = (
    <>
      <div className={`kpi-value${tone ? ` tone-${tone}` : ""}`}>{value}</div>
      <div className="kpi-label">{label}</div>
    </>
  );
  return href ? <Link href={href} className="kpi">{body}</Link> : <div className="kpi">{body}</div>;
}

export function KpiRow({ children, label = "Kennzahlen" }: { children: ReactNode; label?: string }) {
  return <section className="kpi-row" aria-label={label}>{children}</section>;
}
