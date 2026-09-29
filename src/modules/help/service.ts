import { roleLabel } from "@/lib/labels";
import type { Actor } from "@/modules/identity/actor";
import { isSalesOps } from "@/modules/identity/actor";
import { canEditFocus, getFocus } from "@/modules/focus/service";
import { canManagePlaybooks, listPlaybooks } from "@/modules/playbooks/service";
import { getAIProvider } from "@/modules/ai";
import { HELP_SECTIONS, formatSection, helpIndex, searchHelp, type HelpSection } from "./knowledge";

/** Was die angemeldete Person darf und welche Einstellungen gerade gelten – aus echten Daten, nicht geraten. */
export async function describeMySettings(actor: Actor): Promise<string> {
  const roles = [...actor.roles].map((r) => roleLabel[r] ?? r);
  const accountScoped = actor.accountRoles.size;
  const lines = [`Deine Rollen: ${roles.join(", ") || "keine arbeitsraumweiten"}${accountScoped ? `; dazu kundenbezogene Rollen bei ${accountScoped} Kunde(n)` : ""}.`];
  const may: string[] = [];
  if (canEditFocus(actor)) may.push("den strategischen Fokus bearbeiten");
  if (canManagePlaybooks(actor)) may.push("Vorgehensmuster pflegen");
  if (actor.roles.has("ADMIN")) may.push("Zugänge, Rollen und KI-Konfiguration verwalten (Verwaltung)");
  if (actor.roles.has("CEO")) may.push("das CEO-Dashboard sehen");
  if (actor.roles.has("PRINCIPAL")) may.push("bei deinen Kunden Setups und Chancen pflegen sowie BD, Anker und Verantwortliche umstellen");
  if (isSalesOps(actor)) may.push("für alle BDs vorbereiten und pflegen (Entscheidungen bleiben beim BD)");
  if (may.length) lines.push(`Du darfst u. a.: ${may.join("; ")}.`);
  try {
    const focus = await getFocus(actor.workspaceId);
    lines.push(`Strategischer Fokus: ${focus.focusText ? `„${focus.focusText.slice(0, 200)}${focus.focusText.length > 200 ? "…" : ""}“` : "kein Text gesetzt"}; Freelancer-Hebel ${focus.freelancerLever ? "an" : "aus"}.`);
  } catch {
    /* Fokus nicht lesbar – weglassen */
  }
  try {
    const pbs = await listPlaybooks(actor, { activeOnly: true });
    if (pbs.length) lines.push(`Aktive Vorgehensmuster: ${pbs.map((p) => p.name).join(", ")}.`);
  } catch {
    /* weglassen */
  }
  const ai = getAIProvider().info();
  lines.push(`KI: ${ai.enabled ? `aktiv (${ai.description})` : "deaktiviert"}.`);
  return lines.join("\n");
}

/** Hilfe-Block für den Assistenten: Inhaltsverzeichnis, passende Abschnitte zur Frage, eigene Einstellungen. */
export async function buildHelpText(actor: Actor, query: string): Promise<{ text: string; sections: HelpSection[] }> {
  const hits = searchHelp(query, 3).map((h) => h.section);
  const parts = [
    "Inhaltsverzeichnis der Hilfe:",
    helpIndex(),
    "",
    hits.length ? "Passende Abschnitte zur Frage:" : "Kein Abschnitt passt eindeutig zur letzten Nachricht.",
    ...hits.map(formatSection),
    "",
    "Deine Einstellungen (live aus der Anwendung):",
    await describeMySettings(actor),
  ];
  return { text: parts.join("\n"), sections: hits };
}

export { HELP_SECTIONS };
