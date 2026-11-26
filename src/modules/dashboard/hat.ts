import type { DashboardView } from "./service";

/** Navigation je Hut (Etappe 37): höchstens fünf Einträge in der ersten Reihe, alles Weitere unter „Mehr“ – nichts geht verloren. */
export type NavLink = { href: string; label: string };

export const ALL_LINKS: Record<string, NavLink> = {
  start: { href: "/start", label: "Start" },
  kunden: { href: "/kunden", label: "Kunden" },
  bds: { href: "/meine-bds", label: "Meine BDs" },
  einsaetze: { href: "/einsaetze", label: "Einsätze" },
  besetzung: { href: "/besetzung", label: "Besetzung" },
  ziele: { href: "/ziele", label: "Ziele & Portfolio" },
  principals: { href: "/meine-principals", label: "Kundenverantwortliche" },
  runde: { href: "/kundenrunde", label: "Kundenrunde" },
  salesops: { href: "/vertragsbuero", label: "Sales-Ops-Sicht" },
  bereinigung: { href: "/bereinigung", label: "Bereinigung" },
};

export const HAT_NAV: Record<DashboardView, string[]> = {
  CEO: ["start", "runde", "principals", "kunden", "einsaetze"],
  PRINCIPAL: ["start", "runde", "bds", "kunden", "einsaetze"],
  BD: ["start", "kunden", "einsaetze", "besetzung"],
  ANKER: ["start", "kunden"],
  SALES_OPS: ["start", "salesops", "einsaetze", "besetzung", "kunden"],
  COACH: ["start", "bds", "kunden", "einsaetze"],
};

/** Ohne Hut (keine fachliche Rolle): die bisherige Grundnavigation. */
export const DEFAULT_NAV = ["start", "kunden"];

/**
 * e62: Feste Hauptnavigation – gleiche Reihenfolge für alle Rollen (UX-Gutachten Maßnahme 2). Was einer Rolle nicht
 * zusteht, fehlt; die Reihenfolge der übrigen bleibt stabil. Der Hut bestimmt nur noch die Startseite.
 */
export const MAIN_NAV = ["start", "kunden", "runde", "einsaetze", "besetzung"];
/** „Mehr“ in Gruppen statt einer Sammelliste */
export const MORE_GROUPS: { label: string; keys: string[] }[] = [
  { label: "Steuerung", keys: ["principals", "bds", "ziele"] },
  { label: "Operations", keys: ["salesops", "bereinigung"] },
];

/** Teilt die erlaubten Links in die feste erste Reihe und gruppiertes „Mehr“. `allowed` = Schlüssel, die die Person überhaupt sehen darf. */
export function splitNav(_hat: DashboardView | null, allowed: Set<string>): { main: NavLink[]; more: NavLink[]; groups: { label: string; links: NavLink[] }[] } {
  const main = MAIN_NAV.filter((k) => allowed.has(k)).map((k) => ALL_LINKS[k]!);
  const groups = MORE_GROUPS.map((g) => ({ label: g.label, links: g.keys.filter((k) => allowed.has(k)).map((k) => ALL_LINKS[k]!) }));
  return { main, more: groups.flatMap((g) => g.links), groups };
}
