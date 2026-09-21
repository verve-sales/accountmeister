import { and, arrayContains, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db/client";
import { ForbiddenError, NotFoundError, TransitionError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import { eraseDocumentFile } from "@/modules/documents/service";
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
    // Dokumentquelle: auch die hochgeladene Datei entfernen (Metadaten bleiben)
    const fileErased = await eraseDocumentFile(tx, sourceId);
    await recordAudit(tx, actor, "source.erased", "SOURCE", sourceId, { reason: parsed.data.reason.slice(0, 200), versions: versions.length, assertions: assertionsErased, signals: sigs.length, file: fileErased });
    return { sourceId, versionsErased: versions.length, assertionsErased, signalsErased: sigs.length, fileErased };
  });
}

// ---------------------------------------------------------------------------
// Etappe 18: Löschung von Ansprechpartnern und Fristenprüfung (docs/pilotfreigabe-vorschlag.md Abschnitt 6/7)
// ---------------------------------------------------------------------------

/** 3 Jahre – Ansprechpartner ohne aktive Beziehung, Quellen, Weeklys/Aktionen/Übergaben/Accountpläne, Audit-Protokolle. */
const RETENTION_YEARS_STANDARD = 3;
/** 1 Jahr – KI-Auftragsprotokolle (nur Hash/Länge, kein Text). */
const RETENTION_YEARS_AI_JOBS = 1;
/** 10 Jahre – Bedarfe/Angebote/Aufträge mit Belegcharakter (handels-/steuerrechtlich); unter diesem Alter ist eine
 *  kürzere Löschung nur nach fachlicher Prüfung möglich (ob Belegcharakter vorliegt), darüber ist sie in jeder
 *  Lesart der Frist fällig. */
const RETENTION_YEARS_BELEGE = 10;

function yearsAgo(years: number): Date {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d;
}

const activeRelationshipStates = schema.relationshipStateEnum.enumValues.filter((s) => s !== "NICHT_AKTIV");

/**
 * Ansprechpartner ohne aktive Beziehung (alle Beziehungen „nicht aktiv“ oder gar keine), deren letzte
 * dokumentierte Interaktion (jüngste Beziehungsänderung, sonst Anlage der Person) mind. 3 Jahre zurückliegt.
 */
async function overdueContacts(workspaceId: string, cutoff: Date) {
  const persons = await db.query.persons.findMany({ where: eq(schema.persons.workspaceId, workspaceId) });
  const candidates = persons.filter((p) => p.displayName !== "[gelöscht]");
  if (candidates.length === 0) return [];
  const ids = candidates.map((p) => p.id);
  const rels = await db.query.relationships.findMany({ where: inArray(schema.relationships.personId, ids) });
  const out: { personId: string; displayName: string; lastInteraction: Date }[] = [];
  for (const p of candidates) {
    const myRels = rels.filter((r) => r.personId === p.id);
    const hasActive = myRels.some((r) => (activeRelationshipStates as string[]).includes(r.state));
    if (hasActive) continue;
    const last = myRels.length ? new Date(Math.max(...myRels.map((r) => r.updatedAt.getTime()))) : p.updatedAt;
    if (last <= cutoff) out.push({ personId: p.id, displayName: p.displayName, lastInteraction: last });
  }
  return out.sort((a, b) => a.lastInteraction.getTime() - b.lastInteraction.getTime());
}

/**
 * Fristenprüfung für die Verwaltung: zeigt je Datenklasse, was laut Löschkonzept (`docs/pilotfreigabe-vorschlag.md`
 * Abschnitt 6) zur Löschung/Pseudonymisierung fällig ist. Nur Klassen, deren Frist sich aus einem einzigen
 * Zeitstempel ohne fachliche Einzelfallprüfung ableiten lässt, werden automatisch ermittelt; alles mit
 * Ermessensspielraum (Quellen bei laufendem Auftrag, Bedarfe/Angebote/Aufträge ohne Belegcharakter, vertrauliche
 * Führungsnotizen nach Austritt) bleibt eine Sichtprüfung durch die Betriebsverwaltung – hier nur als Hinweis.
 * Nichts wird durch diese Funktion verändert, sie zählt und listet nur.
 */
export async function retentionReview(actor: Actor) {
  assertAdmin(actor);
  const standardCutoff = yearsAgo(RETENTION_YEARS_STANDARD);
  const aiJobsCutoff = yearsAgo(RETENTION_YEARS_AI_JOBS);
  const belegeCutoff = yearsAgo(RETENTION_YEARS_BELEGE);

  const contacts = await overdueContacts(actor.workspaceId, standardCutoff);

  const overdueSourcesRows = await db.query.sources.findMany({
    where: and(eq(schema.sources.workspaceId, actor.workspaceId), eq(schema.sources.isLocked, false)),
  });
  const overdueSources = overdueSourcesRows.filter((s) => (s.sourceTime ?? s.importedAt) <= standardCutoff && !(s.body === null && s.title === "[Inhalt gelöscht]"));

  const overdueAudit = await db.execute(sql`select count(*)::int as n from audit_events where workspace_id = ${actor.workspaceId} and at <= ${standardCutoff.toISOString()}`);
  const overdueAiJobs = await db.execute(sql`select count(*)::int as n from ai_jobs where workspace_id = ${actor.workspaceId} and started_at <= ${aiJobsCutoff.toISOString()}`);
  const overdueOrders = await db.execute(sql`select count(*)::int as n from orders where workspace_id = ${actor.workspaceId} and created_at <= ${belegeCutoff.toISOString()}`);
  const overdueOffers = await db.execute(sql`select count(*)::int as n from offers where workspace_id = ${actor.workspaceId} and created_at <= ${belegeCutoff.toISOString()}`);

  return {
    standardCutoff,
    aiJobsCutoff,
    belegeCutoff,
    contacts: { items: contacts.slice(0, 50), total: contacts.length },
    sources: { items: overdueSources.slice(0, 50).map((s) => ({ id: s.id, title: s.title, time: s.sourceTime ?? s.importedAt })), total: overdueSources.length },
    auditEvents: { total: (overdueAudit.rows[0] as { n: number }).n },
    aiJobs: { total: (overdueAiJobs.rows[0] as { n: number }).n },
    belege: { orders: (overdueOrders.rows[0] as { n: number }).n, offers: (overdueOffers.rows[0] as { n: number }).n },
  };
}

export const pseudonymizePersonInput = z.object({ personId: z.string().min(1), reason: z.string().trim().min(5, "Bitte den Anlass angeben (z. B. Löschverlangen, Fristenprüfung).").max(1000) });

/**
 * Ansprechpartner löschen (docs/pilotfreigabe-vorschlag.md Abschnitt 7): Beziehungen auf „nicht aktiv“ setzen,
 * Stammdaten pseudonymisieren. Nur möglich, wenn keine Beziehung mehr aktiv ist – eine aktiv gepflegte Beziehung
 * spricht dagegen, dass die Interaktion beendet ist. Metadaten (ID, Kunde, Zeitpunkte) bleiben für die
 * Nachvollziehbarkeit; Protokoll ohne Inhalt.
 */
export async function pseudonymizePerson(actor: Actor, raw: unknown) {
  assertAdmin(actor);
  const parsed = pseudonymizePersonInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const person = await db.query.persons.findFirst({ where: and(eq(schema.persons.id, parsed.data.personId), eq(schema.persons.workspaceId, actor.workspaceId)) });
  if (!person) throw new NotFoundError("Person");
  if (person.displayName === "[gelöscht]") throw new TransitionError("Diese Person wurde bereits gelöscht.");
  const rels = await db.query.relationships.findMany({ where: eq(schema.relationships.personId, person.id) });
  const active = rels.filter((r) => (activeRelationshipStates as string[]).includes(r.state));
  if (active.length > 0) throw new TransitionError("Diese Person hat noch eine aktive Beziehung. Beziehungsstand zuerst auf „nicht aktiv“ setzen.");
  return db.transaction(async (tx) => {
    await tx.update(schema.persons).set({ displayName: "[gelöscht]", email: null, phone: null, updatedAt: new Date() }).where(eq(schema.persons.id, person.id));
    await tx.update(schema.personFunctions).set({ knownResponsibility: null }).where(eq(schema.personFunctions.personId, person.id));
    const rels2 = await tx
      .update(schema.relationships)
      .set({ contextNote: "[Inhalt gelöscht]" })
      .where(eq(schema.relationships.personId, person.id))
      .returning({ id: schema.relationships.id });
    await recordAudit(tx, actor, "person.pseudonymized", "PERSON", person.id, { reason: parsed.data.reason.slice(0, 200), relationships: rels2.length });
    return { personId: person.id, relationships: rels2.length };
  });
}

/** Alte Protokoll-/KI-Auftragseinträge löschen (docs/pilotfreigabe-vorschlag.md Abschnitt 6). Nur Zeilen, die
 *  bei Aufruf die jeweilige Frist überschritten haben; die Löschung selbst erzeugt einen einzigen zusammen-
 *  fassenden Protokolleintrag (nicht je gelöschter Zeile, sonst würde das Protokoll durch seine eigene Pflege wachsen). */
export async function purgeExpiredLogs(actor: Actor) {
  assertAdmin(actor);
  const standardCutoff = yearsAgo(RETENTION_YEARS_STANDARD);
  const aiJobsCutoff = yearsAgo(RETENTION_YEARS_AI_JOBS);
  return db.transaction(async (tx) => {
    const auditDeleted = await tx
      .delete(schema.auditEvents)
      .where(and(eq(schema.auditEvents.workspaceId, actor.workspaceId), sql`${schema.auditEvents.at} <= ${standardCutoff.toISOString()}`))
      .returning({ id: schema.auditEvents.id });
    // ai_jobs wird von mehreren Tabellen referenziert (das Ergebnis eines Auftrags lebt oft länger als 1 Jahr).
    // Diese Verweise gehören nicht dem Auftragsprotokoll (16.4: die Fassung/der Vorschlag bleibt bestehen, nur
    // der Verweis „welcher Auftrag hat das erzeugt“ entfällt) – erst lösen, sonst verletzt das Löschen den Fremdschlüssel.
    const dueJobs = await tx.query.aiJobs.findMany({ where: and(eq(schema.aiJobs.workspaceId, actor.workspaceId), sql`${schema.aiJobs.startedAt} <= ${aiJobsCutoff.toISOString()}`), columns: { id: true } });
    const jobIds = dueJobs.map((j) => j.id);
    if (jobIds.length > 0) {
      await tx.update(schema.intakeProposals).set({ aiJobId: null }).where(inArray(schema.intakeProposals.aiJobId, jobIds));
      await tx.update(schema.interviewTurns).set({ aiJobId: null }).where(inArray(schema.interviewTurns.aiJobId, jobIds));
      await tx.update(schema.suggestions).set({ aiJobId: null }).where(inArray(schema.suggestions.aiJobId, jobIds));
      await tx.update(schema.importJobs).set({ aiJobId: null }).where(inArray(schema.importJobs.aiJobId, jobIds));
      await tx.update(schema.assistantMessages).set({ aiJobId: null }).where(inArray(schema.assistantMessages.aiJobId, jobIds));
      await tx.update(schema.strategyThreads).set({ aiJobId: null }).where(inArray(schema.strategyThreads.aiJobId, jobIds));
      await tx.update(schema.opportunityAdvice).set({ aiJobId: null }).where(inArray(schema.opportunityAdvice.aiJobId, jobIds));
      await tx.update(schema.buyingCenterAdvice).set({ aiJobId: null }).where(inArray(schema.buyingCenterAdvice.aiJobId, jobIds));
    }
    const aiJobsDeleted = jobIds.length ? await tx.delete(schema.aiJobs).where(inArray(schema.aiJobs.id, jobIds)).returning({ id: schema.aiJobs.id }) : [];
    await recordAudit(tx, actor, "retention.logs_purged", "WORKSPACE", actor.workspaceId, { auditEvents: auditDeleted.length, aiJobs: aiJobsDeleted.length, standardCutoff: standardCutoff.toISOString().slice(0, 10), aiJobsCutoff: aiJobsCutoff.toISOString().slice(0, 10) });
    return { auditEvents: auditDeleted.length, aiJobs: aiJobsDeleted.length };
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

export const createAccessInput = z.object({
  email: z.string().trim().toLowerCase().email("Bitte eine gültige E-Mail-Adresse angeben"),
  displayName: z.string().trim().min(2, "Name fehlt").max(200),
});

/** Zugang vorbereiten (ADMIN): Person kann sich danach mit ihrem Microsoft-365-Konto anmelden; Rollen werden getrennt vergeben. */
export async function createUserAccess(actor: Actor, raw: unknown) {
  assertAdmin(actor);
  const parsed = createAccessInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const existing = await db.query.users.findFirst({ where: and(eq(schema.users.workspaceId, actor.workspaceId), sql`lower(${schema.users.email}) = ${parsed.data.email}`) });
  if (existing) throw new ValidationError("Für diese E-Mail-Adresse besteht bereits ein Zugang.");
  const [u] = await db.insert(schema.users).values({ workspaceId: actor.workspaceId, email: parsed.data.email, displayName: parsed.data.displayName }).returning();
  await recordAudit(db, actor, "user.created", "USER", u?.id ?? "");
  return u;
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
