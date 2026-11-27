import { deadlines } from "@/modules/settings/deadlines";
import { isoDe } from "@/lib/labels";
import { and, asc, desc, eq, inArray, isNull, notInArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema, type Db, type Tx } from "@/db/client";
import { ConflictError, ForbiddenError, NotFoundError, TransitionError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import { hasRole, type Actor } from "@/modules/identity/actor";
import { notify, resolveNotifications } from "@/modules/notifications/service";
import { engagementLabel } from "./label";
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

/** Standardabstand; der geltende Wert kommt aus den einstellbaren Fristen (e72). */
export const CATCHUP_DAYS = 42;
export const checkinStatusLabel: Record<string, string> = { FAELLIG: "fällig", ANGEFRAGT: "angefragt", GEPLANT: "geplant", ERLEDIGT: "erledigt", VERSCHOBEN: "verschoben", ABGESAGT: "entfallen" };
export const renewalStatusLabel: Record<string, string> = { ZU_KLAEREN: "zu klären", MOEGLICH: "möglich (noch zu früh)", IN_ABSTIMMUNG: "in Abstimmung", ANGEBOTEN: "angeboten", BESTAETIGT: "bestätigt", ABGELEHNT: "abgelehnt", ERLEDIGT: "erledigt" };

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
  await notify(tx, { workspaceId: e.workspaceId, userIds: [e.bdUserId, item.requesterUserId], kind: "ANGENOMMEN", title: `${careRoleLabel[role]} übernommen: ${await engagementLabel(db, e)}`, link: `/einsaetze/${e.id}`, actorUserId: actor.userId });
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
      await notify(tx, { workspaceId: actor.workspaceId, userIds: [u.id], kind: "ZUGEWIESEN", title: `${careRoleLabel[p.data.role]}: ${await engagementLabel(db, a.engagement)}`, link: `/einsaetze/${engagementId}`, actorUserId: actor.userId });
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
 * Ein Sales-Hinweis wird als Signal (Beobachtung) im Projekt vorgeschlagen – der BD prüft wie gewohnt.
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
      // Schnellerfassung: „jetzt“ in Berliner Zeit (auch im Winter und kurz vor Mitternacht der richtige Tag)
      const quickNow = i.mood && !i.heldAt ? new Date() : null;
      if (quickNow) i.heldAt = `${todayIso(quickNow)}T${new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit", hour12: false }).format(quickNow)}`;
      if (i.mood && (!i.note || i.note.length < 5)) i.note = `Stimmung: ${moodLabel[i.mood]}${i.note ? ` – ${i.note}` : ""}`;
      if (!i.heldAt) throw new ValidationError("Bitte den tatsächlichen Gesprächstermin angeben.");
      if (!i.note || i.note.length < 5) throw new ValidationError("Bitte ein kurzes Ergebnis festhalten oder die Stimmung wählen.");
      patch.status = "ERLEDIGT";
      patch.heldAt = quickNow ?? new Date(`${i.heldAt}:00+02:00`);
      patch.participants = i.participants || c.participants;
      patch.note = i.mood && !i.note.startsWith("Stimmung:") ? `Stimmung: ${moodLabel[i.mood]} – ${i.note}` : i.note;
      patch.risks = i.risks || null;
      patch.openPoints = i.openPoints || null;
      patch.nextStep = i.nextStep || null;
      patch.salesHint = i.salesHint || null;
      next = plusDaysIso(i.heldAt.slice(0, 10), deadlines().checkinDays);
      break;
    }
    case "VERSCHIEBEN":
      if (!i.newDueDate) throw new ValidationError("Bitte das neue Datum angeben.");
      patch.status = "FAELLIG";
      patch.dueDate = i.newDueDate;
      patch.note = `${c.note ?? ""}\nVerschoben (${todayIso()})${i.reason ? `: ${i.reason}` : ""}`.trim();
      break;
    case "ABSAGEN":
      patch.status = "ABGESAGT";
      patch.note = `${c.note ?? ""}\nAbgesagt${i.reason ? `: ${i.reason}` : ""}`.trim();
      break;
  }
  if (i.action === "ERLEDIGEN" && i.heldAt && i.salesHint && i.salesHint.length >= 5) {
    const heldDay = i.heldAt.slice(0, 10);
    // Sales-Rückkopplung: Signalvorschlag im Projekt, erlaubte Verwendung = internes Gespräch; BD prüft Bezug und Dublette
    try {
      const sig = await captureObservation(actor, { setupId: a.engagement.setupId, observation: i.salesHint, relevanceHypothesis: `Aus Check-in (${c.side === "KUNDE" ? "Kunde" : "Freelancer"}) am ${heldDay} zum Einsatz „${a.engagement.title}“.`, usageLimit: "Intern aus Betreuungsgespräch – vor Verwendung beim Kunden mit der Betreuungsperson abstimmen.", sourceTitle: `Check-in ${a.engagement.title} ${heldDay}`, sourceAccessClass: "ACCOUNT_TEAM" });
      signalId = sig.signal.id;
    } catch {
      signalId = null; // z. B. Betreuungsperson ohne Projekt-Bearbeitungsrecht: Hinweis bleibt am Check-in, BD legt das Signal an
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
    // e44: geführt oder entfallen → die Fälligkeits-Hinweise zu den Check-ins dieses Einsatzes sind erledigt
    if (["ERLEDIGT", "ABGESAGT", "GEPLANT"].includes(u.status)) await resolveNotifications(tx, actor.workspaceId, `/einsaetze/${c.engagementId}#checkins`);
    // Folgetermin im 6-Wochen-Rhythmus – nur für Freelancer-Einsätze (Kunde und Freelancer), nicht für interne
    if (next && a.engagement.freelancerId && ["AKTIV", "GEPLANT", "ENDET"].includes(a.engagement.status)) {
      const side = c.side === "KUNDE" ? "KUNDE" : "FREELANCER";
      const owner = await careOwner(c.engagementId, side, a.engagement.bdUserId, tx);
      await tx.insert(schema.checkins).values({ workspaceId: actor.workspaceId, engagementId: c.engagementId, side, ownerUserId: owner, dueDate: next, ruleKey: `catchup:${c.engagementId}:${side === "KUNDE" ? "" : "FREELANCER:"}${next}`, createdBy: actor.userId }).onConflictDoNothing();
    }
    if (signalId) await notify(tx, { workspaceId: actor.workspaceId, userIds: [a.engagement.bdUserId], kind: "KOMMENTAR", title: `Sales-Hinweis aus Check-in (${await engagementLabel(db, a.engagement)}) – bitte prüfen`, link: `/setups/${a.engagement.setupId}`, actorUserId: actor.userId });
    if (i.salesHint && !signalId) await notify(tx, { workspaceId: actor.workspaceId, userIds: [a.engagement.bdUserId], kind: "KOMMENTAR", title: `Sales-Hinweis aus Check-in (${await engagementLabel(db, a.engagement)}): ${i.salesHint.slice(0, 100)}`, link: `/einsaetze/${c.engagementId}#checkins`, actorUserId: actor.userId });
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
      const computed = plusDaysIso(base, deadlines().checkinDays);
      const due = computed < todayIso() ? plusDaysIso(todayIso(), 7) : computed;
      const owner = await careOwner(e.id, side, e.bdUserId);
      const ins = await db.insert(schema.checkins).values({ workspaceId: e.workspaceId, engagementId: e.id, side, ownerUserId: owner, dueDate: due, ruleKey: `catchup:${e.id}:${side === "KUNDE" ? "" : "FREELANCER:"}${due}`, createdBy: e.bdUserId }).onConflictDoNothing().returning({ id: schema.checkins.id });
      n += ins.length;
    }
  }
  return n;
}

/** Fällige/überfällige Check-ins: je Check-in und Termin ein Hinweis bei Fälligkeit und einer bei Überfälligkeit (e44: nicht mehr täglich). */
export async function notifyDueCheckins(workspaceId?: string): Promise<number> {
  const t = todayIso();
  const rows = await db.query.checkins.findMany({ where: and(workspaceId ? eq(schema.checkins.workspaceId, workspaceId) : undefined, inArray(schema.checkins.status, ["FAELLIG", "ANGEFRAGT"])) });
  let n = 0;
  for (const c of rows.filter((c) => c.dueDate <= plusDaysIso(t, 7))) {
    const e = await db.query.engagements.findFirst({ where: eq(schema.engagements.id, c.engagementId) });
    if (!e) continue;
    const overdue = c.dueDate < t;
    n += await notify(db, { workspaceId: e.workspaceId, userIds: [c.ownerUserId], kind: overdue ? "UEBERFAELLIG" : "ZUGEWIESEN", title: `${overdue ? "Überfälliger" : "Fälliger"} Check-in (${c.side === "KUNDE" ? "Kunde" : "Freelancer"}) bis ${isoDe(c.dueDate)}: ${await engagementLabel(db, e)}`, link: `/einsaetze/${c.engagementId}#checkins`, dedupeKey: `checkin:${c.id}:${c.dueDate}:${overdue ? "ueberfaellig" : "faellig"}` });
  }
  return n;
}

export async function listMyCheckins(actor: Actor) {
  const rows = await db.query.checkins.findMany({ where: and(eq(schema.checkins.workspaceId, actor.workspaceId), eq(schema.checkins.ownerUserId, actor.userId), inArray(schema.checkins.status, ["FAELLIG", "ANGEFRAGT", "GEPLANT"])), orderBy: asc(schema.checkins.dueDate) });
  if (!rows.length) return [];
  const engs = await db.query.engagements.findMany({ where: inArray(schema.engagements.id, [...new Set(rows.map((r) => r.engagementId))]), columns: { id: true, title: true, accountId: true, freelancerId: true, internalUserId: true } });
  const [accounts, fls, users] = await Promise.all([
    db.query.accounts.findMany({ where: inArray(schema.accounts.id, [...new Set(engs.map((e) => e.accountId))]), columns: { id: true, name: true } }),
    db.query.freelancers.findMany({ where: inArray(schema.freelancers.id, [...new Set(engs.map((e) => e.freelancerId).filter((x): x is string => !!x)), "-"]), columns: { id: true, displayName: true } }),
    db.query.users.findMany({ where: inArray(schema.users.id, [...new Set(engs.map((e) => e.internalUserId).filter((x): x is string => !!x)), "-"]), columns: { id: true, displayName: true } }),
  ]);
  const en = new Map(engs.map((e) => [e.id, e]));
  const an = new Map(accounts.map((a) => [a.id, a.name]));
  const fn = new Map(fls.map((f) => [f.id, f.displayName]));
  const un = new Map(users.map((u) => [u.id, u.displayName]));
  const t = todayIso();
  return rows.map((r) => {
    const e = en.get(r.engagementId);
    return { ...r, engagementTitle: e?.title ?? "?", personName: e ? personLabel(e, fn, un) : "?", accountName: an.get(e?.accountId ?? "") ?? "?", overdue: r.dueDate < t };
  });
}

// ---------------------------------------------------------------------------
// Verlängerungsentscheidung
// ---------------------------------------------------------------------------

export const renewalInput = z.object({
  version: z.coerce.number().int().positive().optional(),
  status: z.enum(["ZU_KLAEREN", "MOEGLICH", "IN_ABSTIMMUNG", "ANGEBOTEN", "BESTAETIGT", "ABGELEHNT", "ERLEDIGT"]),
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
  // e49: Sales Operations und Backoffice führen die Verlängerung zu Ende (Angebot, Bestellung, Bestätigung); der BD gibt nur das Signal
  if (["BESTAETIGT", "ABGELEHNT"].includes(i.status) && !a.manage) throw new ForbiddenError("Bestätigen oder ablehnen dürfen Sales Operations, Backoffice, der verantwortliche BD, Principal oder CEO.");
  const current = await db.query.renewalDecisions.findFirst({ where: and(eq(schema.renewalDecisions.engagementId, engagementId), inArray(schema.renewalDecisions.status, ["ZU_KLAEREN", "MOEGLICH", "IN_ABSTIMMUNG", "ANGEBOTEN"])) });
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
      await notify(tx, { workspaceId: actor.workspaceId, userIds: cares.map((c) => c.userId), kind: "KOMMENTAR", title: `Verlängerung ${renewalStatusLabel[i.status]}: ${await engagementLabel(db, e)}`, link: `/einsaetze/${engagementId}#verlaengerung`, actorUserId: actor.userId });
    }
    return row!;
  });
}

// ---------------------------------------------------------------------------
// Verlängerung als Anstoß + Karte (Etappe 33, Use Case 1): Sales Operations/Betreuung stößt an, BD/Principal/CEO entscheidet
// mit einem Klick; das System schreibt Periode, Einsatzende, Auftragsende und das Projektende nach Moco.
// ---------------------------------------------------------------------------

export const RENEWAL_OPEN = ["ZU_KLAEREN", "MOEGLICH", "IN_ABSTIMMUNG", "ANGEBOTEN"] as const;

export const renewalStartInput = z.object({
  newEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Neues Ende als Datum angeben."),
  conditions: z.enum(["UNVERAENDERT", "NEU"]).default("UNVERAENDERT"),
  ek: opt(20),
  vk: opt(20),
  rateUnit: z.enum(["TAG", "STUNDE"]).optional(),
  note: opt(1000),
  /** neue Bestellnummer, falls sie schon vorliegt (e44) */
  orderReference: opt(200),
  /** e48e: Angebot zur Verlängerung – Datei aus SharePoint (Auswahl) und/oder Nummer aus Moco */
  offerPick: opt(400),
  offerNumber: opt(100),
});

async function latestPeriod(engagementId: string) {
  // e49c: abgelöste Perioden zählen nicht – sonst käme nach einer Korrektur wieder der alte Satz
  const { currentPeriod } = await import("./service");
  return currentPeriod(await db.query.engagementPeriods.findMany({ where: eq(schema.engagementPeriods.engagementId, engagementId) }));
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
export async function startRenewal(actor: Actor, engagementId: string, raw: unknown, opts: { /** wird im selben Zug bestätigt: keine Bitte um Bestätigung verschicken */ direct?: boolean } = {}) {
  const p = renewalStartInput.safeParse(raw);
  if (!p.success) throw new ValidationError(issues(p.error));
  const a = await requireEngagement(actor, engagementId);
  if (!(a.manage || a.care)) throw new ForbiddenError("Verlängerungen stoßen Sales Operations, Betreuung, BD, Principal oder CEO an.");
  const e = a.engagement;
  const i = p.data;
  if (!["AKTIV", "PAUSIERT", "GEPLANT", "ENDET"].includes(e.status)) throw new TransitionError("Verlängert wird ein laufender Einsatz.");
  const currentEnd = e.plannedEnd ?? todayIso();
  if (i.newEnd <= currentEnd) throw new ValidationError(`Das neue Ende muss nach dem heutigen Ende (${currentEnd}) liegen.`);
  // e49b: Ein eingetragener Satz gilt immer – auch wenn „unverändert“ gewählt blieb. Komma oder Punkt, höchstens zwei Nachkommastellen.
  for (const k of ["ek", "vk"] as const) {
    const v = (i[k] ?? "").trim().replace(/\s|€/g, "").replace(",", ".");
    if (v && !/^\d{1,7}(\.\d{1,2})?$/.test(v)) throw new ValidationError(`${k.toUpperCase()} bitte als Betrag angeben, z. B. 121,08.`);
    i[k] = v;
  }
  if (i.ek || i.vk) i.conditions = "NEU";
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
  // e48e: Angebot aus SharePoint als Unterlage am Einsatz verknüpfen; Nummer aus dem Dateinamen, wenn keine eingetragen ist
  let offerNumber = i.offerNumber || current?.offerNumber || null;
  let offerLink = current?.offerLink ?? null;
  if (i.offerPick) {
    const { linkSharePointFile, offerNumberFromName } = await import("@/modules/sharepoint/service");
    const doc = await linkSharePointFile(actor, engagementId, i.offerPick, { signedStatus: "VERSENDET", reference: i.offerNumber || "" });
    offerNumber = i.offerNumber || offerNumberFromName(doc.title.replace(/ /g, "_")) || offerNumberFromName(doc.link ?? "") || offerNumber;
    offerLink = doc.link;
    if (offerNumber && !doc.reference) await db.update(schema.contractDocuments).set({ reference: offerNumber }).where(eq(schema.contractDocuments.id, doc.id));
  }
  return db.transaction(async (tx) => {
    const values = { status: offerNumber || offerLink ? "ANGEBOTEN" : "IN_ABSTIMMUNG", offerNumber, offerLink, proposedFrom, proposedTo: i.newEnd, conditionsNote, orderReference: i.orderReference || current?.orderReference || null, availabilityNote: i.note || null, commercialOwnerUserId: e.bdUserId, triggerDate: current?.triggerDate ?? todayIso(), updatedAt: new Date() };
    let row;
    if (current) [row] = await tx.update(schema.renewalDecisions).set({ ...values, version: current.version + 1 }).where(eq(schema.renewalDecisions.id, current.id)).returning();
    else [row] = await tx.insert(schema.renewalDecisions).values({ workspaceId: actor.workspaceId, engagementId, ...values, createdBy: actor.userId }).returning();
    await recordAudit(tx, actor, "renewal.requested", "ENGAGEMENT", engagementId, { bis: i.newEnd, konditionen: conditionsNote });
    if (!opts.direct) await notify(tx, { workspaceId: actor.workspaceId, userIds: [e.bdUserId, ...principals], kind: "ZUGEWIESEN", title: `Verlängerung bestätigen: ${person} bei ${a.account.name} bis ${isoDe(i.newEnd)}`, link: `/einsaetze/${engagementId}#verlaengerung`, actorUserId: actor.userId, dedupeKey: `renewal-request:${row!.id}:${i.newEnd}` });
    return row!;
  });
}

export const renewalDecideInput = z.object({
  version: z.coerce.number().int().positive().optional(),
  decision: z.enum(["BESTAETIGEN", "ABLEHNEN", "WEITERGEBEN"]),
  contractFollowUp: opt(500),
  note: opt(1000),
  targetUserId: opt(100),
  /** neue Bestellnummer zur Verlängerung (e44) – geht an den Einsatz, den Auftrag und in die Übergabe ans Backoffice */
  orderReference: opt(200),
});

export type RenewalDecideResult = { decision: typeof schema.renewalDecisions.$inferSelect; mocoWritten: boolean; mocoError: string | null; pendingApproval?: boolean };

/**
 * Vier-Augen bei Account Leads (Etappe 45): Ist der Kunde einem Account Lead zugeordnet, bestätigt dort niemand außer der
 * Geschäftsführung eine Verlängerung mit geänderten Konditionen – sie geht zur Freigabe an die Geschäftsführung.
 * Unveränderte Konditionen bestätigt der Account Lead (bzw. BD) selbst.
 */
async function gfApprover(actor: Actor, accountId: string, conditionsNote: string | null): Promise<string | null> {
  if (hasRole(actor, "CEO")) return null;
  if (!(conditionsNote ?? "").startsWith("Neue Konditionen")) return null;
  const t = todayIso();
  const lead = (await db.query.roleAssignments.findMany({ where: and(eq(schema.roleAssignments.accountId, accountId), eq(schema.roleAssignments.role, "PRINCIPAL"), eq(schema.roleAssignments.scope, "ACCOUNT")) })).find((r) => !r.validTo || r.validTo >= t);
  if (!lead || lead.level !== "ACCOUNT_LEAD") return null;
  const ceo = (await db.query.roleAssignments.findMany({ where: and(eq(schema.roleAssignments.workspaceId, actor.workspaceId), eq(schema.roleAssignments.role, "CEO")) })).find((r) => !r.validTo || r.validTo >= t);
  return ceo?.userId ?? null;
}

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
      await notify(tx, { workspaceId: actor.workspaceId, userIds: [target.id], kind: "ZUGEWIESEN", title: `Verlängerung entscheiden: ${await engagementLabel(db, e)}${i.note ? ` – ${i.note.slice(0, 80)}` : ""}`, link: `/einsaetze/${engagementId}#verlaengerung`, actorUserId: actor.userId });
      return { decision: row!, mocoWritten: false, mocoError: null };
    });
  }
  if (!a.manage) throw new ForbiddenError("Bestätigen oder ablehnen dürfen Sales Operations, Backoffice, der verantwortliche BD, Principal oder CEO.");
  if (i.decision === "ABLEHNEN") {
    const row = await upsertRenewalDecision(actor, engagementId, { version: current.version, status: "ABGELEHNT", proposedFrom: current.proposedFrom ?? "", proposedTo: current.proposedTo ?? "", conditionsNote: current.conditionsNote ?? "", availabilityNote: `Abgelehnt von ${actor.displayName}${i.note ? `: ${i.note}` : ""}`, commercialOwnerUserId: actor.userId });
    await resolveNotifications(db, actor.workspaceId, `/einsaetze/${engagementId}#verlaengerung`);
    await notify(db, { workspaceId: actor.workspaceId, userIds: [requester], kind: "ABGELEHNT", title: `Verlängerung abgelehnt: ${await engagementLabel(db, e)}${i.note ? ` – ${i.note.slice(0, 80)}` : ""}`, link: `/einsaetze/${engagementId}#verlaengerung`, actorUserId: actor.userId });
    return { decision: row, mocoWritten: false, mocoError: null };
  }
  // BESTAETIGEN
  if (!current.proposedTo) throw new ValidationError("Für diese Verlängerung ist noch kein neues Ende vorgeschlagen – bitte zuerst anstoßen.");
  const approver = await gfApprover(actor, e.accountId, current.conditionsNote);
  if (approver && current.commercialOwnerUserId !== approver) {
    return db.transaction(async (tx) => {
      const [row] = await tx.update(schema.renewalDecisions).set({ commercialOwnerUserId: approver, availabilityNote: `${current.availabilityNote ? `${current.availabilityNote}\n` : ""}Zur Freigabe an die Geschäftsführung (geänderte Konditionen, Account-Lead-Kunde) – von ${actor.displayName}${i.note ? `: ${i.note}` : ""}`, version: current.version + 1, updatedAt: new Date() }).where(eq(schema.renewalDecisions.id, current.id)).returning();
      await recordAudit(tx, actor, "renewal.approval_requested", "ENGAGEMENT", engagementId, { an: approver });
      await notify(tx, { workspaceId: actor.workspaceId, userIds: [approver], kind: "ZUGEWIESEN", title: `Freigabe: Verlängerung mit neuen Konditionen – ${await engagementLabel(db, e)} bis ${current.proposedTo}`, link: `/einsaetze/${engagementId}#verlaengerung`, actorUserId: actor.userId });
      return { decision: row!, mocoWritten: false, mocoError: null, pendingApproval: true };
    });
  }
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
  // Neue Bestellnummer (e44): am Einsatz fortschreiben; der Auftrag behält die ursprüngliche Nummer als Historie
  const orderReference = i.orderReference || current.orderReference || "";
  if (orderReference) {
    await db.update(schema.engagements).set({ orderReference, updatedAt: new Date() }).where(eq(schema.engagements.id, engagementId));
    await db.update(schema.renewalDecisions).set({ orderReference }).where(eq(schema.renewalDecisions.id, current.id));
    await recordAudit(db, actor, "engagement.order_reference", "ENGAGEMENT", engagementId, { bestellnummer: orderReference, anlass: "Verlängerung" });
  }
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
      await notify(db, { workspaceId: actor.workspaceId, userIds: [...ops, requester, actor.userId], kind: "ZUGEWIESEN", title: `Projektende in Moco von Hand setzen: ${await engagementLabel(db, e)} bis ${current.proposedTo} (Schreibzugriff fehlgeschlagen)`, link: `/einsaetze/${engagementId}#verlaengerung`, dedupeKey: `moco-finish-manual:${engagementId}:${current.proposedTo}` });
    }
  }
  await resolveNotifications(db, actor.workspaceId, `/einsaetze/${engagementId}#verlaengerung`);
  await notify(db, { workspaceId: actor.workspaceId, userIds: [requester], kind: "ERLEDIGT", title: `Verlängerung bestätigt: ${await engagementLabel(db, e)} bis ${current.proposedTo}${mocoWritten ? " (Moco aktualisiert)" : ""}`, link: `/einsaetze/${engagementId}#verlaengerung`, actorUserId: actor.userId });
  // Übergabe ans Backoffice (Etappe 51): nur die Änderung
  {
    const { handoverForChange } = await import("@/modules/conversion/handover");
    await handoverForChange(actor, engagementId, "VERLAENGERT", `Verlängert bis ${current.proposedTo}. ${current.conditionsNote ?? "Konditionen unverändert"}.${orderReference ? ` Neue Bestellnummer: ${orderReference}.` : " Bestellnummer zur Verlängerung liegt noch nicht vor."}${mocoWritten ? " Das Projektende in Moco ist bereits gesetzt." : ""}${e.freelancerId ? ` Freelancer: ${i.contractFollowUp || "Nachtrag"} erzeugen (Einsatz › Vertrag erzeugen ist mit neuem Ende und Satz vorbelegt) und unterschrieben ablegen.` : ""}`);
  }
  // e48: Laufzeit und Bestellnummer an den Unterlagen in SharePoint nachführen
  try {
    const { syncEngagementDocs } = await import("@/modules/sharepoint/documents");
    await syncEngagementDocs(engagementId);
  } catch (err) {
    console.error("SharePoint nach Verlängerung", (err as Error).message);
  }
  return { decision: row, mocoWritten, mocoError };
}

/**
 * Bestätigte Verlängerung zurücknehmen (e49d), z. B. weil sie mit falschem Satz oder Datum bestätigt wurde:
 * Einsatz- und Auftragsende gehen auf den Stand davor zurück, die Perioden des verlängerten Zeitraums entfallen
 * (was sie abgelöst hatten, gilt wieder), Moco und SharePoint werden nachgeführt, die Verlängerung verschwindet.
 * Danach lässt sie sich sauber neu anlegen. Nur die jüngste Verlängerung, und nur solange der Einsatz läuft.
 */
export async function revertRenewal(actor: Actor, engagementId: string, renewalId: string, client?: MocoClient) {
  const a = await requireEngagement(actor, engagementId);
  if (!a.manage) throw new ForbiddenError("Eine Verlängerung nehmen Sales Operations, Backoffice, der verantwortliche BD, Principal oder CEO zurück.");
  const e = a.engagement;
  if (["ABGESCHLOSSEN", "ABGEBROCHEN"].includes(e.status)) throw new TransitionError("Der Einsatz ist beendet.");
  const all = await db.query.renewalDecisions.findMany({ where: eq(schema.renewalDecisions.engagementId, engagementId), orderBy: desc(schema.renewalDecisions.createdAt) });
  const r = all.find((x) => x.id === renewalId);
  if (!r) throw new NotFoundError("Verlängerung");
  if (r.status !== "BESTAETIGT") throw new ValidationError("Zurücknehmen lässt sich nur eine bestätigte Verlängerung.");
  const latest = all.filter((x) => x.status === "BESTAETIGT").sort((x, y) => (y.proposedTo ?? "").localeCompare(x.proposedTo ?? ""))[0];
  if (latest?.id !== r.id) throw new ValidationError("Bitte zuerst die jüngere Verlängerung zurücknehmen.");
  if (!r.proposedFrom || !r.proposedTo) throw new ValidationError("Dieser Verlängerung fehlt der Zeitraum – bitte das Ende am Einsatz von Hand korrigieren.");
  const prevEnd = plusDaysIso(r.proposedFrom, -1);
  await db.transaction(async (tx) => {
    await tx.update(schema.renewalDecisions).set({ resultPeriodId: null }).where(eq(schema.renewalDecisions.id, r.id));
    // Perioden, die erst mit dem verlängerten Zeitraum beginnen, entfallen; was sie abgelöst hatten, gilt wieder
    const periods = await tx.query.engagementPeriods.findMany({ where: eq(schema.engagementPeriods.engagementId, engagementId) });
    const gone = periods.filter((p) => p.validFrom >= r.proposedFrom! || p.id === r.resultPeriodId).map((p) => p.id);
    if (gone.length) {
      await tx.update(schema.renewalDecisions).set({ resultPeriodId: null }).where(inArray(schema.renewalDecisions.resultPeriodId, gone));
      await tx.update(schema.engagementPeriods).set({ supersededById: null }).where(and(eq(schema.engagementPeriods.engagementId, engagementId), inArray(schema.engagementPeriods.supersededById, gone)));
      await tx.delete(schema.engagementPeriods).where(inArray(schema.engagementPeriods.id, gone));
    }
    await tx.update(schema.engagements).set({ plannedEnd: prevEnd, version: e.version + 1, updatedAt: new Date() }).where(eq(schema.engagements.id, engagementId));
    if (e.orderId) await tx.update(schema.orders).set({ plannedEnd: prevEnd, updatedAt: new Date() }).where(eq(schema.orders.id, e.orderId));
    // offene Übergabe „verlängert“ ist damit gegenstandslos
    await tx.delete(schema.backofficeHandovers).where(and(eq(schema.backofficeHandovers.engagementId, engagementId), eq(schema.backofficeHandovers.kind, "VERLAENGERT"), eq(schema.backofficeHandovers.status, "OFFEN")));
    await tx.delete(schema.renewalDecisions).where(eq(schema.renewalDecisions.id, r.id));
    await recordAudit(tx, actor, "renewal.reverted", "ENGAGEMENT", engagementId, { zeitraum: `${r.proposedFrom} – ${r.proposedTo}`, konditionen: r.conditionsNote, endeWieder: prevEnd, perioden: gone.length });
  });
  let mocoWritten = false;
  if (e.mocoProjectId && (client || mocoEnabled())) {
    try {
      await (client ?? getMocoClient()).updateProjectFinishDate(e.mocoProjectId, prevEnd);
      mocoWritten = true;
    } catch {
      /* Hinweis geht unten an Sales Operations */
    }
  }
  try {
    const { syncEngagementDocs } = await import("@/modules/sharepoint/documents");
    await syncEngagementDocs(engagementId);
  } catch (err) {
    console.error("SharePoint nach Rücknahme", (err as Error).message);
  }
  const { backofficeUserIds } = await import("@/modules/conversion/profile");
  const recipients = [...new Set([...(await salesOpsUsers(actor.workspaceId)), ...(await backofficeUserIds(actor.workspaceId)), e.bdUserId])];
  await notify(db, { workspaceId: actor.workspaceId, userIds: recipients, kind: "KOMMENTAR", title: `Verlängerung zurückgenommen: ${await engagementLabel(db, e)} – Ende wieder ${prevEnd.split("-").reverse().join(".")}${e.mocoProjectId ? (mocoWritten ? " (Moco aktualisiert)" : " – Projektende in Moco bitte von Hand zurücksetzen") : ""}`, link: `/einsaetze/${engagementId}#verlaengerung`, actorUserId: actor.userId });
  return { prevEnd, mocoWritten };
}

export const renewalSignalInput = z.object({ signal: z.enum(["VERLAENGERN", "MOEGLICH", "ENDET"]), wishEnd: dateStr, note: opt(1000), followUp: dateStr });

/**
 * Signal des BD zur Verlängerung (e49): Der BD klärt mit dem Kunden nur das Ob – „Kunde will verlängern“ (gern mit
 * Wunschende) oder „endet“. Alles Weitere (Einkauf, Vermittler, Angebot, Bestellung, Vertrag, Bestätigung) machen
 * Sales Operations und Backoffice im Assignmentmanager; sie werden benachrichtigt.
 */
export async function signalRenewal(actor: Actor, engagementId: string, raw: unknown) {
  const p = renewalSignalInput.safeParse(raw);
  if (!p.success) throw new ValidationError(issues(p.error));
  const a = await requireEngagement(actor, engagementId);
  if (!(a.manage || a.care)) throw new ForbiddenError();
  const e = a.engagement;
  const i = p.data;
  if (!["AKTIV", "PAUSIERT", "GEPLANT", "ENDET"].includes(e.status)) throw new TransitionError("Das Signal gilt für einen laufenden Einsatz.");
  if (i.signal === "VERLAENGERN" && i.wishEnd && e.plannedEnd && i.wishEnd <= e.plannedEnd) throw new ValidationError("Das Wunschende muss nach dem heutigen Ende liegen.");
  const current = await db.query.renewalDecisions.findFirst({ where: and(eq(schema.renewalDecisions.engagementId, engagementId), inArray(schema.renewalDecisions.status, [...RENEWAL_OPEN])) });
  // e60: „möglich – noch zu früh“: festhalten, in der Zeitleiste zeigen, Wiedervorlage – aber noch keinen Prozess starten
  if (i.signal === "MOEGLICH") {
    if (i.wishEnd && e.plannedEnd && i.wishEnd <= e.plannedEnd) throw new ValidationError("Das Wunschende muss nach dem heutigen Ende liegen.");
    if (current && ["IN_ABSTIMMUNG", "ANGEBOTEN"].includes(current.status)) throw new TransitionError("Die Verlängerung ist schon in Umsetzung – „möglich“ passt nicht mehr.");
    const stampM = `${actor.displayName} am ${todayIso().split("-").reverse().join(".")}`;
    const lineM = `Verlängerung möglich${i.wishEnd ? ` bis ${i.wishEnd.split("-").reverse().join(".")}` : ""}, noch zu früh (${stampM})${i.note ? `: ${i.note}` : ""}`;
    const valuesM = { status: "MOEGLICH", proposedFrom: e.plannedEnd ? plusDaysIso(e.plannedEnd, 1) : null, proposedTo: i.wishEnd || current?.proposedTo || null, followUpDate: i.followUp || null, availabilityNote: `${current?.availabilityNote ? `${current.availabilityNote}\n` : ""}${lineM}`.slice(0, 4000), commercialOwnerUserId: e.bdUserId, triggerDate: current?.triggerDate ?? todayIso(), updatedAt: new Date() };
    return db.transaction(async (tx) => {
      let r;
      if (current) [r] = await tx.update(schema.renewalDecisions).set({ ...valuesM, version: current.version + 1 }).where(eq(schema.renewalDecisions.id, current.id)).returning();
      else [r] = await tx.insert(schema.renewalDecisions).values({ workspaceId: actor.workspaceId, engagementId, ...valuesM, createdBy: actor.userId }).returning();
      await recordAudit(tx, actor, "renewal.possible", "ENGAGEMENT", engagementId, { wunschende: i.wishEnd || null, wiedervorlage: i.followUp || null });
      return r!;
    });
  }
  const stamp = `${actor.displayName} am ${todayIso().split("-").reverse().join(".")}`;
  const line = i.signal === "VERLAENGERN" ? `Kunde will verlängern${i.wishEnd ? ` bis ${i.wishEnd.split("-").reverse().join(".")}` : ""} (${stamp})${i.note ? `: ${i.note}` : ""}` : `Kunde verlängert nicht (${stamp})${i.note ? `: ${i.note}` : ""}`;
  const values = {
    status: i.signal === "VERLAENGERN" ? "IN_ABSTIMMUNG" : "ABGELEHNT",
    proposedFrom: i.signal === "VERLAENGERN" && e.plannedEnd ? plusDaysIso(e.plannedEnd, 1) : current?.proposedFrom ?? null,
    proposedTo: i.signal === "VERLAENGERN" ? i.wishEnd || current?.proposedTo || null : current?.proposedTo ?? null,
    conditionsNote: current?.conditionsNote ?? (i.signal === "VERLAENGERN" ? "Konditionen unverändert" : null),
    availabilityNote: `${current?.availabilityNote ? `${current.availabilityNote}\n` : ""}${line}`.slice(0, 4000),
    commercialOwnerUserId: e.bdUserId,
    triggerDate: current?.triggerDate ?? todayIso(),
    followUpDate: null,
    ...(i.signal === "ENDET" ? { decidedBy: actor.userId, decidedAt: new Date() } : {}),
    updatedAt: new Date(),
  };
  const row = await db.transaction(async (tx) => {
    let r;
    if (current) [r] = await tx.update(schema.renewalDecisions).set({ ...values, version: current.version + 1 }).where(eq(schema.renewalDecisions.id, current.id)).returning();
    else [r] = await tx.insert(schema.renewalDecisions).values({ workspaceId: actor.workspaceId, engagementId, ...values, createdBy: actor.userId }).returning();
    await recordAudit(tx, actor, "renewal.signal", "ENGAGEMENT", engagementId, { signal: i.signal, wunschende: i.wishEnd || null });
    return r!;
  });
  await resolveNotifications(db, actor.workspaceId, `/einsaetze/${engagementId}#verlaengerung`);
  const { backofficeUserIds } = await import("@/modules/conversion/profile");
  const recipients = [...new Set([...(await salesOpsUsers(actor.workspaceId)), ...(await backofficeUserIds(actor.workspaceId))])];
  await notify(db, { workspaceId: actor.workspaceId, userIds: recipients, kind: "ZUGEWIESEN", title: `${i.signal === "VERLAENGERN" ? "Verlängerung umsetzen" : "Einsatz endet"}: ${await engagementLabel(db, e)} – ${line.slice(0, 160)}`, link: `/einsaetze/${engagementId}#verlaengerung`, actorUserId: actor.userId, dedupeKey: `renewal-signal:${row.id}:${row.version}` });
  return row;
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
  /** zuständiger BD des Einsatzes */
  bdUserId: string | null;
  bdName: string | null;
  /** Hut (Etappe 37): gehört die Karte in meine persönliche Arbeitsliste? Sonst nur „Bei deinen BDs im Blick“. */
  forMe: boolean;
  /** über wen beim Kunden, wer spricht an (e37) */
  contacts: import("./contacts").RenewalContacts;
  /** darf ich selbst bestätigen (BD-Kontext, Principal, CEO)? Dann geht Anstoßen und Bestätigen in einem Schritt (e44) */
  canDecide: boolean;
  /** schon hinterlegte neue Bestellnummer */
  orderReference: string | null;
  /** e60: Wiedervorlage einer möglichen Verlängerung */
  followUpDate: string | null;
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
  const { loadRenewalContacts } = await import("./contacts");
  const contacts = await loadRenewalContacts(engs);
  const out: RenewalCard[] = [];
  for (const d of open) {
    const e = en.get(d.engagementId);
    if (!e || !["AKTIV", "PAUSIERT", "GEPLANT", "ENDET"].includes(e.status)) continue;
    const a = await engagementAccess(actor, e);
    if (!a) continue;
    const inDecision = !["ZU_KLAEREN", "MOEGLICH"].includes(d.status) && !!d.proposedTo;
    let mode: RenewalCard["mode"] | null = null;
    if (d.status === "MOEGLICH") {
      // e60: erst zur Wiedervorlage (bzw. 4 Wochen vor Ende) wieder als Anstoß – nur für BD/kommerziell, nicht für Sales Ops
      const daysLeft = e.plannedEnd ? Math.round((new Date(e.plannedEnd).getTime() - new Date(t).getTime()) / 86400000) : 999;
      const due = (d.followUpDate && d.followUpDate <= t) || daysLeft <= 28;
      if (due && (a.commercial || a.manage)) mode = "ANSTOSSEN";
    } else if (inDecision && a.manage) mode = "ENTSCHEIDEN";
    else if (!inDecision && (a.ops || a.care || a.commercial)) mode = "ANSTOSSEN";
    if (!mode) continue;
    const delegates: RenewalCard["delegates"] = [];
    if (mode === "ENTSCHEIDEN") {
      const principals = await principalsFor(actor.workspaceId, e.accountId);
      for (const id of new Set([e.bdUserId, ...principals])) if (id !== actor.userId && un.has(id)) delegates.push({ id, name: un.get(id)! });
    }
    // Persönlich: an mich weitergegeben, mein Einsatz als BD, kein BD hinterlegt (dann entscheiden Principal/CEO) oder Anstoß als Ops/Betreuung
    const owner = d.commercialOwnerUserId;
    const forMe = owner ? owner === actor.userId : !e.bdUserId || e.bdUserId === actor.userId || (mode === "ANSTOSSEN" && (a.ops || a.care));
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
      bdUserId: e.bdUserId,
      bdName: e.bdUserId ? un.get(e.bdUserId) ?? null : null,
      forMe,
      contacts: contacts.get(e.id) ?? { renewal: null, order: null, approach: null, source: null },
      canDecide: !!a.manage,
      orderReference: d.orderReference,
      followUpDate: d.followUpDate ?? null,
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
      await notify(tx, { workspaceId: e.workspaceId, userIds: [e.bdUserId, ...cares.map((c) => c.userId)], kind: "ZUGEWIESEN", title: `Verlängerung klären: ${await engagementLabel(db, e)} endet am ${e.plannedEnd ?? e.renewalDeadline}`, link: `/einsaetze/${e.id}#verlaengerung`, dedupeKey: `renewal:engagement:${e.id}` });
    });
    n++;
  }
  return n;
}

/** e60: Wiedervorlage einer möglichen Verlängerung – Erinnerung an den BD am Tag der Wiedervorlage (einmal je Datum). */
export async function remindPossibleRenewals(): Promise<number> {
  const t = todayIso();
  const due = await db.query.renewalDecisions.findMany({ where: and(eq(schema.renewalDecisions.status, "MOEGLICH")) });
  let n = 0;
  for (const d of due.filter((x) => x.followUpDate && x.followUpDate <= t)) {
    const e = await db.query.engagements.findFirst({ where: eq(schema.engagements.id, d.engagementId) });
    if (!e || !["AKTIV", "PAUSIERT", "GEPLANT", "ENDET"].includes(e.status)) continue;
    await notify(db, { workspaceId: d.workspaceId, userIds: [d.commercialOwnerUserId ?? e.bdUserId], kind: "ZUGEWIESEN", title: `Wiedervorlage Verlängerung: ${await engagementLabel(db, e)}${d.proposedTo ? ` (möglich bis ${d.proposedTo.split("-").reverse().join(".")})` : ""} – jetzt umsetzen, verschieben oder endet?`, link: `/einsaetze/${e.id}#verlaengerung`, dedupeKey: `renewal-followup:${d.id}:${d.followUpDate}` });
    n++;
  }
  return n;
}
