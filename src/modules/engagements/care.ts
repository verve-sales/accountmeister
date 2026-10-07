import { and, asc, desc, eq, inArray, isNull, notInArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema, type Db, type Tx } from "@/db/client";
import { ConflictError, ForbiddenError, NotFoundError, TransitionError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/identity/actor";
import { notify } from "@/modules/notifications/service";
import { createWorkItem, FINAL as WORK_FINAL } from "@/modules/work/service";
import { ensureDefaultTeams } from "@/modules/work/teams";
import { plusDaysIso, todayIso } from "@/modules/work/calendar";
import { captureObservation } from "@/modules/signals/service";
import { engagementAccess, requireEngagement, requireManagedEngagement } from "./authz";
import { addPeriod, careRoleLabel } from "./service";
import { getMocoClient, mocoEnabled, type MocoClient } from "@/modules/moco/client";

/**
 * Betreuung, Check-ins, Verlängerungsentscheidung und Sales-Rückkopplung (Etappe 29, E2).
 * - Betreuungsübergabe: Vorgang (kind BETREUUNG) an Person oder Team; die Annahme aktiviert die dauerhafte Zuordnung in
 *   derselben Transaktion (Hook in work/service). Abschluss des Vorgangs beendet die Betreuung nicht.
 * - Catch-up: Kunde alle 42 Tage nach dem letzten tatsächlich erfolgten Gespräch (sonst Start + 42); Freelancer-Check-ins
 *   separat anlegbar, keine automatische Pflicht.
 */

export const CATCHUP_DAYS = 42;
export const checkinStatusLabel: Record<string, string> = { FAELLIG: "fällig", ANGEFRAGT: "angefragt", GEPLANT: "geplant", ERLEDIGT: "erledigt", VERSCHOBEN: "verschoben", ABGESAGT: "entfallen" };
export const renewalStatusLabel: Record<string, string> = { ZU_KLAEREN: "zu klären", IN_ABSTIMMUNG: "in Abstimmung", ANGEBOTEN: "angeboten", BESTAETIGT: "bestätigt", ABGELEHNT: "abgelehnt", ERLEDIGT: "erledigt" };

const issues = (e: z.ZodError) => e.issues.map((i) => i.message).join("; ");
const opt = (max: number) => z.string().trim().max(max).optional().or(z.literal(""));
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum als JJJJ-MM-TT").optional().or(z.literal(""));

// ---------------------------------------------------------------------------
// Betreuungsübergabe
// ---------------------------------------------------------------------------

export const handoverInput = z.object({
  role: z.enum(["CUSTOMER_CARE", "FREELANCER_CARE"]).default("CUSTOMER_CARE"),
  /** userId oder team:<id> */
  target: z.string().min(1, "Bitte Person oder Team wählen."),
  reason: z.string().trim().min(5, "Bitte den Grund der Übergabe nennen.").max(1000),
  contacts: opt(1000),
  history: opt(2000),
  commitments: opt(2000),
  nextStep: opt(500),
  dueDate: dateStr,
});

export async function requestCareHandover(actor: Actor, engagementId: string, raw: unknown) {
  const p = handoverInput.safeParse(raw);
  if (!p.success) throw new ValidationError(issues(p.error));
  const a = await requireEngagement(actor, engagementId);
  const current = await db.query.careAssignments.findFirst({ where: and(eq(schema.careAssignments.engagementId, engagementId), eq(schema.careAssignments.role, p.data.role), isNull(schema.careAssignments.toDate)) });
  // Delegieren darf, wer die Fähigkeit hat: BD-Kontext/Principal/CEO oder die aktuelle Betreuungsperson dieser Funktion
  if (!(a.manage || current?.userId === actor.userId)) throw new ForbiddenError("Betreuung übergeben darf der verantwortliche BD, Principal, CEO oder die aktuelle Betreuungsperson.");
  const open = await db.query.workItems.findFirst({ where: and(eq(schema.workItems.subjectType, "EINSATZ"), eq(schema.workItems.subjectId, engagementId), eq(schema.workItems.kind, "BETREUUNG"), notInArray(schema.workItems.status, WORK_FINAL)) });
  if (open) throw new ConflictError("Für diesen Einsatz läuft bereits eine Betreuungsübergabe.");
  const i = p.data;
  if (i.target.startsWith("team:")) await ensureDefaultTeams(actor.workspaceId);
  const w = await createWorkItem(actor, {
    title: `${careRoleLabel[i.role]} übernehmen: ${a.engagement.title}`,
    description: [`Grund: ${i.reason}`, i.contacts && `Relevante Kontakte: ${i.contacts}`, i.history && `Erlaubte Gesprächshistorie: ${i.history}`, i.commitments && `Offene Zusagen/Risiken: ${i.commitments}`, i.nextStep && `Nächste Aufgabe/Termin: ${i.nextStep}`, `Bisherige Verantwortung: ${current ? "siehe aktuelle Betreuung" : "noch niemand"}`].filter(Boolean).join("\n"),
    subjectType: "EINSATZ",
    subjectId: engagementId,
    target: i.target,
    dueDate: i.dueDate || plusDaysIso(todayIso(), 5),
    kind: "BETREUUNG",
    reviewRequired: "false",
    checklistText: "Kontakte und Zusagen gesichtet\nNächsten Check-in terminiert",
  });
  await db.update(schema.workItems).set({ fields: { role: i.role } }).where(eq(schema.workItems.id, w.id));
  await recordAudit(db, actor, "care.handover_requested", "ENGAGEMENT", engagementId, { vorgang: w.id, rolle: i.role, an: i.target });
  return w;
}

/** Hook aus work/service: Annahme eines BETREUUNG-Vorgangs aktiviert die Zuordnung (gleiche Transaktion). */
export async function activateCareFromWorkItem(tx: Tx, actor: Actor, item: typeof schema.workItems.$inferSelect, assigneeUserId: string) {
  if (item.kind !== "BETREUUNG" || item.subjectType !== "EINSATZ" || !item.subjectId) return;
  const role = ((item.fields as { role?: string } | null)?.role ?? "CUSTOMER_CARE") as "CUSTOMER_CARE" | "FREELANCER_CARE";
  const e = await tx.query.engagements.findFirst({ where: eq(schema.engagements.id, item.subjectId) });
  if (!e) return;
  const t = todayIso();
  const current = await tx.query.careAssignments.findMany({ where: and(eq(schema.careAssignments.engagementId, e.id), eq(schema.careAssignments.role, role), isNull(schema.careAssignments.toDate)) });
  for (const c of current) {
    if (c.userId === assigneeUserId) return; // schon zuständig
    await tx.update(schema.careAssignments).set({ toDate: t, endedReason: `Übergabe angenommen (Vorgang ${item.id})` }).where(eq(schema.careAssignments.id, c.id));
  }
  await tx.insert(schema.careAssignments).values({ workspaceId: e.workspaceId, engagementId: e.id, role, userId: assigneeUserId, fromDate: t, acceptedAt: new Date(), grantedBy: item.requesterUserId, handoverWorkItemId: item.id });
  // offene zuständigkeitsabhängige Aufgaben umhängen: fällige Check-ins dieser Seite
  await tx.update(schema.checkins).set({ ownerUserId: assigneeUserId, updatedAt: new Date() }).where(and(eq(schema.checkins.engagementId, e.id), eq(schema.checkins.side, role === "CUSTOMER_CARE" ? "KUNDE" : "FREELANCER"), inArray(schema.checkins.status, ["FAELLIG", "ANGEFRAGT", "GEPLANT"])));
  await recordAudit(tx, actor, "care.activated", "ENGAGEMENT", e.id, { rolle: role, person: assigneeUserId, vorher: current.map((c) => c.userId) });
  await notify(tx, { workspaceId: e.workspaceId, userIds: [e.bdUserId, item.requesterUserId], kind: "ANGENOMMEN", title: `${careRoleLabel[role]} übernommen: ${e.title}`, link: `/einsaetze/${e.id}`, actorUserId: actor.userId });
}

/** Betreuung direkt vergeben/beenden (BD-Kontext) – ohne Übergabevorgang, z. B. Vertretung oder Korrektur. */
export const setCareInput = z.object({ role: z.enum(["CUSTOMER_CARE", "FREELANCER_CARE"]), userId: opt(100), reason: opt(500) });

export async function setCareDirect(actor: Actor, engagementId: string, raw: unknown) {
  const p = setCareInput.safeParse(raw);
  if (!p.success) throw new ValidationError(issues(p.error));
  const a = await requireManagedEngagement(actor, engagementId);
  const t = todayIso();
  await db.transaction(async (tx) => {
    const current = await tx.query.careAssignments.findMany({ where: and(eq(schema.careAssignments.engagementId, engagementId), eq(schema.careAssignments.role, p.data.role), isNull(schema.careAssignments.toDate)) });
    for (const c of current) await tx.update(schema.careAssignments).set({ toDate: t, endedReason: p.data.reason || "direkt umgestellt" }).where(eq(schema.careAssignments.id, c.id));
    if (p.data.userId) {
      const u = await tx.query.users.findFirst({ where: and(eq(schema.users.id, p.data.userId), eq(schema.users.workspaceId, actor.workspaceId), eq(schema.users.status, "ACTIVE")) });
      if (!u) throw new ValidationError("Person nicht gefunden.");
      await tx.insert(schema.careAssignments).values({ workspaceId: actor.workspaceId, engagementId, role: p.data.role, userId: u.id, fromDate: t, acceptedAt: new Date(), grantedBy: actor.userId });
      await tx.update(schema.checkins).set({ ownerUserId: u.id, updatedAt: new Date() }).where(and(eq(schema.checkins.engagementId, engagementId), eq(schema.checkins.side, p.data.role === "CUSTOMER_CARE" ? "KUNDE" : "FREELANCER"), inArray(schema.checkins.status, ["FAELLIG", "ANGEFRAGT", "GEPLANT"])));
      await notify(tx, { workspaceId: actor.workspaceId, userIds: [u.id], kind: "ZUGEWIESEN", title: `${careRoleLabel[p.data.role]}: ${a.engagement.title}`, link: `/einsaetze/${engagementId}`, actorUserId: actor.userId });
    }
    await recordAudit(tx, actor, "care.set", "ENGAGEMENT", engagementId, { rolle: p.data.role, person: p.data.userId || null, grund: p.data.reason || null });
  });
}

// ---------------------------------------------------------------------------
// Check-ins
// ---------------------------------------------------------------------------

export const checkinInput = z.object({ side: z.enum(["KUNDE", "FREELANCER"]).default("KUNDE"), dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Fälligkeit fehlt"), note: opt(1000) });

export async function createCheckin(actor: Actor, engagementId: string, raw: unknown) {
  const p = checkinInput.safeParse(raw);
  if (!p.success) throw new ValidationError(issues(p.error));
  const a = await requireEngagement(actor, engagementId);
  if (!(a.manage || a.care)) throw new ForbiddenError();
  const owner = await careOwner(engagementId, p.data.side, a.engagement.bdUserId);
  return db.transaction(async (tx) => {
    const [c] = await tx.insert(schema.checkins).values({ workspaceId: actor.workspaceId, engagementId, side: p.data.side, ownerUserId: owner, dueDate: p.data.dueDate, note: p.data.note || null, createdBy: actor.userId }).returning();
    await recordAudit(tx, actor, "checkin.created", "ENGAGEMENT", engagementId, { seite: p.data.side, faellig: p.data.dueDate });
    return c!;
  });
}

async function careOwner(engagementId: string, side: "KUNDE" | "FREELANCER", fallback: string, tx: Tx | Db = db): Promise<string> {
  const c = await tx.query.careAssignments.findFirst({ where: and(eq(schema.careAssignments.engagementId, engagementId), eq(schema.careAssignments.role, side === "KUNDE" ? "CUSTOMER_CARE" : "FREELANCER_CARE"), isNull(schema.careAssignments.toDate)) });
  return c?.userId ?? fallback;
}

export const checkinUpdateInput = z.object({
  version: z.coerce.number().int().positive(),
  action: z.enum(["ANFRAGEN", "TERMINIEREN", "ERLEDIGEN", "VERSCHIEBEN", "ABSAGEN"]),
  scheduledAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).optional().or(z.literal("")),
  heldAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).optional().or(z.literal("")),
  newDueDate: dateStr,
  participants: opt(500),
  note: opt(4000),
  risks: opt(2000),
  openPoints: opt(2000),
  nextStep: opt(500),
  salesHint: opt(2000),
  reason: opt(500),
  /** Schnellerfassung: Stimmung statt ausformuliertem Ergebnis; Termin = jetzt, wenn keiner angegeben */
  mood: z.enum(["POSITIV", "MITTEL", "NEGATIV", ""]).optional(),
});
export const moodLabel: Record<string, string> = { POSITIV: "positiv", MITTEL: "mittel", NEGATIV: "negativ" };

/**
 * Check-in führen. ERLEDIGEN verlangt tatsächlichen Termin und Ergebnis, aktualisiert den letzten Kontakt und erzeugt den
 * nächsten fälligen Kunden-Check-in (+42 Tage). VERSCHIEBEN ändert nur die Fälligkeit, nie den letzten Kontakt.
 * Ein Sales-Hinweis wird als Signal (Beobachtung) im Setup vorgeschlagen – der BD prüft wie gewohnt.
 */
export async function actOnCheckin(actor: Actor, checkinId: string, raw: unknown) {
  const p = checkinUpdateInput.safeParse(raw);
  if (!p.success) throw new ValidationError(issues(p.error));
  const c = await db.query.checkins.findFirst({ where: and(eq(schema.checkins.id, checkinId), eq(schema.checkins.workspaceId, actor.workspaceId)) });
  if (!c) throw new NotFoundError("Check-in");
  const a = await requireEngagement(actor, c.engagementId);
  if (!(a.manage || c.ownerUserId === actor.userId)) throw new ForbiddenError("Den Check-in führt die zuständige Betreuungsperson (oder BD/Principal/CEO).");
  if (["ERLEDIGT", "ABGESAGT"].includes(c.status)) throw new TransitionError("Dieser Check-in ist abgeschlossen.");
  const i = p.data;
  const patch: Partial<typeof schema.checkins.$inferInsert> = {};
  let next: string | null = null;
  let signalId: string | null = null;
  switch (i.action) {
    case "ANFRAGEN":
      patch.status = "ANGEFRAGT";
      break;
    case "TERMINIEREN":
      if (!i.scheduledAt) throw new ValidationError("„Geplant“ braucht einen bestätigten Zeitpunkt.");
      patch.status = "GEPLANT";
      patch.scheduledAt = new Date(`${i.scheduledAt}:00+02:00`);
      patch.participants = i.participants || c.participants;
      break;
    case "ERLEDIGEN": {
      // Schnellerfassung (Meine Arbeit): Stimmung genügt, Termin ist dann „jetzt“
      if (i.mood && !i.heldAt) i.heldAt = new Date(Date.now() + 2 * 3600000).toISOString().slice(0, 16);
      if (i.mood && (!i.note || i.note.length < 5)) i.note = `Stimmung: ${moodLabel[i.mood]}${i.note ? ` – ${i.note}` : ""}`;
      if (!i.heldAt) throw new ValidationError("Bitte den tatsächlichen Gesprächstermin angeben.");
      if (!i.note || i.note.length < 5) throw new ValidationError("Bitte ein kurzes Ergebnis festhalten oder die Stimmung wählen.");
      patch.status = "ERLEDIGT";
      patch.heldAt = new Date(`${i.heldAt}:00+02:00`);
      patch.participants = i.participants || c.participants;
      patch.note = i.mood && !i.note.startsWith("Stimmung:") ? `Stimmung: ${moodLabel[i.mood]} – ${i.note}` : i.note;
      patch.risks = i.risks || null;
      patch.openPoints = i.openPoints || null;
      patch.nextStep = i.nextStep || null;
      patch.salesHint = i.salesHint || null;
      next = plusDaysIso(i.heldAt.slice(0, 10), CATCHUP_DAYS);
      break;
    }
    case "VERSCHIEBEN":
      if (!i.newDueDate) throw new ValidationError("Bitte das neue Datum angeben.");
      if (!i.reason) throw new ValidationError("Bitte den Grund der Verschiebung festhalten.");
      patch.status = "FAELLIG";
      patch.dueDate = i.newDueDate;
      patch.note = `${c.note ?? ""}\nVerschoben (${todayIso()}): ${i.reason}`.trim();
      break;
    case "ABSAGEN":
      if (!i.reason) throw new ValidationError("Bitte den Grund festhalten.");
      patch.status = "ABGESAGT";
      patch.note = `${c.note ?? ""}\nAbgesagt: ${i.reason}`.trim();
      break;
  }
  if (i.action === "ERLEDIGEN" && i.heldAt && i.salesHint && i.salesHint.length >= 5) {
    const heldDay = i.heldAt.slice(0, 10);
    // Sales-Rückkopplung: Signalvorschlag im Setup, erlaubte Verwendung = internes Gespräch; BD prüft Bezug und Dublette
    try {
      const sig = await captureObservation(actor, { setupId: a.engagement.setupId, observation: i.salesHint, relevanceHypothesis: `Aus Check-in (${c.side === "KUNDE" ? "Kunde" : "Freelancer"}) am ${heldDay} zum Einsatz „${a.engagement.title}“.`, usageLimit: "Intern aus Betreuungsgespräch – vor Verwendung beim Kunden mit der Betreuungsperson abstimmen.", sourceTitle: `Check-in ${a.engagement.title} ${heldDay}`, sourceAccessClass: "ACCOUNT_TEAM" });
      signalId = sig.signal.id;
    } catch {
      signalId = null; // z. B. Betreuungsperson ohne Setup-Bearbeitungsrecht: Hinweis bleibt am Check-in, BD legt das Signal an
    }
  }
  return db.transaction(async (tx) => {
    const [u] = await tx
      .update(schema.checkins)
      .set({ ...patch, salesSignalId: signalId ?? c.salesSignalId, version: i.version + 1, updatedAt: new Date() })
      .where(and(eq(schema.checkins.id, checkinId), eq(schema.checkins.version, i.version)))
      .returning();
    if (!u) throw new ConflictError();
    await recordAudit(tx, actor, "checkin.updated", "ENGAGEMENT", c.engagementId, { aktion: i.action, status: u.status });
    // Folgetermin im 6-Wochen-Rhythmus – nur für Freelancer-Einsätze (Kunde und Freelancer), nicht für interne
    if (next && a.engagement.freelancerId && ["AKTIV", "GEPLANT", "ENDET"].includes(a.engagement.status)) {
      const side = c.side === "KUNDE" ? "KUNDE" : "FREELANCER";
      const owner = await careOwner(c.engagementId, side, a.engagement.bdUserId, tx);
      await tx.insert(schema.checkins).values({ workspaceId: actor.workspaceId, engagementId: c.engagementId, side, ownerUserId: owner, dueDate: next, ruleKey: `catchup:${c.engagementId}:${side === "KUNDE" ? "" : "FREELANCER:"}${next}`, createdBy: actor.userId }).onConflictDoNothing();
    }
    if (signalId) await notify(tx, { workspaceId: actor.workspaceId, userIds: [a.engagement.bdUserId], kind: "KOMMENTAR", title: `Sales-Hinweis aus Check-in (${a.engagement.title}) – bitte prüfen`, link: `/setups/${a.engagement.setupId}`, actorUserId: actor.userId });
    if (i.salesHint && !signalId) await notify(tx, { workspaceId: actor.workspaceId, userIds: [a.engagement.bdUserId], kind: "KOMMENTAR", title: `Sales-Hinweis aus Check-in (${a.engagement.title}): ${i.salesHint.slice(0, 100)}`, link: `/einsaetze/${c.engagementId}#checkins`, actorUserId: actor.userId });
    return u;
  });
}

/** Regel: je aktivem Einsatz genau ein offener Kunden-Check-in; Fälligkeit = letztes erfolgtes Gespräch + 42 Tage, sonst Start + 42. */
export async function ensureCatchups(workspaceId?: string): Promise<number> {
  // Nur Freelancer-Einsätze bekommen automatische Rhythmen (Kunde UND Freelancer, alle 6 Wochen); interne Einsätze nicht.
  const rows = (await db.query.engagements.findMany({ where: and(workspaceId ? eq(schema.engagements.workspaceId, workspaceId) : undefined, inArray(schema.engagements.status, ["AKTIV"])) })).filter((e) => !!e.freelancerId);
  let n = 0;
  for (const e of rows) {
    for (const side of ["KUNDE", "FREELANCER"] as const) {
      const open = await db.query.checkins.findFirst({ where: and(eq(schema.checkins.engagementId, e.id), eq(schema.checkins.side, side), inArray(schema.checkins.status, ["FAELLIG", "ANGEFRAGT", "GEPLANT"])) });
      if (open) continue;
      const last = await db.query.checkins.findFirst({ where: and(eq(schema.checkins.engagementId, e.id), eq(schema.checkins.side, side), eq(schema.checkins.status, "ERLEDIGT")), orderBy: desc(schema.checkins.heldAt) });
      const base = last?.heldAt ? last.heldAt.toISOString().slice(0, 10) : e.actualStart ?? e.plannedStart ?? todayIso();
      // Nie rückwirkend terminieren: liegt der rechnerische Termin in der Vergangenheit, kommt der erste Check-in in einer Woche
      const computed = plusDaysIso(base, CATCHUP_DAYS);
      const due = computed < todayIso() ? plusDaysIso(todayIso(), 7) : computed;
      const owner = await careOwner(e.id, side, e.bdUserId);
      const ins = await db.insert(schema.checkins).values({ workspaceId: e.workspaceId, engagementId: e.id, side, ownerUserId: owner, dueDate: due, ruleKey: `catchup:${e.id}:${side === "KUNDE" ? "" : "FREELANCER:"}${due}`, createdBy: e.bdUserId }).onConflictDoNothing().returning({ id: schema.checkins.id });
      n += ins.length;
    }
  }
  return n;
}

/** Fällige/überfällige Check-ins: ein Hinweis je Check-in und Tag an die zuständige Person. */
export async function notifyDueCheckins(workspaceId?: string): Promise<number> {
  const t = todayIso();
  const rows = await db.query.checkins.findMany({ where: and(workspaceId ? eq(schema.checkins.workspaceId, workspaceId) : undefined, inArray(schema.checkins.status, ["FAELLIG", "ANGEFRAGT"])) });
  let n = 0;
  for (const c of rows.filter((c) => c.dueDate <= plusDaysIso(t, 7))) {
    const e = await db.query.engagements.findFirst({ where: eq(schema.engagements.id, c.engagementId), columns: { title: true, workspaceId: true } });
    if (!e) continue;
    const overdue = c.dueDate < t;
    n += await notify(db, { workspaceId: e.workspaceId, userIds: [c.ownerUserId], kind: overdue ? "UEBERFAELLIG" : "ZUGEWIESEN", title: `${overdue ? "Überfälliger" : "Fälliger"} Check-in (${c.side === "KUNDE" ? "Kunde" : "Freelancer"}) bis ${c.dueDate}: ${e.title}`, link: `/einsaetze/${c.engagementId}#checkins`, dedupeKey: `checkin:${c.id}:${overdue ? t : c.dueDate}` });
  }
  return n;
}

export async function listMyCheckins(actor: Actor) {
  const rows = await db.query.checkins.findMany({ where: and(eq(schema.checkins.workspaceId, actor.workspaceId), eq(schema.checkins.ownerUserId, actor.userId), inArray(schema.checkins.status, ["FAELLIG", "ANGEFRAGT", "GEPLANT"])), orderBy: asc(schema.checkins.dueDate) });
  if (!rows.length) return [];
  const engs = await db.query.engagements.findMany({ where: inArray(schema.engagements.id, [...new Set(rows.map((r) => r.engagementId))]), columns: { id: true, title: true, accountId: true } });
  const accounts = await db.query.accounts.findMany({ where: inArray(schema.accounts.id, [...new Set(engs.map((e) => e.accountId))]), columns: { id: true, name: true } });
  const en = new Map(engs.map((e) => [e.id, e]));
  const an = new Map(accounts.map((a) => [a.id, a.name]));
  const t = todayIso();
  return rows.map((r) => ({ ...r, engagementTitle: en.get(r.engagementId)?.title ?? "?", accountName: an.get(en.get(r.engagementId)?.accountId ?? "") ?? "?", overdue: r.dueDate < t }));
}

// ---------------------------------------------------------------------------
// Verlängerungsentscheidung
// ---------------------------------------------------------------------------

export const renewalInput = z.object({
  version: z.coerce.number().int().positive().optional(),
  status: z.enum(["ZU_KLAEREN", "IN_ABSTIMMUNG", "ANGEBOTEN", "BESTAETIGT", "ABGELEHNT", "ERLEDIGT"]),
  proposedFrom: dateStr,
  proposedTo: dateStr,
  conditionsNote: opt(1000),
  availabilityNote: opt(500),
  commercialOwnerUserId: opt(100),
  contractFollowUp: opt(500),
  /** bei BESTAETIGT: Konditionen der neuen bestätigten Periode */
  ek: opt(20),
  vk: opt(20),
  rateUnit: z.enum(["TAG", "STUNDE"]).optional(),
});

/** Stand der Verlängerung fortschreiben; „bestätigt“ braucht Zeitraum, Konditionsstand und Vertragsfolge und erzeugt eine neue bestätigte Periode. */
export async function upsertRenewalDecision(actor: Actor, engagementId: string, raw: unknown) {
  const p = renewalInput.safeParse(raw);
  if (!p.success) throw new ValidationError(issues(p.error));
  const a = await requireEngagement(actor, engagementId);
  if (!(a.manage || a.care)) throw new ForbiddenError();
  const i = p.data;
  const e = a.engagement;
  if (["BESTAETIGT", "ABGELEHNT"].includes(i.status) && !a.commercial) throw new ForbiddenError("Bestätigen oder ablehnen darf der verantwortliche BD, Principal oder CEO (kommerzielle Zuständigkeit); Sales Operations stößt an.");
  const current = await db.query.renewalDecisions.findFirst({ where: and(eq(schema.renewalDecisions.engagementId, engagementId), inArray(schema.renewalDecisions.status, ["ZU_KLAEREN", "IN_ABSTIMMUNG", "ANGEBOTEN"])) });
  if (i.status === "BESTAETIGT") {
    if (!i.proposedFrom || !i.proposedTo) throw new ValidationError("Bestätigung braucht den bestätigten Zeitraum (von/bis).");
    if (!i.conditionsNote && !i.ek && !i.vk) throw new ValidationError("Bestätigung braucht den Konditionsstand (EK/VK oder Notiz).");
    if (!i.contractFollowUp) throw new ValidationError("Bestätigung braucht die nötige Vertragsfolge (z. B. Nachtrag, neue Bestellung).");
  }
  return db.transaction(async (tx) => {
    let periodId: string | null = null;
    if (i.status === "BESTAETIGT") {
      const period = await addPeriod(actor, engagementId, { kind: "BESTAETIGT", validFrom: i.proposedFrom, validTo: i.proposedTo, ek: i.ek, vk: i.vk, rateUnit: i.rateUnit ?? "TAG", source: "Verlängerung bestätigt", note: i.conditionsNote }, tx);
      periodId = period.id;
      await tx.update(schema.engagements).set({ plannedEnd: i.proposedTo, updatedAt: new Date() }).where(eq(schema.engagements.id, engagementId));
    }
    const values = { triggerDate: current?.triggerDate ?? todayIso(), status: i.status, proposedFrom: i.proposedFrom || null, proposedTo: i.proposedTo || null, conditionsNote: i.conditionsNote || null, availabilityNote: i.availabilityNote || null, commercialOwnerUserId: i.commercialOwnerUserId || e.bdUserId, contractFollowUp: i.contractFollowUp || null, resultPeriodId: periodId, decidedBy: ["BESTAETIGT", "ABGELEHNT", "ERLEDIGT"].includes(i.status) ? actor.userId : null, decidedAt: ["BESTAETIGT", "ABGELEHNT", "ERLEDIGT"].includes(i.status) ? new Date() : null, updatedAt: new Date() };
    let row;
    if (current) {
      if (i.version && i.version !== current.version) throw new ConflictError();
      [row] = await tx.update(schema.renewalDecisions).set({ ...values, version: current.version + 1 }).where(eq(schema.renewalDecisions.id, current.id)).returning();
    } else {
      [row] = await tx.insert(schema.renewalDecisions).values({ workspaceId: actor.workspaceId, engagementId, ...values, createdBy: actor.userId }).returning();
    }
    await recordAudit(tx, actor, "renewal.decision", "ENGAGEMENT", engagementId, { status: i.status, bis: i.proposedTo || null });
    if (["BESTAETIGT", "ABGELEHNT"].includes(i.status)) {
      const cares = await tx.query.careAssignments.findMany({ where: and(eq(schema.careAssignments.engagementId, engagementId), isNull(schema.careAssignments.toDate)) });
      await notify(tx, { workspaceId: actor.workspaceId, userIds: cares.map((c) => c.userId), kind: "KOMMENTAR", title: `Verlängerung ${renewalStatusLabel[i.status]}: ${e.title}`, link: `/einsaetze/${engagementId}#verlaengerung`, actorUserId: actor.userId });
    }
    return row!;
  });
}

// ---------------------------------------------------------------------------
// Verlängerung als Anstoß + Karte (Etappe 33, Use Case 1): Sales Operations/Betreuung stößt an, BD/Principal/CEO entscheidet
// mit einem Klick; das System schreibt Periode, Einsatzende, Auftragsende und das Projektende nach Moco.
// ---------------------------------------------------------------------------

export const RENEWAL_OPEN = ["ZU_KLAEREN", "IN_ABSTIMMUNG", "ANGEBOTEN"] as const;

export const renewalStartInput = z.object({
  newEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Neues Ende als Datum angeben."),
  conditions: z.enum(["UNVERAENDERT", "NEU"]).default("UNVERAENDERT"),
  ek: opt(20),
  vk: opt(20),
  rateUnit: z.enum(["TAG", "STUNDE"]).optional(),
  note: opt(1000),
});

async function latestPeriod(engagementId: string) {
  const rows = await db.query.engagementPeriods.findMany({ where: eq(schema.engagementPeriods.engagementId, engagementId), orderBy: [desc(schema.engagementPeriods.validFrom), desc(schema.engagementPeriods.createdAt)] });
  return rows.find((r) => r.kind === "BESTAETIGT") ?? rows[0] ?? null;
}

async function principalsFor(workspaceId: string, accountId: string): Promise<string[]> {
  const t = todayIso();
  const rows = await db.query.roleAssignments.findMany({ where: and(eq(schema.roleAssignments.workspaceId, workspaceId), eq(schema.roleAssignments.role, "PRINCIPAL")) });
  return rows.filter((r) => (!r.validTo || r.validTo >= t) && (r.scope === "WORKSPACE" || r.accountId === accountId)).map((r) => r.userId);
}

async function salesOpsUsers(workspaceId: string): Promise<string[]> {
  const t = todayIso();
  const rows = await db.query.roleAssignments.findMany({ where: and(eq(schema.roleAssignments.workspaceId, workspaceId), eq(schema.roleAssignments.role, "SALES_OPS")) });
  return rows.filter((r) => !r.validTo || r.validTo >= t).map((r) => r.userId);
}

function personLabel(e: { freelancerId: string | null; internalUserId: string | null }, fn: Map<string, string>, un: Map<string, string>): string {
  return e.freelancerId ? fn.get(e.freelancerId) ?? "?" : e.internalUserId ? un.get(e.internalUserId) ?? "?" : "?";
}

/** Verlängerung anstoßen: ein Datum, Konditionen „unverändert“ als Vorgabe, optional eine Notiz. Erlaubt für alle, die den Einsatz sehen. */
export async function startRenewal(actor: Actor, engagementId: string, raw: unknown) {
  const p = renewalStartInput.safeParse(raw);
  if (!p.success) throw new ValidationError(issues(p.error));
  const a = await requireEngagement(actor, engagementId);
  const e = a.engagement;
  const i = p.data;
  if (!["AKTIV", "PAUSIERT", "GEPLANT", "ENDET"].includes(e.status)) throw new TransitionError("Verlängert wird ein laufender Einsatz.");
  const currentEnd = e.plannedEnd ?? todayIso();
  if (i.newEnd <= currentEnd) throw new ValidationError(`Das neue Ende muss nach dem heutigen Ende (${currentEnd}) liegen.`);
  if (i.conditions === "NEU" && !i.ek && !i.vk) throw new ValidationError("Neue Konditionen brauchen EK oder VK.");
  const last = await latestPeriod(engagementId);
  const unit = i.rateUnit ?? last?.rateUnit ?? "TAG";
  const ek = i.conditions === "NEU" ? i.ek || last?.ek || "" : last?.ek ?? "";
  const vk = i.conditions === "NEU" ? i.vk || last?.vk || "" : last?.vk ?? "";
  const rates = ek || vk ? ` (EK ${ek || "–"} / VK ${vk || "–"} je ${unit === "STUNDE" ? "Stunde" : "Tag"})` : "";
  const conditionsNote = `${i.conditions === "NEU" ? "Neue Konditionen" : "Konditionen unverändert"}${rates}`;
  const proposedFrom = e.plannedEnd ? plusDaysIso(e.plannedEnd, 1) : todayIso();
  const current = await db.query.renewalDecisions.findFirst({ where: and(eq(schema.renewalDecisions.engagementId, engagementId), inArray(schema.renewalDecisions.status, [...RENEWAL_OPEN])) });
  const [fls, users] = await Promise.all([
    e.freelancerId ? db.query.freelancers.findMany({ where: eq(schema.freelancers.id, e.freelancerId), columns: { id: true, displayName: true } }) : Promise.resolve([]),
    db.query.users.findMany({ where: eq(schema.users.workspaceId, actor.workspaceId), columns: { id: true, displayName: true } }),
  ]);
  const person = personLabel(e, new Map(fls.map((f) => [f.id, f.displayName])), new Map(users.map((u) => [u.id, u.displayName])));
  const principals = await principalsFor(actor.workspaceId, e.accountId);
  return db.transaction(async (tx) => {
    const values = { status: "IN_ABSTIMMUNG", proposedFrom, proposedTo: i.newEnd, conditionsNote, availabilityNote: i.note || null, commercialOwnerUserId: e.bdUserId, triggerDate: current?.triggerDate ?? todayIso(), updatedAt: new Date() };
    let row;
    if (current) [row] = await tx.update(schema.renewalDecisions).set({ ...values, version: current.version + 1 }).where(eq(schema.renewalDecisions.id, current.id)).returning();
    else [row] = await tx.insert(schema.renewalDecisions).values({ workspaceId: actor.workspaceId, engagementId, ...values, createdBy: actor.userId }).returning();
    await recordAudit(tx, actor, "renewal.requested", "ENGAGEMENT", engagementId, { bis: i.newEnd, konditionen: conditionsNote });
    await notify(tx, { workspaceId: actor.workspaceId, userIds: [e.bdUserId, ...principals], kind: "ZUGEWIESEN", title: `Verlängerung bestätigen: ${person} bei ${a.account.name} bis ${i.newEnd}`, link: `/start#entscheidungen`, actorUserId: actor.userId, dedupeKey: `renewal-request:${row!.id}:${i.newEnd}` });
    return row!;
  });
}

export const renewalDecideInput = z.object({
  version: z.coerce.number().int().positive().optional(),
  decision: z.enum(["BESTAETIGEN", "ABLEHNEN", "WEITERGEBEN"]),
  contractFollowUp: opt(500),
  note: opt(1000),
  targetUserId: opt(100),
});

export type RenewalDecideResult = { decision: typeof schema.renewalDecisions.$inferSelect; mocoWritten: boolean; mocoError: string | null };

/** Entscheidung mit einem Klick: Bestätigen schreibt Periode, Einsatz- und Auftragsende und das Projektende nach Moco; Ablehnen geht mit Notiz zurück; Weitergeben verschiebt die Karte. */
export async function decideRenewal(actor: Actor, engagementId: string, raw: unknown, client?: MocoClient): Promise<RenewalDecideResult> {
  const p = renewalDecideInput.safeParse(raw);
  if (!p.success) throw new ValidationError(issues(p.error));
  const i = p.data;
  const a = await requireEngagement(actor, engagementId);
  const e = a.engagement;
  const current = await db.query.renewalDecisions.findFirst({ where: and(eq(schema.renewalDecisions.engagementId, engagementId), inArray(schema.renewalDecisions.status, [...RENEWAL_OPEN])) });
  if (!current) throw new NotFoundError("Verlängerungsentscheidung");
  if (i.version && i.version !== current.version) throw new ConflictError();
  const requester = current.createdBy;
  if (i.decision === "WEITERGEBEN") {
    if (!(a.manage || a.care)) throw new ForbiddenError();
    if (!i.targetUserId) throw new ValidationError("Bitte die Person wählen, an die die Entscheidung geht.");
    const target = await db.query.users.findFirst({ where: and(eq(schema.users.id, i.targetUserId), eq(schema.users.workspaceId, actor.workspaceId)) });
    if (!target) throw new NotFoundError("Person");
    const targetActor = await (await import("@/modules/identity/actor")).loadActor(target.id);
    const ta = targetActor ? await engagementAccess(targetActor, e) : null;
    if (!ta?.commercial) throw new ValidationError(`${target.displayName} darf diese Verlängerung nicht entscheiden (kein BD-Kontext, Principal oder CEO).`);
    return db.transaction(async (tx) => {
      const [row] = await tx.update(schema.renewalDecisions).set({ commercialOwnerUserId: target.id, availabilityNote: i.note ? `${current.availabilityNote ? `${current.availabilityNote}\n` : ""}Weitergabe von ${actor.displayName}: ${i.note}` : current.availabilityNote, version: current.version + 1, updatedAt: new Date() }).where(eq(schema.renewalDecisions.id, current.id)).returning();
      await recordAudit(tx, actor, "renewal.delegated", "ENGAGEMENT", engagementId, { an: target.id });
      await notify(tx, { workspaceId: actor.workspaceId, userIds: [target.id], kind: "ZUGEWIESEN", title: `Verlängerung entscheiden: ${e.title}${i.note ? ` – ${i.note.slice(0, 80)}` : ""}`, link: `/start#entscheidungen`, actorUserId: actor.userId });
      return { decision: row!, mocoWritten: false, mocoError: null };
    });
  }
  if (!a.commercial) throw new ForbiddenError("Bestätigen oder ablehnen darf der verantwortliche BD, Principal oder CEO; Sales Operations stößt an.");
  if (i.decision === "ABLEHNEN") {
    const row = await upsertRenewalDecision(actor, engagementId, { version: current.version, status: "ABGELEHNT", proposedFrom: current.proposedFrom ?? "", proposedTo: current.proposedTo ?? "", conditionsNote: current.conditionsNote ?? "", availabilityNote: `Abgelehnt von ${actor.displayName}${i.note ? `: ${i.note}` : ""}`, commercialOwnerUserId: actor.userId });
    await notify(db, { workspaceId: actor.workspaceId, userIds: [requester], kind: "ABGELEHNT", title: `Verlängerung abgelehnt: ${e.title}${i.note ? ` – ${i.note.slice(0, 80)}` : ""}`, link: `/einsaetze/${engagementId}#verlaengerung`, actorUserId: actor.userId });
    return { decision: row, mocoWritten: false, mocoError: null };
  }
  // BESTAETIGEN
  if (!current.proposedTo) throw new ValidationError("Für diese Verlängerung ist noch kein neues Ende vorgeschlagen – bitte zuerst anstoßen.");
  const last = await latestPeriod(engagementId);
  const m = /EK ([^ /]+) \/ VK ([^ )]+) je (Stunde|Tag)/.exec(current.conditionsNote ?? "");
  const num = (x: string | undefined | null) => (x && x !== "–" ? x : "");
  const ek = m ? num(m[1]) : last?.ek ?? "";
  const vk = m ? num(m[2]) : last?.vk ?? "";
  const rateUnit = m ? (m[3] === "Stunde" ? "STUNDE" : "TAG") : ((last?.rateUnit as "TAG" | "STUNDE" | undefined) ?? "TAG");
  const row = await upsertRenewalDecision(actor, engagementId, {
    version: current.version,
    status: "BESTAETIGT",
    proposedFrom: current.proposedFrom ?? (e.plannedEnd ? plusDaysIso(e.plannedEnd, 1) : todayIso()),
    proposedTo: current.proposedTo,
    conditionsNote: `${current.conditionsNote ?? "Konditionen unverändert"}${i.note ? ` – ${i.note}` : ""}`,
    availabilityNote: current.availabilityNote ?? "",
    contractFollowUp: i.contractFollowUp || "Nachtrag",
    commercialOwnerUserId: actor.userId,
    ek,
    vk,
    rateUnit,
  });
  if (e.orderId) await db.update(schema.orders).set({ plannedEnd: current.proposedTo, updatedAt: new Date() }).where(eq(schema.orders.id, e.orderId));
  // Projektende nach Moco (zweiter Schreibzugriff nach den Leads), protokolliert; bei Fehler Aufgabe an Sales Operations
  let mocoWritten = false;
  let mocoError: string | null = null;
  if (e.mocoProjectId && (client || mocoEnabled())) {
    try {
      await (client ?? getMocoClient()).updateProjectFinishDate(e.mocoProjectId, current.proposedTo);
      mocoWritten = true;
      await recordAudit(db, actor, "engagement.moco_finish_date", "ENGAGEMENT", engagementId, { mocoProjectId: e.mocoProjectId, finishDate: current.proposedTo });
    } catch (err) {
      mocoError = err instanceof Error ? err.message : String(err);
      const ops = await salesOpsUsers(actor.workspaceId);
      await notify(db, { workspaceId: actor.workspaceId, userIds: [...ops, requester, actor.userId], kind: "ZUGEWIESEN", title: `Projektende in Moco von Hand setzen: ${e.title} bis ${current.proposedTo} (Schreibzugriff fehlgeschlagen)`, link: `/einsaetze/${engagementId}#verlaengerung`, dedupeKey: `moco-finish-manual:${engagementId}:${current.proposedTo}` });
    }
  }
  await notify(db, { workspaceId: actor.workspaceId, userIds: [requester], kind: "ERLEDIGT", title: `Verlängerung bestätigt: ${e.title} bis ${current.proposedTo}${mocoWritten ? " (Moco aktualisiert)" : ""}`, link: `/einsaetze/${engagementId}#verlaengerung`, actorUserId: actor.userId });
  return { decision: row, mocoWritten, mocoError };
}

export type RenewalCard = {
  decisionId: string;
  version: number;
  engagementId: string;
  engagementTitle: string;
  mocoProjectId: number | null;
  person: string;
  accountId: string;
  accountName: string;
  status: string;
  currentEnd: string | null;
  proposedTo: string | null;
  conditionsNote: string | null;
  note: string | null;
  requestedBy: string;
  requestedAt: Date;
  daysToEnd: number | null;
  /** die Karte ist für mich eine Entscheidung (BD/Principal/CEO) oder ein Anstoß (Sales Ops/Betreuung) */
  mode: "ENTSCHEIDEN" | "ANSTOSSEN";
  /** Personen, an die ich weitergeben kann (kommerziell zuständig) */
  delegates: { id: string; name: string }[];
};

/** Verlängerungskarten für die Startseite: offene Entscheidungen (in Abstimmung) für kommerziell Zuständige, zu klärende für Sales Operations/Betreuung. */
export async function listRenewalCards(actor: Actor): Promise<RenewalCard[]> {
  const t = todayIso();
  const open = await db.query.renewalDecisions.findMany({ where: and(eq(schema.renewalDecisions.workspaceId, actor.workspaceId), inArray(schema.renewalDecisions.status, [...RENEWAL_OPEN])), orderBy: asc(schema.renewalDecisions.createdAt) });
  if (!open.length) return [];
  const engs = await db.query.engagements.findMany({ where: inArray(schema.engagements.id, open.map((o) => o.engagementId)) });
  const en = new Map(engs.map((e) => [e.id, e]));
  const [accounts, fls, users] = await Promise.all([
    db.query.accounts.findMany({ where: inArray(schema.accounts.id, [...new Set(engs.map((e) => e.accountId))]), columns: { id: true, name: true } }),
    db.query.freelancers.findMany({ where: inArray(schema.freelancers.id, [...new Set(engs.map((e) => e.freelancerId).filter((x): x is string => !!x)), "-"]), columns: { id: true, displayName: true } }),
    db.query.users.findMany({ where: eq(schema.users.workspaceId, actor.workspaceId), columns: { id: true, displayName: true } }),
  ]);
  const an = new Map(accounts.map((a) => [a.id, a.name]));
  const fn = new Map(fls.map((f) => [f.id, f.displayName]));
  const un = new Map(users.map((u) => [u.id, u.displayName]));
  const out: RenewalCard[] = [];
  for (const d of open) {
    const e = en.get(d.engagementId);
    if (!e || !["AKTIV", "PAUSIERT", "GEPLANT", "ENDET"].includes(e.status)) continue;
    const a = await engagementAccess(actor, e);
    if (!a) continue;
    const inDecision = d.status !== "ZU_KLAEREN" && !!d.proposedTo;
    let mode: RenewalCard["mode"] | null = null;
    if (inDecision && a.commercial) mode = "ENTSCHEIDEN";
    else if (!inDecision && (a.ops || a.care || a.commercial)) mode = "ANSTOSSEN";
    if (!mode) continue;
    const delegates: RenewalCard["delegates"] = [];
    if (mode === "ENTSCHEIDEN") {
      const principals = await principalsFor(actor.workspaceId, e.accountId);
      for (const id of new Set([e.bdUserId, ...principals])) if (id !== actor.userId && un.has(id)) delegates.push({ id, name: un.get(id)! });
    }
    out.push({
      decisionId: d.id,
      version: d.version,
      engagementId: e.id,
      engagementTitle: e.title,
      mocoProjectId: e.mocoProjectId,
      person: personLabel(e, fn, un),
      accountId: e.accountId,
      accountName: an.get(e.accountId) ?? "?",
      status: d.status,
      currentEnd: e.plannedEnd,
      proposedTo: d.proposedTo,
      conditionsNote: d.conditionsNote,
      note: d.availabilityNote,
      requestedBy: un.get(d.createdBy) ?? "Regel",
      requestedAt: d.updatedAt ?? d.createdAt,
      daysToEnd: e.plannedEnd ? Math.round((new Date(e.plannedEnd).getTime() - new Date(t).getTime()) / 86400000) : null,
      mode,
      delegates,
    });
  }
  return out.sort((x, y) => (x.mode === y.mode ? (x.daysToEnd ?? 9999) - (y.daysToEnd ?? 9999) : x.mode === "ENTSCHEIDEN" ? -1 : 1));
}

/** Regel: 90 Tage vor Ende (bzw. 30 vor Frist) eine Verlängerungsentscheidung „zu klären“ anlegen und Ping an BD/Betreuung – einmal je Einsatz. */
export async function ensureRenewalDecisions(workspaceId?: string): Promise<number> {
  const { renewalPingDate } = await import("@/modules/health/service");
  const t = todayIso();
  const rows = await db.query.engagements.findMany({ where: and(workspaceId ? eq(schema.engagements.workspaceId, workspaceId) : undefined, inArray(schema.engagements.status, ["AKTIV", "PAUSIERT"])) });
  let n = 0;
  for (const e of rows) {
    const ping = renewalPingDate(e);
    if (!ping || ping > t) continue;
    if ((e.plannedEnd ?? e.renewalDeadline ?? "9999") < t) continue;
    const any = await db.query.renewalDecisions.findFirst({ where: eq(schema.renewalDecisions.engagementId, e.id) });
    if (any) continue;
    await db.transaction(async (tx) => {
      await tx.insert(schema.renewalDecisions).values({ workspaceId: e.workspaceId, engagementId: e.id, triggerDate: ping, status: "ZU_KLAEREN", commercialOwnerUserId: e.bdUserId, createdBy: e.bdUserId });
      const cares = await tx.query.careAssignments.findMany({ where: and(eq(schema.careAssignments.engagementId, e.id), isNull(schema.careAssignments.toDate)) });
      await notify(tx, { workspaceId: e.workspaceId, userIds: [e.bdUserId, ...cares.map((c) => c.userId)], kind: "ZUGEWIESEN", title: `Verlängerung klären: „${e.title}“ endet am ${e.plannedEnd ?? e.renewalDeadline}`, link: `/einsaetze/${e.id}#verlaengerung`, dedupeKey: `renewal:engagement:${e.id}` });
    });
    n++;
  }
  return n;
}
