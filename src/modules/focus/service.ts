import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema, type Db, type Tx } from "@/db/client";
import { ConflictError, ForbiddenError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/identity/actor";

/**
 * Strategischer Fokus (Etappe 21): ein vom Management gesetzter Schwerpunkt, zuerst „Wachstum über Freelancer“.
 *  - Text wird in alle KI-Agenten eingespeist (siehe focusSystemText), ohne deren Regeln zu lockern.
 *  - Der Freelancer-Hebel schaltet Standardaufgaben, Hinweise in den Lageanalysen und die Kennzahlen-Kachel.
 *  - Pflege: Principal (arbeitsraumweit), CEO oder Betriebsverwaltung. Lesen: alle.
 */

export type Focus = { focusText: string; freelancerLever: boolean; weeklyQuestion: string; version: number | null; updatedAt: Date | null };

export const DEFAULT_FOCUS: Focus = {
  focusText:
    "Wachstum über Freelancer: Bei jedem Kunden Gelegenheiten für zusätzliche Spezialistenprofile erkennen und nutzen. Verve bietet bewährte Qualität und jetzt alle Spezialistenprofile aus einer Hand – das Team wird durch persönlich ausgewählte Freelancer in gleicher Qualität ergänzt.",
  freelancerLever: true,
  weeklyQuestion: "Welche Rollen könnten wir bei diesem Kunden zusätzlich besetzen – mit Verve-Experten oder über Freelancer?",
  version: null,
  updatedAt: null,
};

export async function getFocus(workspaceId: string, tx: Tx | Db = db): Promise<Focus> {
  const row = await tx.query.workspaceFocus.findFirst({ where: eq(schema.workspaceFocus.workspaceId, workspaceId) });
  if (!row) return DEFAULT_FOCUS;
  return { focusText: row.focusText, freelancerLever: row.freelancerLever, weeklyQuestion: row.weeklyQuestion ?? "", version: row.version, updatedAt: row.updatedAt };
}

export function canEditFocus(actor: Actor): boolean {
  return actor.roles.has("PRINCIPAL") || actor.roles.has("CEO") || actor.roles.has("ADMIN");
}

export const updateFocusInput = z.object({
  version: z.coerce.number().int().min(0).default(0), // 0 = noch nie gespeichert
  focusText: z.string().trim().max(1500).default(""),
  freelancerLever: z.union([z.literal("on"), z.literal("true"), z.literal("false"), z.boolean()]).optional(),
  weeklyQuestion: z.string().trim().max(400).optional().or(z.literal("")),
});

export async function updateFocus(actor: Actor, raw: unknown) {
  if (!canEditFocus(actor)) throw new ForbiddenError("Den strategischen Fokus setzen Principal, CEO oder die Betriebsverwaltung.");
  const parsed = updateFocusInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const i = parsed.data;
  const lever = i.freelancerLever === true || i.freelancerLever === "on" || i.freelancerLever === "true";
  const values = { focusText: i.focusText, freelancerLever: lever, weeklyQuestion: i.weeklyQuestion || null, updatedBy: actor.userId, updatedAt: new Date() };
  return db.transaction(async (tx) => {
    const existing = await tx.query.workspaceFocus.findFirst({ where: eq(schema.workspaceFocus.workspaceId, actor.workspaceId) });
    if (!existing) {
      await tx.insert(schema.workspaceFocus).values({ workspaceId: actor.workspaceId, ...values });
    } else {
      if (existing.version !== i.version) throw new ConflictError();
      await tx.update(schema.workspaceFocus).set({ ...values, version: existing.version + 1 }).where(eq(schema.workspaceFocus.workspaceId, actor.workspaceId));
    }
    await recordAudit(tx, actor, "focus.updated", "WORKSPACE", actor.workspaceId, { freelancerLever: lever, zeichen: i.focusText.length });
  });
}

/** Wird von der KI-Schicht als zusätzlicher Systemhinweis angehängt – leer, wenn kein Fokus gesetzt ist. */
export type PromptFocus = { text: string; freelancerLever: boolean };

export function toPromptFocus(f: Focus): PromptFocus | null {
  if (!f.focusText.trim() && !f.freelancerLever) return null;
  return { text: f.focusText.trim(), freelancerLever: f.freelancerLever };
}

export function focusSystemText(f: PromptFocus): string {
  const lines = [
    "STRATEGISCHER FOKUS VON VERVE (vom Management gesetzt):",
    f.text || "–",
    "",
    "Berücksichtige diesen Fokus bei deiner Aufgabe, wo die Daten es hergeben.",
  ];
  if (f.freelancerLever) {
    lines.push(
      "Freelancer-Hebel – achte besonders auf:",
      "- Hinweise auf zusätzliche Rollen, fehlende Kapazität, Engpässe, weitere Profile oder Skill-Pakete, externe Unterstützung, Lieferantenlisten/Vendor-Prozesse.",
      "- Solche Hinweise als Beobachtung „Freelancer-Potenzial“ bzw. als mögliche Chance der Art Freelancer-Experte (FREELANCER_EXPERTE) vorschlagen – als Vermutung, nicht als Tatsache.",
      "- Wo passend eine Frage vorschlagen wie: „Welche weiteren Rollen fehlen im Team?“ oder einen Zug „Freelancer-Hebel“ (weitere Profile anbieten, Listung klären).",
    );
  }
  lines.push(
    "",
    "Der Fokus ändert KEINE deiner Regeln: nichts erfinden, Belege/Textstellen wie gefordert; fehlt eine Grundlage, formuliere eine Frage statt einer Behauptung. Das Antwortformat bleibt exakt wie vorgegeben. Der Fokus ist eine Gewichtung, keine Pflicht, in jeder Antwort vorzukommen.",
  );
  return lines.join("\n");
}
