import type { DashboardView } from "./service";

/** Navigation je Hut (Etappe 37): höchstens fünf Einträge in der ersten Reihe, alles Weitere unter „Mehr“ – nichts geht verloren. */
export type NavLink = { href: string; label: string };

export const ALL_LINKS: Record<string, NavLink> = {
  start: { href: "/start", label: "Start" },
  arbeit: { href: "/meine-arbeit", label: "Meine Arbeit" },
  kunden: { href: "/kunden", label: "Kunden" },
  bds: { href: "/meine-bds", label: "Meine BDs" },
  einsaetze: { href: "/einsaetze", label: "Einsätze" },
  besetzung: { href: "/besetzung", label: "Besetzung" },
  eingang: { href: "/eingang", label: "Eingang" },
  ziele: { href: "/ziele", label: "Ziele" },
  principals: { href: "/meine-principals", label: "Verantwortliche" },
  runde: { href: "/kundenrunde", label: "Kundenrunde" },
};

export const HAT_NAV: Record<DashboardView, string[]> = {
  CEO: ["start", "runde", "principals", "kunden", "einsaetze"],
  PRINCIPAL: ["start", "runde", "bds", "kunden", "einsaetze"],
  BD: ["start", "arbeit", "kunden", "einsaetze", "eingang"],
  ANKER: ["start", "arbeit", "kunden", "eingang"],
  SALES_OPS: ["start", "einsaetze", "besetzung", "arbeit", "kunden"],
  COACH: ["start", "bds", "kunden", "einsaetze"],
};

/** Ohne Hut (keine fachliche Rolle): die bisherige Grundnavigation. */
export const DEFAULT_NAV = ["start", "arbeit", "kunden"];

/** Teilt die erlaubten Links in erste Reihe (nach Hut) und „Mehr“. `allowed` = Schlüssel, die die Person überhaupt sehen darf. */
export function splitNav(hat: DashboardView | null, allowed: Set<string>): { main: NavLink[]; more: NavLink[] } {
  const order = hat ? HAT_NAV[hat] : DEFAULT_NAV;
  const main = order.filter((k) => allowed.has(k)).map((k) => ALL_LINKS[k]!);
  const more = Object.keys(ALL_LINKS).filter((k) => allowed.has(k) && !order.includes(k)).map((k) => ALL_LINKS[k]!);
  return { main, more };
}
