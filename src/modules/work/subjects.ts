import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { NotFoundError, ValidationError } from "@/lib/errors";
import type { Actor } from "@/modules/identity/actor";
import { canViewSetup, loadSetupContext } from "@/modules/identity/authz";
import { getAccount } from "@/modules/accounts/service";

/**
 * Bezugsobjekte von Vorgängen und Kommentaren (Etappe 27). Die Sichtbarkeit leitet sich immer vom Bezugsobjekt ab –
 * wer den Kunden/das Setup/die Chance nicht sehen darf, sieht auch Kommentare und Vorgänge daran nicht (Ausnahme:
 * direkt Beteiligte eines Vorgangs, siehe work/service).
 */
export const subjectTypeValues = ["KUNDE", "SETUP", "CHANCE", "SOS", "POSITION", "OHNE"] as const;
export type SubjectType = (typeof subjectTypeValues)[number];
export const subjectTypeLabel: Record<string, string> = { KUNDE: "Kunde", SETUP: "Setup", CHANCE: "Chance", SOS: "SOS", POSITION: "Position", OHNE: "ohne Bezug", VORGANG: "Vorgang" };

export type ResolvedSubject = { type: SubjectType; id: string | null; accountId: string | null; label: string; link: string | null };

export async function resolveSubject(actor: Actor, type: string, id: string | null | undefined): Promise<ResolvedSubject> {
  if (!type || type === "OHNE" || !id) return { type: "OHNE", id: null, accountId: null, label: "ohne Bezug", link: null };
  switch (type) {
    case "KUNDE": {
      const a = await getAccount(actor, id);
      return { type, id, accountId: a.id, label: a.name, link: `/kunden/${a.id}` };
    }
    case "SETUP": {
      const ctx = await loadSetupContext(actor, id);
      if (!ctx || !canViewSetup(actor, ctx)) throw new NotFoundError("Setup");
      return { type, id, accountId: ctx.account.id, label: `${ctx.account.name} · ${ctx.setup.name}`, link: `/setups/${id}` };
    }
    case "CHANCE": {
      const o = await db.query.opportunities.findFirst({ where: and(eq(schema.opportunities.id, id), eq(schema.opportunities.workspaceId, actor.workspaceId)) });
      if (!o) throw new NotFoundError("Chance");
      const ctx = await loadSetupContext(actor, o.setupId);
      if (!ctx || !canViewSetup(actor, ctx)) throw new NotFoundError("Chance");
      return { type, id, accountId: ctx.account.id, label: `${ctx.account.name} · ${o.title}`, link: `/bedarfe/${id}` };
    }
    case "SOS": {
      const s = await db.query.sosReports.findFirst({ where: and(eq(schema.sosReports.id, id), eq(schema.sosReports.workspaceId, actor.workspaceId)) });
      if (!s) throw new NotFoundError("SOS");
      const a = await getAccount(actor, s.accountId);
      return { type, id, accountId: a.id, label: `${a.name} · SOS: ${s.title}`, link: `/kunden/${a.id}#sos` };
    }
    case "POSITION": {
      // Besetzung (Etappe 28): voller Zugriff nur mit Positionsrecht; Team-Mitglieder sehen den Vorgang über das Team.
      const { requireViewablePosition } = await import("@/modules/staffing/authz");
      const p = await requireViewablePosition(actor, id);
      return { type, id, accountId: p.position.accountId, label: `${p.accountName} · Position: ${p.position.title}`, link: `/besetzung/${id}` };
    }
    default:
      throw new ValidationError("Unbekannter Bezug.");
  }
}

/** true, wenn der Akteur das Bezugsobjekt sehen darf (ohne Ausnahme zu werfen). */
export async function canSeeSubject(actor: Actor, type: string, id: string | null | undefined): Promise<boolean> {
  try {
    await resolveSubject(actor, type, id);
    return true;
  } catch {
    return false;
  }
}
