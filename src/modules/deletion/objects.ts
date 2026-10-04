import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema, type Tx } from "@/db/client";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import { hasRole, type Actor } from "@/modules/identity/actor";
import { canReassignResponsibility, loadSetupContext } from "@/modules/identity/authz";
import { Cascade, loadForeignKeys, rowCount, type DeletionReport } from "@/modules/accounts/deletion";

/**
 * Endgültiges Löschen unterhalb des Kunden (Feedback Oktober 2026): Einsatz, Chance, Setup – jeweils mit allem, was
 * daran hängt (Kaskade aus den Fremdschlüsseln, wie beim Kunden). Beobachtungen, die nur auf eine Chance verweisen
 * („Wofür“), werden gelöst statt gelöscht. Pflicht: ausdrückliche Bestätigung und Begründung (bleibt im Protokoll).
 */

export const deleteObjectInput = z.object({
  reason: z.string().trim().min(10, "Bitte eine Begründung mit mindestens 10 Zeichen angeben (sie bleibt im Prüfprotokoll).").max(1000),
  confirm: z.union([z.boolean(), z.enum(["true", "on"])]),
});

const parse = (raw: unknown) => {
  const p = deleteObjectInput.safeParse(raw);
  if (!p.success) throw new ValidationError(p.error.issues.map((i) => i.message).join("; "));
  if (!(p.data.confirm === true || p.data.confirm === "true" || p.data.confirm === "on")) throw new ValidationError("Bitte das Löschen ausdrücklich bestätigen.");
  return p.data;
};

/** Verweise ohne Fremdschlüssel (Vorgänge, Kommentare, Moco-Hinweise, Assistentengespräche) mitnehmen. */
async function deleteSoftReferences(tx: Tx, cascade: Cascade, subjects: { type: string; id: string }[]) {
  for (const s of subjects) {
    const work = await tx.query.workItems.findMany({ where: and(eq(schema.workItems.subjectType, s.type), eq(schema.workItems.subjectId, s.id)), columns: { id: true } });
    await cascade.deleteRows("work_items", work.map((w) => w.id));
    const c = await tx.execute(sql`delete from comments where subject_type = ${s.type} and subject_id = ${s.id}`);
    const n = rowCount(c);
    if (n) cascade.report.deleted["comments"] = (cascade.report.deleted["comments"] ?? 0) + n;
    const h = await tx.execute(sql`delete from moco_hints where subject_type = ${s.type === "EINSATZ" ? "ENGAGEMENT" : s.type} and subject_id = ${s.id}`);
    const m = rowCount(h);
    if (m) cascade.report.deleted["moco_hints"] = (cascade.report.deleted["moco_hints"] ?? 0) + m;
  }
}

// ---------------------------------------------------------------------------
// Einsatz
// ---------------------------------------------------------------------------

export async function deleteEngagementPermanently(actor: Actor, engagementId: string, raw: unknown): Promise<DeletionReport & { title: string }> {
  const input = parse(raw);
  const { requireEngagement } = await import("@/modules/engagements/authz");
  const a = await requireEngagement(actor, engagementId);
  if (!a.manage) throw new ForbiddenError("Einen Einsatz löscht der verantwortliche BD, Principal oder CEO.");
  const e = a.engagement;
  return db.transaction(async (tx) => {
    const cascade = new Cascade(tx, await loadForeignKeys(tx), ["signals.opportunity_id"]);
    await deleteSoftReferences(tx, cascade, [{ type: "EINSATZ", id: e.id }]);
    await cascade.deleteRows("engagements", [e.id]);
    // Kandidatur und (wenn leer) Position gehen mit; Auftrag nur, wenn kein anderer Einsatz daran hängt
    await tx.update(schema.staffingPositions).set({ filledCandidacyId: null, status: "ABGEBROCHEN", statusReason: "Einsatz gelöscht" }).where(eq(schema.staffingPositions.id, e.positionId));
    await cascade.deleteRows("candidacies", [e.candidacyId]);
    const others = await tx.query.candidacies.findMany({ where: eq(schema.candidacies.positionId, e.positionId), columns: { id: true } });
    if (!others.length) {
      await deleteSoftReferences(tx, cascade, [{ type: "POSITION", id: e.positionId }]);
      await cascade.deleteRows("staffing_positions", [e.positionId]);
    }
    if (e.orderId) {
      const otherEng = await tx.query.engagements.findMany({ where: eq(schema.engagements.orderId, e.orderId), columns: { id: true } });
      if (!otherEng.length) await cascade.deleteRows("orders", [e.orderId]);
    }
    await recordAudit(tx, actor, "engagement.deleted", "ENGAGEMENT", e.id, { titel: e.title, begruendung: input.reason, geloescht: cascade.report.deleted });
    return { ...cascade.report, title: e.title };
  });
}

// ---------------------------------------------------------------------------
// Chance
// ---------------------------------------------------------------------------

async function requireOpportunityDeletable(actor: Actor, opportunityId: string) {
  const opp = await db.query.opportunities.findFirst({ where: and(eq(schema.opportunities.id, opportunityId), eq(schema.opportunities.workspaceId, actor.workspaceId)) });
  if (!opp) throw new NotFoundError("Chance");
  const ctx = await loadSetupContext(actor, opp.setupId);
  if (!ctx) throw new NotFoundError("Chance");
  const allowed = hasRole(actor, "ADMIN") || canReassignResponsibility(actor, ctx.account) || opp.ownerUserId === actor.userId || ctx.setup.bdUserId === actor.userId;
  if (!allowed) throw new ForbiddenError("Eine Chance löschen dürfen die verantwortliche Person, der zuständige BD, Principal, CEO oder die Betriebsverwaltung.");
  return { opp, ctx };
}

export async function previewOpportunityDeletion(actor: Actor, opportunityId: string) {
  const { opp } = await requireOpportunityDeletable(actor, opportunityId);
  const [positions, engagements, orders, offers] = await Promise.all([
    db.query.staffingPositions.findMany({ where: eq(schema.staffingPositions.opportunityId, opp.id), columns: { id: true } }),
    db.query.engagements.findMany({ where: eq(schema.engagements.opportunityId, opp.id), columns: { id: true } }),
    db.query.orders.findMany({ where: eq(schema.orders.opportunityId, opp.id), columns: { id: true } }),
    db.query.offers.findMany({ where: eq(schema.offers.opportunityId, opp.id), columns: { id: true } }),
  ]);
  return { opp, positions: positions.length, engagements: engagements.length, orders: orders.length, offers: offers.length };
}

export async function deleteOpportunityPermanently(actor: Actor, opportunityId: string, raw: unknown): Promise<DeletionReport & { title: string }> {
  const input = parse(raw);
  const { opp } = await requireOpportunityDeletable(actor, opportunityId);
  return db.transaction(async (tx) => {
    const cascade = new Cascade(tx, await loadForeignKeys(tx), ["signals.opportunity_id"]);
    const [positions, engagements] = await Promise.all([
      tx.query.staffingPositions.findMany({ where: eq(schema.staffingPositions.opportunityId, opp.id), columns: { id: true } }),
      tx.query.engagements.findMany({ where: eq(schema.engagements.opportunityId, opp.id), columns: { id: true } }),
    ]);
    await deleteSoftReferences(tx, cascade, [{ type: "CHANCE", id: opp.id }, ...positions.map((p) => ({ type: "POSITION", id: p.id })), ...engagements.map((e) => ({ type: "EINSATZ", id: e.id }))]);
    await cascade.deleteRows("opportunities", [opp.id]);
    await recordAudit(tx, actor, "opportunity.deleted", "OPPORTUNITY", opp.id, { titel: opp.title, begruendung: input.reason, geloescht: cascade.report.deleted, geloest: cascade.report.detached });
    return { ...cascade.report, title: opp.title };
  });
}

// ---------------------------------------------------------------------------
// Setup (rekursiv: Chancen, Positionen, Einsätze, Beobachtungen, Aktionen, Weeklys, Quellen …)
// ---------------------------------------------------------------------------

async function requireSetupDeletable(actor: Actor, setupId: string) {
  const ctx = await loadSetupContext(actor, setupId);
  if (!ctx) throw new NotFoundError("Setup");
  const allowed = hasRole(actor, "ADMIN") || canReassignResponsibility(actor, ctx.account) || ctx.setup.bdUserId === actor.userId;
  if (!allowed) throw new ForbiddenError("Ein Setup löschen dürfen der zuständige BD, Principal, CEO oder die Betriebsverwaltung.");
  return ctx;
}

export async function previewSetupDeletion(actor: Actor, setupId: string) {
  const ctx = await requireSetupDeletable(actor, setupId);
  const count = async (table: string) => {
    const r: unknown = await db.execute(sql`select count(*)::int as n from ${sql.identifier(table)} where setup_id = ${setupId}`);
    const x = r as { rows?: { n: number }[] };
    const rows = Array.isArray(x.rows) ? x.rows : Array.isArray(r) ? (r as { n: number }[]) : [];
    return Number(rows[0]?.n ?? 0);
  };
  return { setup: ctx.setup, account: ctx.account, opportunities: await count("opportunities"), engagements: await count("engagements"), signals: await count("signals"), actions: await count("actions"), sources: await count("sources"), reviews: await count("reviews") };
}

export async function deleteSetupPermanently(actor: Actor, setupId: string, raw: unknown): Promise<DeletionReport & { name: string }> {
  const input = parse(raw);
  const ctx = await requireSetupDeletable(actor, setupId);
  return db.transaction(async (tx) => {
    const cascade = new Cascade(tx, await loadForeignKeys(tx));
    const [opps, positions, engagements] = await Promise.all([
      tx.query.opportunities.findMany({ where: eq(schema.opportunities.setupId, setupId), columns: { id: true } }),
      tx.query.staffingPositions.findMany({ where: eq(schema.staffingPositions.setupId, setupId), columns: { id: true } }),
      tx.query.engagements.findMany({ where: eq(schema.engagements.setupId, setupId), columns: { id: true } }),
    ]);
    await deleteSoftReferences(tx, cascade, [{ type: "SETUP", id: setupId }, ...opps.map((o) => ({ type: "CHANCE", id: o.id })), ...positions.map((p) => ({ type: "POSITION", id: p.id })), ...engagements.map((e) => ({ type: "EINSATZ", id: e.id }))]);
    const threads = await tx.query.assistantThreads.findMany({ where: and(eq(schema.assistantThreads.workspaceId, actor.workspaceId), eq(schema.assistantThreads.contextId, setupId)), columns: { id: true } });
    await cascade.deleteRows("assistant_threads", threads.map((t) => t.id));
    await cascade.deleteRows("project_setups", [setupId]);
    await recordAudit(tx, actor, "setup.deleted", "SETUP", setupId, { name: ctx.setup.name, kunde: ctx.account.name, begruendung: input.reason, geloescht: cascade.report.deleted, geloest: cascade.report.detached });
    return { ...cascade.report, name: ctx.setup.name };
  });
}

