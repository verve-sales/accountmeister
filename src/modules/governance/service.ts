import { and, arrayContains, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db/client";
import { ForbiddenError, NotFoundError, TransitionError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import { hasRole, type Actor } from "@/modules/identity/actor";
import { canViewSource, hasRoleForAccountWrite, loadSetupContext } from "@/modules/identity/authz";

/**
 * Governance (Briefing 16.4, 16.2, S07, S08, S12-Vorbereitung):
 *  - Sperren einer Quelle: abhängige Vorschläge, Artefaktfassungen und Aussagen werden als „überholt“ markiert
 *    und müssen erneut geprüft werden; die Quelle bleibt als Metadatum nachvollziehbar.
 *  - Löschen (Inhalt entfernen): nur nach Sperrung; Text der Quelle und aller Quellenversionen wird entfernt,
 *    Metadaten (Typ, Zeitpunkte, Herkunft) bleiben für die Nachvollziehbarkeit; Protokoll ohne Inhalt.
 *  - Rollenpflege durch ADMIN (Betriebsverwaltung) ohne Inhaltszugriff.
 *  - Audit-Sicht: Ereignisse ohne Rohinhalte.
 */

async function requireGovernableSource(actor: Actor, sourceId: string) {
  const source = await db.query.sources.findFirst({ where: and(eq(schema.sources.id, sourceId), eq(schema.sources.workspaceId, actor.workspaceId)) });
  if (!source) throw new NotFoundError("Quelle");
  const ctx = source.setupId ? await loadSetupContext(actor, source.setupId) : null;
  // Sperren/Löschen dürfen: Quelleninhaber, zuständige Führungsrolle des Kunden; ADMIN nur auf Anweisung über die Verwaltung (ohne Inhalt zu sehen)
  const isOwner = source.ownerUserId === actor.userId;
  const isLeader = ctx ? hasRoleForAccountWrite(actor, ctx.account) && (hasRole(actor, "PRINCIPAL", ctx.account.id) || hasRole(actor, "CEO")) : hasRole(actor, "CEO");
  const isAdmin = hasRole(actor, "ADMIN");
  if (!isOwner && !isLeader && !isAdmin) {
    // Kein Zugriff → auch keine Existenzbestätigung (S01)
    if (!ctx || !canViewSource(actor, source, ctx)) throw new NotFoundError("Quelle");
    throw new ForbiddenError("Quellen sperren oder löschen dürfen Quelleninhaber, zuständige Führungsrollen oder die Betriebsverwaltung.");
  }
  return { source, ctx };
}

export const lockInput = z.object({ reason: z.string().trim().min(5, "Bitte den Grund der Sperrung angeben (z. B. Löschverlangen, Vertraulichkeit).").max(1000) });

export type LockResult = { sourceId: string; suggestionsSuperseded: number; artifactVersionsSuperseded: number; assertionsSuperseded: number };

/** Quelle sperren (S07): abhängige Inhalte werden zur erneuten Prüfung als „überholt“ markiert. */
export async function lockSource(actor: Actor, sourceId: string, raw: unknown): Promise<LockResult> {
  const parsed = lockInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const { source } = await requireGovernableSource(actor, sourceId);
  if (source.isLocked) throw new TransitionError("Die Quelle ist bereits gesperrt.");
  return db.transaction(async (tx) => {
    await tx.update(schema.sources).set({ isLocked: true }).where(eq(schema.sources.id, sourceId));
    // Vorschläge, die diese Quelle verwenden → überholt (nicht mehr anzeigen, nicht annehmen)
    const sugg = await tx
      .update(schema.suggestions)
      .set({ status: "UEBERHOLT" })
      .where(and(arrayContains(schema.suggestions.sourceIds, [sourceId]), inArray(schema.suggestions.status, ["NEU", "GEPRUEFT", "ZURUECKGESTELLT"])))
      .returning({ id: schema.suggestions.id });
    // Artefaktfassungen, die die Quelle verwenden → überholt; erneute Prüfung nötig
    const art = await tx
      .update(schema.artifactVersions)
      .set({ status: "UEBERHOLT" })
      .where(and(arrayContains(schema.artifactVersions.sourceIds, [sourceId]), inArray(schema.artifactVersions.status, ["ENTWURF", "GEPRUEFT", "FREIGEGEBEN"])))
      .returning({ id: schema.artifactVersions.id });
    // Aussagen, deren einziger Beleg die Quelle ist → überholt
    const evid = await tx.query.assertionEvidence.findMany({ where: eq(schema.assertionEvidence.sourceId, sourceId) });
    let assertionsSuperseded = 0;
    for (const e of evid) {
      const others = await tx.query.assertionEvidence.findMany({ where: eq(schema.assertionEvidence.assertionId, e.assertionId) });
      const otherUnlocked = others.filter((o) => o.sourceId !== sourceId);
      if (otherUnlocked.length === 0) {
        await tx.update(schema.assertions).set({ epistemicStatus: "UEBERHOLT" }).where(eq(schema.assertions.id, e.assertionId));
        assertionsSuperseded++;
      }
    }
    await recordAudit(tx, actor, "source.locked", "SOURCE", sourceId, { reason: parsed.data.reason.slice(0, 200), suggestions: sugg.length, artifactVersions: art.length, assertions: assertionsSuperseded });
    return { sourceId, suggestionsSuperseded: sugg.length, artifactVersionsSuperseded: art.length, assertionsSuperseded };
  });
}

/** Inhalt einer gesperrten Quelle entfernen (Löschung, 16.4). Metadaten bleiben; Protokoll ohne Inhalt. */
export async function eraseSourceContent(actor: Actor, sourceId: string, raw: unknown) {
  const parsed = lockInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const { source } = await requireGovernableSource(actor, sourceId);
  if (!source.isLocked) throw new TransitionError("Bitte die Quelle zuerst sperren; die Löschung folgt als zweiter, dokumentierter Schritt.");
  if (source.body === null && source.title === "[Inhalt gelöscht]") throw new TransitionError("Der Inhalt wurde bereits entfernt.");
  return db.transaction(async (tx) => {
    const versions = await tx.update(schema.sourceVersions).set({ body: null }).where(eq(schema.sourceVersions.sourceId, sourceId)).returning({ id: schema.sourceVersions.id });
    await tx.update(schema.sources).set({ body: null, title: "[Inhalt gelöscht]" }).where(eq(schema.sources.id, sourceId));
    // Abgeleitete Inhalte, die allein auf dieser Quelle beruhen, verlieren ihren Text (16.4: keine unabhängige Weiterexistenz ohne dokumentierte Grundlage)
    const evid = await tx.query.assertionEvidence.findMany({ where: eq(schema.assertionEvidence.sourceId, sourceId) });
    let assertionsErased = 0;
    for (const e of evid) {
      const others = await tx.query.assertionEvidence.findMany({ where: eq(schema.assertionEvidence.assertionId, e.assertionId) });
      if (others.every((o) => o.sourceId === sourceId)) {
        await tx.update(schema.assertions).set({ content: "[Inhalt gelöscht – Quelle entfernt]", epistemicStatus: "UEBERHOLT" }).where(eq(schema.assertions.id, e.assertionId));
        assertionsErased++;
      }
    }
    // Hinweise, deren Originalnotiz diese Quelle war: Text entfernen, Hinweis begründet beenden
    const sigs = await tx
      .update(schema.signals)
      .set({ observation: "[Inhalt gelöscht – Quelle entfernt]", relevanceHypothesis: null, usageLimit: null, status: "BEENDET", closedReason: "Quelle auf Verlangen gelöscht", updatedAt: new Date() })
      .where(eq(schema.signals.sourceId, sourceId))
      .returning({ id: schema.signals.id });
    await recordAudit(tx, actor, "source.erased", "SOURCE", sourceId, { reason: parsed.data.reason.slice(0, 200), versions: versions.length, assertions: assertionsErased, signals: sigs.length });
    return { sourceId, versionsErased: versions.length, assertionsErased, signalsErased: sigs.length };
  });
}

// ---------------------------------------------------------------------------
// Verwaltung (ADMIN): Rollen und Audit ohne Inhalte
// ---------------------------------------------------------------------------

function assertAdmin(actor: Actor) {
  if (!hasRole(actor, "ADMIN")) throw new ForbiddenError("Die Verwaltung steht der Betriebsverwaltung (ADMIN) zur Verfügung.");
}

export async function listUsersWithRoles(actor: Actor) {
  assertAdmin(actor);
  const [users, roles, accounts] = await Promise.all([
    db.query.users.findMany({ where: eq(schema.users.workspaceId, actor.workspaceId), orderBy: (u, { asc }) => [asc(u.displayName)] }),
    db.query.roleAssignments.findMany({ where: eq(schema.roleAssignments.workspaceId, actor.workspaceId) }),
    db.query.accounts.findMany({ where: eq(schema.accounts.workspaceId, actor.workspaceId) }),
  ]);
  const an = new Map(accounts.map((a) => [a.id, a.name]));
  return users.map((u) => ({
    ...u,
    roles: roles.filter((r) => r.userId === u.id).map((r) => ({ id: r.id, role: r.role, scope: r.scope, accountName: r.accountId ? an.get(r.accountId) ?? "?" : null, accountId: r.accountId })),
  }));
}

export const roleInput = z.object({
  userId: z.string().min(1),
  role: z.enum(schema.roleEnum.enumValues),
  accountId: z.string().optional().or(z.literal("")),
});

/** Rolle zuweisen (ADMIN). Kundenbezogene Rollen (BD/PRINCIPAL) brauchen einen Kunden. */
export async function assignRole(actor: Actor, raw: unknown) {
  assertAdmin(actor);
  const parsed = roleInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  const user = await db.query.users.findFirst({ where: and(eq(schema.users.id, input.userId), eq(schema.users.workspaceId, actor.workspaceId)) });
  if (!user) throw new NotFoundError("Person");
  const scope = input.accountId ? "ACCOUNT" : "WORKSPACE";
  if (scope === "ACCOUNT" && input.role !== "BD" && input.role !== "PRINCIPAL") throw new ValidationError("Kundenbezogen werden nur BD und Principal vergeben.");
  const existing = await db.query.roleAssignments.findMany({ where: and(eq(schema.roleAssignments.userId, user.id), eq(schema.roleAssignments.role, input.role)) });
  if (existing.some((r) => (r.accountId ?? null) === (input.accountId || null))) throw new ValidationError("Diese Rolle ist bereits zugewiesen.");
  const [r] = await db.insert(schema.roleAssignments).values({ workspaceId: actor.workspaceId, userId: user.id, role: input.role, scope, accountId: input.accountId || null }).returning();
  await recordAudit(db, actor, "role.assigned", "USER", user.id, { role: input.role, scope });
  return r;
}

export async function revokeRole(actor: Actor, roleAssignmentId: string) {
  assertAdmin(actor);
  const r = await db.query.roleAssignments.findFirst({ where: and(eq(schema.roleAssignments.id, roleAssignmentId), eq(schema.roleAssignments.workspaceId, actor.workspaceId)) });
  if (!r) throw new NotFoundError("Rolle");
  if (r.userId === actor.userId && r.role === "ADMIN") throw new ValidationError("Die eigene Verwaltungsrolle kann nicht entzogen werden.");
  await db.delete(schema.roleAssignments).where(eq(schema.roleAssignments.id, roleAssignmentId));
  await recordAudit(db, actor, "role.revoked", "USER", r.userId, { role: r.role, scope: r.scope });
}

export async function setUserStatus(actor: Actor, userId: string, status: "ACTIVE" | "INACTIVE") {
  assertAdmin(actor);
  if (userId === actor.userId) throw new ValidationError("Der eigene Zugang kann nicht deaktiviert werden.");
  const [u] = await db.update(schema.users).set({ status }).where(and(eq(schema.users.id, userId), eq(schema.users.workspaceId, actor.workspaceId))).returning();
  if (!u) throw new NotFoundError("Person");
  await recordAudit(db, actor, "user.status_changed", "USER", userId, { status });
  return u;
}

/** Audit-Ereignisse für die Verwaltung: Akteur, Aktion, Objekttyp/-ID, Zeitpunkt; `changes` nur als Schlüsselliste (keine Inhalte). */
export async function listAuditEvents(actor: Actor, limit = 200) {
  assertAdmin(actor);
  const rows = await db.query.auditEvents.findMany({ where: eq(schema.auditEvents.workspaceId, actor.workspaceId), orderBy: desc(schema.auditEvents.at), limit });
  const users = await db.query.users.findMany({ where: eq(schema.users.workspaceId, actor.workspaceId) });
  const un = new Map(users.map((u) => [u.id, u.displayName]));
  return rows.map((r) => ({ id: r.id, at: r.at, actor: r.actorUserId ? un.get(r.actorUserId) ?? "?" : "System", action: r.action, objectType: r.objectType, objectId: r.objectId, changeKeys: r.changes && typeof r.changes === "object" ? Object.keys(r.changes as object) : [] }));
}

/** Bestandszahlen je Datenklasse für Verwaltung/Löschkonzept – nur Zählungen. */
export async function dataInventory(actor: Actor) {
  assertAdmin(actor);
  const count = async (table: string) => {
    const r = await db.execute(sql.raw(`select count(*)::int as n from ${table}`));
    return (r.rows[0] as { n: number }).n;
  };
  const lockedSources = await db.execute(sql`select count(*)::int as n from sources where is_locked = true`);
  const erasedSources = await db.execute(sql`select count(*)::int as n from sources where body is null and title = '[Inhalt gelöscht]'`);
  return {
    kundenkontakte: { persons: await count("persons"), relationships: await count("relationships"), decisionParticipations: await count("decision_participations") },
    quellen: { sources: await count("sources"), locked: (lockedSources.rows[0] as { n: number }).n, erased: (erasedSources.rows[0] as { n: number }).n, sourceVersions: await count("source_versions") },
    beschaeftigte: { users: await count("users"), goals: await count("goals"), confidentialNotes: await count("confidential_notes"), supportRequests: await count("support_requests") },
    fall: { setups: await count("project_setups"), signals: await count("signals"), opportunities: await count("opportunities"), offers: await count("offers"), orders: await count("orders") },
    ki: { aiJobs: await count("ai_jobs"), suggestions: await count("suggestions") },
    audit: await count("audit_events"),
  };
}
