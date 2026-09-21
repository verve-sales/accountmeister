import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { DomainError, ForbiddenError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/identity/actor";
import { hasAnyContentRole } from "@/modules/identity/actor";
import { getAccount } from "@/modules/accounts/service";
import { getCompanyResearchAdapter, ResearchAdapterError } from "./index";
import type { CompanyFact } from "./adapter";

/**
 * Öffentliche Unternehmensrecherche je Kunde (Etappe 16, Anker-/BD-Wunsch: schneller Überblick über den Kunden
 * aus öffentlichen Quellen). Eng begrenzte Ausnahme von „die KI recherchiert nicht im Internet“: ausschließlich
 * öffentliche Firmendaten zum Kunden selbst, nie zu benannten Einzelpersonen – strukturell erzwungen, weil die
 * einzige Eingabe der Firmenname aus dem Kundendatensatz ist. Reine Anzeige, kein Vorschlag in Domänenobjekte;
 * nur die letzte Fassung je Kunde wird gehalten (kein Verlauf nötig).
 */

export function adapterErrorToDomain(e: unknown): DomainError {
  if (e instanceof ResearchAdapterError) {
    const map: Record<ResearchAdapterError["kind"], number> = { NOT_CONFIGURED: 409, TEMPORARY: 503, NOT_FOUND: 404 };
    return new DomainError(`RESEARCH_${e.kind}`, e.message, map[e.kind]);
  }
  return new DomainError("RESEARCH_ERROR", "Recherche gerade nicht möglich. Bitte später erneut versuchen.", 503);
}

export type CompanyResearchRow = typeof schema.companyResearch.$inferSelect;

/** Zuletzt abgerufene Fassung (falls vorhanden) – reine Leseansicht für die Kundenseite. */
export async function getCompanyResearch(actor: Actor, accountId: string): Promise<{ account: { id: string; name: string }; latest: CompanyResearchRow | null; adapterAvailable: boolean }> {
  const account = await getAccount(actor, accountId);
  const state = await getCompanyResearchAdapter().status();
  const latest = await db.query.companyResearch.findFirst({ where: eq(schema.companyResearch.accountId, accountId) });
  return { account: { id: account.id, name: account.name }, latest: latest ?? null, adapterAvailable: state.available };
}

/** Recherche (neu) abrufen und als aktuelle Fassung speichern – überschreibt die vorherige Fassung dieses Kunden. */
export async function refreshCompanyResearch(actor: Actor, accountId: string): Promise<CompanyResearchRow> {
  if (!hasAnyContentRole(actor)) throw new ForbiddenError("Nur fachliche Rollen starten eine Unternehmensrecherche.");
  const account = await getAccount(actor, accountId);
  const adapter = getCompanyResearchAdapter();
  let result;
  try {
    result = await adapter.research({ fixture: true, companyName: account.name });
  } catch (e) {
    throw adapterErrorToDomain(e);
  }
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(schema.companyResearch)
      .values({ workspaceId: actor.workspaceId, accountId: account.id, companyName: result.companyName, facts: result.facts, note: result.note, fixtureMode: result.fixtureMode, fetchedBy: actor.userId })
      .onConflictDoUpdate({
        target: [schema.companyResearch.accountId],
        set: { companyName: result.companyName, facts: result.facts, note: result.note, fixtureMode: result.fixtureMode, fetchedBy: actor.userId, fetchedAt: new Date() },
      })
      .returning();
    await recordAudit(tx, actor, "research.company_refreshed", "COMPANY_RESEARCH", row?.id ?? "?", { accountId: account.id, factCount: result.facts.length, fixtureMode: result.fixtureMode });
    return row!;
  });
}

export type { CompanyFact };
