/**
 * Provisionsrechner (Vermittlung von Kolleg:innen und Freelancern) – Nachbau des Musters
 * „Verve_Freelancer_ProvisionV2.xlsx“. Reine Rechenlogik, keine Speicherung.
 *
 * Rechenweg je Deal:
 *   Umsatz          = Tage × VK
 *   Bruttomarge     = Tage × (VK − EK)
 *   Kosten          = gestaffelte Kostenpauschale je Einsatztag (Tag 1–50, 51–100, ab 101)
 *   Nettomarge      = Bruttomarge − Kosten;  Nettomarge % = Nettomarge / Umsatz
 *   Provisionssatz  = Stufe nach Nettomarge % (höchste Eintrittshürde ≤ Nettomarge %)
 *   Basisprovision  = Nettomarge × Provisionssatz (bei Satz 0 bzw. negativer Marge: 0)
 *   Finding Fee     = Finding Fee je Deal × eigener Anteil
 *   Signing Fee     = Signing Fee je Deal × eigener Anteil
 *   Provision ges.  = Basisprovision + Finding Fee + Signing Fee
 *
 * Rollenregel: Die Stufen über 15 % (20 % ab 20 % Nettomarge, 43 % ab 45 % Nettomarge) gelten nur für Principals;
 * BDs und Anker erhalten höchstens 15 %.
 */

export const PROVISION_CONFIG = {
  /** Kostenpauschale EUR je Einsatztag, gestaffelt */
  costTiers: [
    { upToDay: 50, perDay: 40 },
    { upToDay: 100, perDay: 40 },
    { upToDay: Infinity, perDay: 40 },
  ],
  findingFee: 250,
  signingFee: 1000,
  /** Eintrittshürde (Nettomarge %, ab) → Provisionssatz; aufsteigend */
  tiers: [
    { key: "KEINE", label: "Keine Provision", from: 0, rate: 0, color: "Rot", principalOnly: false },
    { key: "BASIS", label: "Basis", from: 0.1, rate: 0.1, color: "Orange", principalOnly: false },
    { key: "STANDARD", label: "Standard", from: 0.17, rate: 0.15, color: "Grün", principalOnly: false },
    { key: "PREMIUM", label: "Premium", from: 0.2, rate: 0.2, color: "Grün (Principal)", principalOnly: true },
    { key: "PRINCIPAL", label: "Principal", from: 0.45, rate: 0.43, color: "Blau", principalOnly: true },
  ],
  /** Höchstsatz für BDs und Anker */
  nonPrincipalMaxRate: 0.15,
} as const;

/** Feste Einkaufspreise (EUR/Tag) der internen Rollen */
export const INTERNAL_ROLES: { key: string; label: string; ek: number }[] = [
  { key: "ASSOCIATE", label: "Associate", ek: 500 },
  { key: "ANALYST_CONSULTANT", label: "Analyst Consultant", ek: 576 },
  { key: "CONSULTANT", label: "Consultant", ek: 672 },
  { key: "CONSULTANT_2", label: "Consultant Lvl 2", ek: 736 },
  { key: "SPECIALIST", label: "Specialist", ek: 828 },
  { key: "SENIOR_SPECIALIST", label: "Senior Specialist", ek: 874 },
  { key: "SENIOR_CONSULTANT", label: "Senior Consultant", ek: 880 },
  { key: "EXECUTIVE_CONSULTANT", label: "Executive Consultant", ek: 1012 },
  { key: "DIRECTOR", label: "Director", ek: 1320 },
];
export const FREELANCER = "FREELANCER";

export type Recipient = "PRINCIPAL" | "BD" | "ANKER";

export type DealInput = {
  /** Rolle aus INTERNAL_ROLES oder FREELANCER */
  profile: string;
  /** nur für Freelancer (intern fest) */
  ek?: number | null;
  vk: number | null;
  days: number | null;
  /** eigener Anteil an der Finding Fee, 0–100 % */
  findingShare?: number | null;
  /** eigener Anteil an der Signing Fee, 0–100 % */
  signingShare?: number | null;
};

export type DealResult = {
  ek: number;
  revenue: number;
  grossMargin: number;
  grossMarginPct: number;
  costs: number;
  netMargin: number;
  netMarginPct: number;
  tierKey: string;
  rate: number;
  /** Satz, den die Marge für Principals ergäbe – zeigt, wann die Deckelung greift */
  uncappedRate: number;
  capped: boolean;
  baseCommission: number;
  findingFee: number;
  signingFee: number;
  total: number;
  warnings: string[];
};

export function costsFor(days: number, cfg = PROVISION_CONFIG): number {
  let prev = 0;
  let sum = 0;
  for (const t of cfg.costTiers) {
    const n = Math.max(0, Math.min(days, t.upToDay) - prev);
    sum += n * t.perDay;
    prev = t.upToDay;
    if (days <= t.upToDay) break;
  }
  return sum;
}

export function tierFor(netPct: number, recipient: Recipient, cfg = PROVISION_CONFIG) {
  const eligible = cfg.tiers.filter((t) => recipient === "PRINCIPAL" || !t.principalOnly);
  let tier: (typeof cfg.tiers)[number] = cfg.tiers[0];
  for (const t of eligible) if (netPct >= t.from) tier = t;
  let full: (typeof cfg.tiers)[number] = cfg.tiers[0];
  for (const t of cfg.tiers) if (netPct >= t.from) full = t;
  const rate = recipient === "PRINCIPAL" ? tier.rate : Math.min(tier.rate, cfg.nonPrincipalMaxRate);
  return { tier, rate, uncappedRate: full.rate, capped: full.rate > rate };
}

const clampPct = (v: number | null | undefined, dflt = 100) => {
  const n = v === null || v === undefined || Number.isNaN(v) ? dflt : v;
  return Math.max(0, Math.min(100, n)) / 100;
};

/** null, solange Pflichtangaben fehlen */
export function computeDeal(input: DealInput, recipient: Recipient, cfg = PROVISION_CONFIG): DealResult | null {
  const internal = INTERNAL_ROLES.find((r) => r.key === input.profile);
  const ek = internal ? internal.ek : input.ek ?? null;
  if (ek === null || ek === undefined || !input.vk || !input.days || input.days <= 0 || input.vk <= 0 || ek < 0) return null;
  const revenue = input.days * input.vk;
  const grossMargin = input.days * (input.vk - ek);
  const costs = costsFor(input.days, cfg);
  const netMargin = grossMargin - costs;
  const netMarginPct = revenue ? netMargin / revenue : 0;
  const t = tierFor(netMarginPct, recipient, cfg);
  const baseCommission = t.rate > 0 && netMargin > 0 ? netMargin * t.rate : 0;
  const findingFee = cfg.findingFee * clampPct(input.findingShare);
  const signingFee = cfg.signingFee * clampPct(input.signingShare);
  const warnings: string[] = [];
  if (netMargin < 0) warnings.push("Negative Nettomarge – der VK liegt unter EK plus Kostenpauschale.");
  if (t.capped) warnings.push(`Für Principals ergäbe diese Marge ${Math.round(t.uncappedRate * 100)} %; BDs und Anker erhalten höchstens ${Math.round(cfg.nonPrincipalMaxRate * 100)} %.`);
  return {
    ek,
    revenue,
    grossMargin,
    grossMarginPct: revenue ? grossMargin / revenue : 0,
    costs,
    netMargin,
    netMarginPct,
    tierKey: t.tier.key,
    rate: t.rate,
    uncappedRate: t.uncappedRate,
    capped: t.capped,
    baseCommission,
    findingFee,
    signingFee,
    total: baseCommission + findingFee + signingFee,
    warnings,
  };
}

/** Legende je Empfänger – aus der Konfiguration erzeugt, damit Text und Rechnung nie auseinanderlaufen. */
export function legendFor(recipient: Recipient, cfg = PROVISION_CONFIG): { color: string; text: string }[] {
  const pct = (x: number) => `${(x * 100).toLocaleString("de-DE", { maximumFractionDigits: 1 })} %`;
  const tiers = cfg.tiers.filter((t) => recipient === "PRINCIPAL" || !t.principalOnly);
  return tiers.map((t, i) => {
    const next = tiers[i + 1];
    const rate = recipient === "PRINCIPAL" ? t.rate : Math.min(t.rate, cfg.nonPrincipalMaxRate);
    const range = i === 0 ? `Nettomarge < ${pct(next!.from)}` : next ? `Nettomarge ${pct(t.from)} bis < ${pct(next.from)}` : `Nettomarge ab ${pct(t.from)}`;
    const what = rate === 0 ? `${pct(0)} Basisprovision (Finding und Signing Fee bleiben bestehen)` : `${pct(rate)} auf die Nettomarge${t.key === "PRINCIPAL" ? " (Premium, nur Principals)" : ""}${!next && recipient !== "PRINCIPAL" ? " (Höchstsatz für BDs und Anker)" : ""}`;
    return { color: t.color.replace(" (Principal)", ""), text: `${range} → ${what}` };
  });
}
