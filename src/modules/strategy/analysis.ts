import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { db, schema } from "@/db/client";
import type { Actor } from "@/modules/identity/actor";
import { canViewSetup, type SetupContext } from "@/modules/identity/authz";
import { getBuyingCenter } from "@/modules/people/assessments";
import { opportunityStatusLabel } from "@/lib/labels";
import { chanceKindLabel } from "@/modules/ai/schemas";
import { listRoles } from "@/modules/roles/catalog";
import { getFocus } from "@/modules/focus/service";

/**
 * Regelbasierte Lageanalyse je Setup (Etappe 9): Wo stehen wir, was ist der nächste große Schritt, was blockiert,
 * was fehlt, welche Züge liegen nahe. Grundlage für Dashboard-Karten und Strategiefaden. Zählt und benennt nur,
 * was im Tool dokumentiert ist – keine Umsatz- oder Wahrscheinlichkeitswerte (Briefing 7, 11.3).
 */

export const STAGES = ["KONTAKT", "BEDARF_IN_KLAERUNG", "BEDARF_BESTAETIGT", "ANGEBOT", "AUSWAHL", "BEAUFTRAGT", "GESTARTET"] as const;
export type Stage = (typeof STAGES)[number];

export const stageLabel: Record<Stage, string> = {
  KONTAKT: "Kontakt & Kontext",
  BEDARF_IN_KLAERUNG: "Chance in Klärung",
  BEDARF_BESTAETIGT: "Chance bestätigt",
  ANGEBOT: "Angebot / Profil vorgestellt",
  AUSWAHL: "Auswahl / Bestellung",
  BEAUFTRAGT: "Beauftragt",
  GESTARTET: "Einsatz gestartet",
};

/** Der nächste große Schritt je Stufe – als Satz, den der BD lesen kann. */
export const nextBigStep: Record<Stage, string> = {
  KONTAKT: "Ersten konkreten Chance in Kundensprache erfassen (aus Gespräch, Signal oder Dokument).",
  BEDARF_IN_KLAERUNG: "Chance mit dem Bedarfsträger bestätigen (Beleg wie Gesprächsnotiz oder Mail optional).",
  BEDARF_BESTAETIGT: "Passendes Profil oder Angebot vorstellen und Rückmeldung vereinbaren.",
  ANGEBOT: "Rückmeldung zum Angebot einholen; Entscheidungsweg und Freigaben klären.",
  AUSWAHL: "Beauftragung festhalten (Bestellung/Bestätigung, Nachweis optional).",
  BEAUFTRAGT: "Startvoraussetzungen abschließen und Start terminieren.",
  GESTARTET: "Verlängerung, Ausweitung oder Übertragung vorbereiten (Vorhaben im Accountplan).",
};

export type SetupAnalysis = {
  setupId: string;
  setupName: string;
  setupStatus: string;
  accountId: string;
  accountName: string;
  stage: Stage;
  stageLabel: string;
  nextStep: string;
  /** Was den nächsten Schritt aufhält (dokumentierte Hindernisse). */
  blockers: string[];
  /** Was fehlt, damit der nächste Schritt gelingen kann (Lücken). */
  missing: string[];
  /** Naheliegende Züge, die im Tool schon vorbereitet sind (offene Fragen, Vorschläge, Rückmeldungen). */
  moves: { text: string; href: string }[];
  lastActivity: Date;
  daysSinceActivity: number;
  counts: { openActions: number; overdueActions: number; blockedActions: number; openSuggestions: number; mySuggestions: number; openQuestions: number; persons: number; signalsNew: number; opportunities: number };
  opportunities: { id: string; title: string; status: string; statusKey: string; ageDays: number; kind: string; kindLabel: string; roleName: string | null; headcount: number | null; horizon: string | null }[];
  /** Wofür in einem Satz: worauf die Arbeit in diesem Setup hinausläuft */
  purpose: string;
  weekly: { lastConfirmedAt: Date | null; daysSince: number | null };
};

const DAY = 24 * 60 * 60 * 1000;
const days = (d: Date | string | null | undefined) => (d ? Math.floor((Date.now() - new Date(d).getTime()) / DAY) : null);

function stageFromOpportunities(opps: { status: string }[], offers: { status: string }[], orders: { status: string; engagementStatus: string }[]): Stage {
  if (orders.some((o) => o.engagementStatus === "GESTARTET")) return "GESTARTET";
  if (orders.some((o) => o.status === "BEAUFTRAGUNG_BESTAETIGT") || opps.some((o) => o.status === "BEAUFTRAGT")) return "BEAUFTRAGT";
  if (opps.some((o) => o.status === "AUSWAHL_BESTELLUNG") || offers.some((o) => o.status === "AKZEPTIERT")) return "AUSWAHL";
  if (opps.some((o) => o.status === "PROFIL_ANGEBOT_VORGESTELLT") || offers.some((o) => ["VORGESTELLT", "RUECKMELDUNG_OFFEN"].includes(o.status))) return "ANGEBOT";
  if (opps.some((o) => o.status === "BESTAETIGT")) return "BEDARF_BESTAETIGT";
  if (opps.some((o) => o.status === "IN_KLAERUNG")) return "BEDARF_IN_KLAERUNG";
  return "KONTAKT";
}

/** Analyse eines Setups, das der Akteur sehen darf. Rohquellen (Notizen, Dokumente) werden nicht wiedergegeben. */
export async function analyzeSetup(actor: Actor, ctx: SetupContext): Promise<SetupAnalysis> {
  if (!canViewSetup(actor, ctx)) throw new Error("Keine Sicht auf das Setup");
  const setupId = ctx.setup.id;
  const today = new Date().toISOString().slice(0, 10);
  const [opps, actions, suggestions, openQuestions, persons, signals, reviews] = await Promise.all([
    db.query.opportunities.findMany({ where: eq(schema.opportunities.setupId, setupId) }),
    db.query.actions.findMany({ where: and(eq(schema.actions.setupId, setupId), inArray(schema.actions.status, ["VORGESCHLAGEN", "ANGENOMMEN", "IN_ARBEIT", "BLOCKIERT"])) }),
    db.query.suggestions.findMany({ where: and(eq(schema.suggestions.setupId, setupId), inArray(schema.suggestions.status, ["NEU", "GEPRUEFT"])) }),
    db.query.openQuestions.findMany({ where: and(eq(schema.openQuestions.setupId, setupId), eq(schema.openQuestions.status, "OFFEN")) }),
    db.query.persons.findMany({ where: eq(schema.persons.accountId, ctx.account.id), columns: { id: true } }),
    db.query.signals.findMany({ where: and(eq(schema.signals.setupId, setupId), eq(schema.signals.status, "NEU")), columns: { id: true } }),
    db.query.reviews.findMany({ where: and(eq(schema.reviews.setupId, setupId), eq(schema.reviews.status, "BESTAETIGT")), orderBy: desc(schema.reviews.scheduledFor), limit: 1 }),
  ]);
  const oppIds = opps.map((o) => o.id);
  const [offers, orders] = oppIds.length
    ? await Promise.all([db.query.offers.findMany({ where: inArray(schema.offers.opportunityId, oppIds) }), db.query.orders.findMany({ where: inArray(schema.orders.opportunityId, oppIds) })])
    : [[], []];
  let lastWeekly: Date | null = null;
  if (reviews[0]) {
    const v = await db.query.reviewVersions.findFirst({ where: eq(schema.reviewVersions.reviewId, reviews[0].id), orderBy: desc(schema.reviewVersions.confirmedAt) });
    lastWeekly = v?.confirmedAt ?? null;
  }

  const activeOpps = opps.filter((o) => !["ZURUECKGESTELLT", "BEENDET"].includes(o.status));
  const stage = stageFromOpportunities(activeOpps, offers, orders);
  const roles = await listRoles(ctx.setup.workspaceId, { includeInactive: true });
  const roleName = (id: string | null) => (id ? roles.find((r) => r.id === id)?.name ?? null : null);
  const describe = (o: (typeof opps)[number]) => `${o.headcount ? `${o.headcount}× ` : ""}${roleName(o.roleId) ?? o.title}${o.kind !== "VERVE_EXPERTE" ? ` (${chanceKindLabel[o.kind]})` : ""}${o.horizon ? ` ${o.horizon}` : ""} – ${o.status === "ANTIZIPIERT" ? "antizipiert" : (opportunityStatusLabel[o.status] ?? o.status).toLowerCase()}`;
  const purpose = activeOpps.length ? activeOpps.map(describe).join("; ") : "Noch keine Chance benannt – worauf läuft es hinaus?";
  const blockers: string[] = [];
  const missing: string[] = [];
  const moves: { text: string; href: string }[] = [];
  const setupHref = `/setups/${setupId}`;

  // Grundlagen
  if (ctx.setup.status === "ENTWURF") missing.push("Setup ist noch Entwurf – Kontext und Beteiligte festlegen.");
  if (!ctx.setup.contextNote?.trim()) missing.push("Kontextsatz fehlt: Was läuft hier beim Kunden?");
  if (!ctx.setup.bdUserId) missing.push("Zuständiger BD ist nicht zugeordnet.");
  if (persons.length === 0) missing.push("Keine Ansprechpartner erfasst.");

  // Buyingcenter (nur wenn bewertungsberechtigt; Lücken sind keine Rohquellen)
  let bcGaps: string[] = [];
  try {
    const bc = await getBuyingCenter(actor, setupId);
    bcGaps = bc.gaps;
  } catch {
    /* keine Sicht */
  }
  if (stage !== "KONTAKT" || persons.length > 0) {
    // Unbesetzte Entscheidungsrollen in einer Zeile zusammenfassen, sonstige Lücken einzeln
    const roleGaps = bcGaps.filter((g) => g.startsWith("Keine Person mit Rolle")).map((g) => g.replace(/^Keine Person mit Rolle „(.+)“ bekannt\.$/, "$1"));
    if (roleGaps.length) missing.push(`Buyingcenter: ${roleGaps.join(", ")} noch unbesetzt.`);
    for (const g of bcGaps.filter((g) => !g.startsWith("Keine Person mit Rolle")).slice(0, 2)) missing.push(g);
  }

  // Chancen
  for (const o of activeOpps) {
    const age = days(o.createdAt) ?? 0;
    if (o.status === "IN_KLAERUNG" && age > 21) blockers.push(`Chance „${o.title}“ ist seit ${age} Tagen in Klärung – Bestätigung mit Beleg einholen oder zurückstellen.`);
  }
  for (const of of offers) {
    if (["VORGESTELLT", "RUECKMELDUNG_OFFEN"].includes(of.status)) moves.push({ text: "Rückmeldung zum vorgestellten Angebot einholen.", href: setupHref });
  }
  for (const od of orders) {
    if (od.status === "NACHWEISE_UNVOLLSTAENDIG") blockers.push("Auftrag: Nachweise unvollständig – Beauftragung ist nicht belegt.");
    if (od.status === "BEAUFTRAGUNG_BESTAETIGT" && od.engagementStatus === "GEPLANT") moves.push({ text: "Startvoraussetzungen prüfen und Start terminieren.", href: setupHref });
  }
  if (stage === "KONTAKT" && activeOpps.length === 0) {
    if (signals.length > 0) moves.push({ text: `${signals.length} neue Beobachtung(en) prüfen – daraus kann eine Chance werden.`, href: setupHref });
    else missing.push("Wofür fehlt: keine Chance benannt (Verve-Experte, Freelancer oder Ausschreibung) – worauf läuft es hinaus?");
  }
  for (const o of activeOpps) if (!o.roleId && o.kind !== "AUSSCHREIBUNG") missing.push(`Chance „${o.title}“: Standardrolle noch offen.`);
  if (activeOpps.length > 0 && activeOpps.every((o) => o.status === "ANTIZIPIERT")) moves.push({ text: "Alle Chancen sind nur antizipiert – im nächsten Gespräch prüfen, ob der Kunde den Bedarf ausspricht.", href: setupHref });
  // Strategischer Fokus „Freelancer-Hebel“ (Etappe 21): noch keine Freelancer-Chance → Frage nach weiteren Rollen
  if (ctx.setup.status !== "ARCHIVIERT" && !opps.some((o) => o.kind === "FREELANCER_EXPERTE" && o.status !== "BEENDET")) {
    const focus = await getFocus(ctx.setup.workspaceId);
    if (focus.freelancerLever) moves.push({ text: "Freelancer-Hebel: im nächsten Gespräch fragen, welche weiteren Rollen im Team fehlen – daraus eine Chance der Art „Freelancer-Experte“ machen.", href: setupHref });
  }

  // Aktionen
  const overdue = actions.filter((a) => a.dueDate && a.dueDate < today && a.status !== "BLOCKIERT");
  const blocked = actions.filter((a) => a.status === "BLOCKIERT");
  for (const a of overdue.slice(0, 3)) blockers.push(`Überfällig seit ${a.dueDate}: „${a.title}“.`);
  for (const a of blocked.slice(0, 2)) blockers.push(`Blockiert: „${a.title}“.`);
  if (actions.length === 0 && ctx.setup.status !== "ARCHIVIERT") missing.push("Kein nächster Schritt geplant – keine offene Aktion.");

  // Vorschläge und Fragen
  const mine = suggestions.filter((s) => s.proposedOwnerUserId === actor.userId);
  if (mine.length > 0) moves.push({ text: `${mine.length} Vorschlag/Vorschläge warten auf deine Entscheidung.`, href: "/meine-arbeit" });
  else if (suggestions.length > 0) moves.push({ text: `${suggestions.length} offene Vorschläge im Setup.`, href: setupHref });
  if (openQuestions.length > 0) moves.push({ text: `${openQuestions.length} offene Frage(n) ins nächste Kundengespräch mitnehmen.`, href: setupHref });

  // Rhythmus
  const lastActivity = new Date(Math.max(ctx.setup.updatedAt.getTime(), ...actions.map((a) => a.updatedAt.getTime()), ...opps.map((o) => o.updatedAt.getTime())));
  const since = days(lastActivity) ?? 0;
  if (since > 14 && ["ENTWURF", "AKTIV"].includes(ctx.setup.status)) blockers.push(`Seit ${since} Tagen keine Änderung im Setup.`);
  const weeklyDays = days(lastWeekly);
  if (ctx.setup.status === "AKTIV" && (weeklyDays === null || weeklyDays > 14)) missing.push(weeklyDays === null ? "Noch kein bestätigtes Weekly." : `Letztes bestätigtes Weekly vor ${weeklyDays} Tagen.`);

  return {
    setupId,
    setupName: ctx.setup.name,
    setupStatus: ctx.setup.status,
    accountId: ctx.account.id,
    accountName: ctx.account.name,
    stage,
    stageLabel: stageLabel[stage],
    nextStep: nextBigStep[stage],
    blockers,
    missing,
    moves,
    lastActivity,
    daysSinceActivity: since,
    counts: { openActions: actions.length, overdueActions: overdue.length, blockedActions: blocked.length, openSuggestions: suggestions.length, mySuggestions: mine.length, openQuestions: openQuestions.length, persons: persons.length, signalsNew: signals.length, opportunities: activeOpps.length },
    opportunities: activeOpps.map((o) => ({ id: o.id, title: o.title, status: opportunityStatusLabel[o.status] ?? o.status, statusKey: o.status, ageDays: days(o.createdAt) ?? 0, kind: o.kind, kindLabel: chanceKindLabel[o.kind], roleName: roleName(o.roleId), headcount: o.headcount, horizon: o.horizon })),
    purpose,
    weekly: { lastConfirmedAt: lastWeekly, daysSince: weeklyDays },
  };
}

/** Kompakte Textfassung für KI-Eingaben und den Strategiefaden – ohne Rohquellen. */
export function analysisToText(a: SetupAnalysis): string {
  const lines = [
    `Setup: ${a.setupName} (Kunde: ${a.accountName}, Status ${a.setupStatus})`,
    `Stufe: ${a.stageLabel}. Nächster großer Schritt: ${a.nextStep}`,
    a.opportunities.length ? `Chancen: ${a.opportunities.map((o) => `${o.title} [${o.status}, ${o.ageDays} Tage]`).join("; ")}` : "Chancen: keine",
    `Offene Aktionen: ${a.counts.openActions} (überfällig ${a.counts.overdueActions}, blockiert ${a.counts.blockedActions}); offene Vorschläge: ${a.counts.openSuggestions}; offene Fragen: ${a.counts.openQuestions}; Personen: ${a.counts.persons}; neue Beobachtungen: ${a.counts.signalsNew}`,
    `Letzte Änderung vor ${a.daysSinceActivity} Tagen; letztes bestätigtes Weekly: ${a.weekly.daysSince === null ? "keins" : `vor ${a.weekly.daysSince} Tagen`}`,
    a.blockers.length ? `Blocker: ${a.blockers.join(" | ")}` : "",
    a.missing.length ? `Fehlt: ${a.missing.join(" | ")}` : "",
    a.moves.length ? `Naheliegende Züge: ${a.moves.map((m) => m.text).join(" | ")}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

/** Hilfsfunktion: Setups, die in einem Zeitraum still waren. */
export async function staleSetupIds(setupIds: string[], daysBack = 14): Promise<string[]> {
  if (setupIds.length === 0) return [];
  const rows = await db.query.projectSetups.findMany({ where: and(inArray(schema.projectSetups.id, setupIds), lt(schema.projectSetups.updatedAt, new Date(Date.now() - daysBack * DAY))), columns: { id: true } });
  return rows.map((r) => r.id);
}
