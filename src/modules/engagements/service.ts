import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { db, schema, type Tx } from "@/db/client";
import { ConflictError, ForbiddenError, NotFoundError, TransitionError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/identity/actor";
import { notify } from "@/modules/notifications/service";
import { todayIso } from "@/modules/work/calendar";
import { renewalPingDate, renewalTriggerDate } from "@/modules/health/service";
import { engagementAccess, requireEngagement, requireManagedEngagement, type EngagementRow } from "./authz";

/**
 * Einsatzakte (Etappe 29, E2): entsteht idempotent aus der bestätigten Auswahl, führt Status, Perioden (Plan/bestätigt),
 * Vertrags-/Beschaffungsunterlagen gegen ein Beschaffungsprofil, Betreuung, Check-ins und Verlängerungsentscheidung.
 * Keine Stundenzettel, keine Abrechnung. `orders` bleibt der Beleg der Bestellung und wird optional verknüpft.
 */

export const engagementStatusValues = ["VORBEREITUNG", "GEPLANT", "AKTIV", "PAUSIERT", "ENDET", "ABGESCHLOSSEN", "ABGEBROCHEN"] as const;
export type EngStatus = (typeof engagementStatusValues)[number];
export const engagementStatusLabel: Record<string, string> = { VORBEREITUNG: "in Vorbereitung", GEPLANT: "geplant", AKTIV: "aktiv", PAUSIERT: "pausiert", ENDET: "endet", ABGESCHLOSSEN: "abgeschlossen", ABGEBROCHEN: "abgebrochen" };
const ENG_TRANSITIONS: Record<EngStatus, EngStatus[]> = {
  VORBEREITUNG: ["GEPLANT", "AKTIV", "ABGEBROCHEN"],
  GEPLANT: ["AKTIV", "VORBEREITUNG", "ABGEBROCHEN"],
  AKTIV: ["PAUSIERT", "ENDET", "ABGEBROCHEN"],
  PAUSIERT: ["AKTIV", "ENDET", "ABGEBROCHEN"],
  ENDET: ["ABGESCHLOSSEN", "AKTIV"],
  ABGESCHLOSSEN: [],
  ABGEBROCHEN: [],
};
export function assertEngagementTransition(from: string, to: EngStatus) {
  if (!(ENG_TRANSITIONS[from as EngStatus] ?? []).includes(to)) throw new TransitionError(`Einsatz: Übergang von „${engagementStatusLabel[from] ?? from}“ nach „${engagementStatusLabel[to]}“ ist nicht vorgesehen.`);
}

export const docSideLabel: Record<string, string> = { KUNDE: "Kunde ↔ Verve", FREELANCER: "Verve ↔ Freelancer" };
export const docTypeValues = ["RAHMENVERTRAG", "EINZELBEAUFTRAGUNG", "BESTELLUNG", "NACHTRAG", "NDA", "KUENDIGUNG", "SONSTIGES"] as const;
export const docTypeLabel: Record<string, string> = { RAHMENVERTRAG: "Rahmenvertrag", EINZELBEAUFTRAGUNG: "Einzelbeauftragung", BESTELLUNG: "Bestellung", NACHTRAG: "Nachtrag", NDA: "NDA", KUENDIGUNG: "Kündigung", SONSTIGES: "Sonstiges" };
export const signedStatusLabel: Record<string, string> = { ENTWURF: "Entwurf", VERSENDET: "versendet", UNTERSCHRIEBEN: "unterschrieben", GEKUENDIGT: "gekündigt" };
export const careRoleLabel: Record<string, string> = { CUSTOMER_CARE: "Kundenbetreuung", FREELANCER_CARE: "Freelancer-Betreuung" };

const issues = (e: z.ZodError) => e.issues.map((i) => i.message).join("; ");
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum als JJJJ-MM-TT").optional().or(z.literal(""));
const money = z.string().trim().regex(/^\d{1,7}([.,]\d{1,2})?$/, "Betrag mit höchstens zwei Nachkommastellen").transform((v) => v.replace(",", ".")).optional().or(z.literal(""));
const opt = (max: number) => z.string().trim().max(max).optional().or(z.literal(""));
const nul = (v: string | undefined) => (v ? v : null);

// ---------------------------------------------------------------------------
// Anlage aus der Auswahl (idempotent)
// ---------------------------------------------------------------------------

/** Wird in derselben Transaktion wie die Auswahlbestätigung aufgerufen. Erneuter Aufruf liefert den bestehenden Einsatz. */
export async function ensureEngagementForSelection(tx: Tx, actor: Actor, candidacyId: string): Promise<EngagementRow> {
  const existing = await tx.query.engagements.findFirst({ where: eq(schema.engagements.candidacyId, candidacyId) });
  if (existing) return existing;
  const c = await tx.query.candidacies.findFirst({ where: eq(schema.candidacies.id, candidacyId) });
  if (!c) throw new NotFoundError("Kandidatur");
  const p = await tx.query.staffingPositions.findFirst({ where: eq(schema.staffingPositions.id, c.positionId) });
  if (!p) throw new NotFoundError("Position");
  const personName = c.freelancerId
    ? (await tx.query.freelancers.findFirst({ where: eq(schema.freelancers.id, c.freelancerId), columns: { displayName: true } }))?.displayName ?? "Freelancer"
    : c.internalUserId
      ? (await tx.query.users.findFirst({ where: eq(schema.users.id, c.internalUserId), columns: { displayName: true } }))?.displayName ?? "intern"
      : "?";
  const [e] = await tx
    .insert(schema.engagements)
    .values({
      workspaceId: p.workspaceId,
      positionId: p.id,
      candidacyId: c.id,
      freelancerId: c.freelancerId,
      internalUserId: c.internalUserId,
      opportunityId: p.opportunityId,
      accountId: p.accountId,
      setupId: p.setupId,
      title: `${p.title} – ${personName}`.slice(0, 200),
      plannedStart: p.desiredStart ?? c.availableFrom ?? null,
      plannedEnd: p.endOpen ? null : p.plannedEnd ?? c.availableTo ?? null,
      bdUserId: p.bdUserId,
      createdBy: actor.userId,
    })
    .onConflictDoNothing()
    .returning();
  const row = e ?? (await tx.query.engagements.findFirst({ where: eq(schema.engagements.candidacyId, candidacyId) }))!;
  if (e) {
    // Plan-Periode aus Kandidatur/Position – als Plan gekennzeichnet, nicht bestätigt
    await tx.insert(schema.engagementPeriods).values({
      workspaceId: p.workspaceId,
      engagementId: e.id,
      kind: "PLAN",
      validFrom: e.plannedStart ?? todayIso(),
      validTo: e.plannedEnd,
      ek: c.ekRate,
      vk: c.vkRate ?? p.vkMin,
      currency: c.currency,
      rateUnit: c.rateUnit,
      scopeAmount: p.scopeAmount,
      scopeUnit: p.scopeUnit,
      source: "Auswahl (Kandidatur/Position)",
      createdBy: actor.userId,
    });
    // Der BD betreut den Kunden standardmäßig selbst (F04), bis eine Übergabe angenommen ist
    await tx.insert(schema.careAssignments).values({ workspaceId: p.workspaceId, engagementId: e.id, role: "CUSTOMER_CARE", userId: p.bdUserId, fromDate: todayIso(), acceptedAt: new Date(), grantedBy: actor.userId }).onConflictDoNothing();
    await recordAudit(tx, actor, "engagement.created", "ENGAGEMENT", e.id, { position: p.id, kandidatur: c.id });
  }
  return row;
}

// ---------------------------------------------------------------------------
// Stammdaten, Status
// ---------------------------------------------------------------------------

export const engagementInput = z.object({
  version: z.coerce.number().int().positive(),
  title: z.string().trim().min(3).max(200),
  plannedStart: dateStr,
  plannedEnd: dateStr,
  renewalDeadline: dateStr,
  noticeNote: opt(500),
  externalRef: opt(500),
  orderId: opt(100),
  bdUserId: opt(100),
});

export async function updateEngagement(actor: Actor, id: string, raw: unknown) {
  const p = engagementInput.safeParse(raw);
  if (!p.success) throw new ValidationError(issues(p.error));
  const a = await requireManagedEngagement(actor, id);
  const i = p.data;
  if (i.orderId) {
    const o = await db.query.orders.findFirst({ where: and(eq(schema.orders.id, i.orderId), eq(schema.orders.opportunityId, a.engagement.opportunityId)) });
    if (!o) throw new ValidationError("Der Auftrag gehört nicht zur Chance dieses Einsatzes.");
  }
  if (i.bdUserId && i.bdUserId !== a.engagement.bdUserId) {
    const { assertCanCarryResponsibility } = await import("@/modules/identity/authz");
    await assertCanCarryResponsibility(i.bdUserId);
  }
  return db.transaction(async (tx) => {
    const [u] = await tx
      .update(schema.engagements)
      .set({ title: i.title, plannedStart: nul(i.plannedStart), plannedEnd: nul(i.plannedEnd), renewalDeadline: nul(i.renewalDeadline), noticeNote: nul(i.noticeNote), externalRef: nul(i.externalRef), orderId: nul(i.orderId), bdUserId: i.bdUserId || a.engagement.bdUserId, version: i.version + 1, updatedAt: new Date() })
      .where(and(eq(schema.engagements.id, id), eq(schema.engagements.version, i.version)))
      .returning();
    if (!u) throw new ConflictError();
    await recordAudit(tx, actor, "engagement.updated", "ENGAGEMENT", id, { ende: u.plannedEnd, frist: u.renewalDeadline });
    return u;
  });
}

export type ProcurementCheck = { profile: boolean; required: { side: string; docType: string; ok: boolean }[]; complete: boolean | null; exception: string | null };

/** Vertragslage gegen das Beschaffungsprofil des Kunden; ohne Profil: unbestimmt (kein „grün“). */
export async function procurementCheck(e: EngagementRow): Promise<ProcurementCheck> {
  const prof = await db.query.procurementProfiles.findFirst({ where: eq(schema.procurementProfiles.accountId, e.accountId) });
  const links = await db.query.engagementDocuments.findMany({ where: eq(schema.engagementDocuments.engagementId, e.id) });
  const docs = links.length ? await db.query.contractDocuments.findMany({ where: inArray(schema.contractDocuments.id, links.map((l) => l.documentId)) }) : [];
  // Interne Besetzung: Freelancer-seitige Unterlagen (Rahmenvertrag, Einzelbeauftragung) entfallen
  const required = ((prof?.required as { side: string; docType: string }[] | undefined) ?? []).filter((r) => e.freelancerId || r.side !== "FREELANCER").map((r) => ({ ...r, ok: docs.some((d) => d.side === r.side && d.docType === r.docType && d.signedStatus === "UNTERSCHRIEBEN") }));
  return { profile: !!prof && !!prof.approvedAt, required, complete: prof && prof.approvedAt ? required.every((r) => r.ok) : null, exception: e.procurementException };
}

export const engagementStatusInput = z.object({
  version: z.coerce.number().int().positive(),
  status: z.enum(engagementStatusValues),
  reason: opt(2000),
  reviewDate: dateStr,
  actualDate: dateStr,
  /** Ausnahme vom Beschaffungscheck (nur manage) */
  exception: opt(1000),
});

export async function changeEngagementStatus(actor: Actor, id: string, raw: unknown) {
  const p = engagementStatusInput.safeParse(raw);
  if (!p.success) throw new ValidationError(issues(p.error));
  const a = await requireEngagement(actor, id);
  const i = p.data;
  const e = a.engagement;
  assertEngagementTransition(e.status, i.status);
  if (!a.manage) throw new ForbiddenError("Den Einsatzstatus setzt der verantwortliche BD, Principal oder CEO.");
  const patch: Partial<typeof schema.engagements.$inferInsert> = { status: i.status, statusReason: i.reason || null, reviewDate: null };
  if (i.status === "GEPLANT" || (i.status === "AKTIV" && e.status === "VORBEREITUNG")) {
    // Kundenbetreuung ist Mindestbedingung (steht standardmäßig beim BD). Die Vertragslage blockiert NICHT mehr –
    // sie bleibt als Hinweis sichtbar (Ampel am Einsatz und in der Liste); eine Ausnahme kann optional begründet werden.
    const care = await db.query.careAssignments.findFirst({ where: and(eq(schema.careAssignments.engagementId, e.id), eq(schema.careAssignments.role, "CUSTOMER_CARE"), isNull(schema.careAssignments.toDate)) });
    if (!care) throw new ValidationError("Bitte zuerst die Kundenbetreuung zuordnen (Abschnitt „Betreuung“).");
    if (i.exception && i.exception.length >= 5) {
      patch.procurementException = i.exception;
      patch.procurementExceptionBy = actor.userId;
      patch.procurementExceptionAt = new Date();
    }
  }
  if (i.status === "AKTIV" && e.status !== "PAUSIERT" && e.status !== "ENDET") {
    if (!i.actualDate) throw new ValidationError("Bitte das tatsächliche Startdatum bestätigen.");
    if (i.actualDate > todayIso()) throw new ValidationError("Der Start kann erst bestätigt werden, wenn das Datum erreicht ist.");
    patch.actualStart = i.actualDate;
  }
  if (i.status === "PAUSIERT" && (!i.reason || !i.reviewDate)) throw new ValidationError("Pause braucht Grund und Prüftermin.");
  if (i.status === "PAUSIERT") patch.reviewDate = i.reviewDate || null;
  if (i.status === "ENDET") {
    if (!i.actualDate) throw new ValidationError("Bitte das bestätigte Enddatum angeben.");
    patch.actualEnd = i.actualDate;
  }
  if (i.status === "ABGESCHLOSSEN") {
    const openRenewal = await db.query.renewalDecisions.findFirst({ where: and(eq(schema.renewalDecisions.engagementId, e.id), inArray(schema.renewalDecisions.status, ["ZU_KLAEREN", "IN_ABSTIMMUNG", "ANGEBOTEN"])) });
    if (openRenewal) throw new ValidationError("Die Verlängerungsentscheidung ist noch offen – erst entscheiden (bestätigt/abgelehnt/erledigt).");
    const openRisks = await db.query.checkins.findMany({ where: and(eq(schema.checkins.engagementId, e.id), inArray(schema.checkins.status, ["FAELLIG", "ANGEFRAGT", "GEPLANT"])) });
    if (openRisks.length && !i.reason) throw new ValidationError(`${openRisks.length} offene Check-in(s) – bitte abschließen oder im Grund festhalten, warum sie entfallen.`);
  }
  if (i.status === "ABGEBROCHEN" && !i.reason) throw new ValidationError("Bitte den Grund festhalten.");
  return db.transaction(async (tx) => {
    const [u] = await tx
      .update(schema.engagements)
      .set({ ...patch, version: i.version + 1, updatedAt: new Date() })
      .where(and(eq(schema.engagements.id, id), eq(schema.engagements.version, i.version)))
      .returning();
    if (!u) throw new ConflictError();
    await recordAudit(tx, actor, "engagement.status", "ENGAGEMENT", id, { von: e.status, nach: i.status, grund: i.reason || null, ausnahme: patch.procurementException ?? null });
    if (["PAUSIERT", "ENDET", "ABGESCHLOSSEN", "ABGEBROCHEN"].includes(i.status)) {
      // Routine-Check-ins beenden; vertragliche Fristen und offene Zusagen bleiben
      const open = await tx.query.checkins.findMany({ where: and(eq(schema.checkins.engagementId, e.id), eq(schema.checkins.status, "FAELLIG"), isNull(schema.checkins.heldAt)) });
      for (const c of open) await tx.update(schema.checkins).set({ status: "ABGESAGT", note: `${c.note ?? ""}\nEntfallen: Einsatz ${engagementStatusLabel[i.status]}${i.reason ? ` (${i.reason})` : ""}`.trim(), version: c.version + 1, updatedAt: new Date() }).where(eq(schema.checkins.id, c.id));
    }
    const cares = await tx.query.careAssignments.findMany({ where: and(eq(schema.careAssignments.engagementId, e.id), isNull(schema.careAssignments.toDate)) });
    await notify(tx, { workspaceId: actor.workspaceId, userIds: [e.bdUserId, ...cares.map((c) => c.userId)], kind: "KOMMENTAR", title: `Einsatz „${e.title}“: ${engagementStatusLabel[i.status]}`, link: `/einsaetze/${e.id}`, actorUserId: actor.userId });
    return u;
  });
}

// ---------------------------------------------------------------------------
// Perioden
// ---------------------------------------------------------------------------

export const periodInput = z.object({
  kind: z.enum(["PLAN", "BESTAETIGT"]).default("PLAN"),
  validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Gültig ab fehlt"),
  validTo: dateStr,
  ek: money,
  vk: money,
  rateUnit: z.enum(["TAG", "STUNDE"]).default("TAG"),
  scopeAmount: z.coerce.number().int().min(0).max(1000).optional().or(z.literal("")),
  scopeUnit: z.enum(["TAGE_PRO_WOCHE", "STUNDEN_PRO_WOCHE", "PROZENT", ""]).optional(),
  source: opt(300),
  note: opt(1000),
  /** abgelöste Periode (Satzänderung/Verlängerung) */
  supersedesId: opt(100),
  /** ausdrückliche Korrektur einer überlappenden bestätigten Periode */
  correction: z.union([z.boolean(), z.enum(["true", "on"])]).optional(),
});

export async function addPeriod(actor: Actor, engagementId: string, raw: unknown, tx0?: Tx) {
  const p = periodInput.safeParse(raw);
  if (!p.success) throw new ValidationError(issues(p.error));
  const a = await requireManagedEngagement(actor, engagementId);
  const i = p.data;
  if (i.validTo && i.validTo < i.validFrom) throw new ValidationError("„Gültig bis“ liegt vor „gültig ab“.");
  const run = async (tx: Tx) => {
    if (i.kind === "BESTAETIGT") {
      const confirmed = await tx.query.engagementPeriods.findMany({ where: and(eq(schema.engagementPeriods.engagementId, engagementId), eq(schema.engagementPeriods.kind, "BESTAETIGT"), isNull(schema.engagementPeriods.supersededById)) });
      const overlap = confirmed.filter((c) => c.id !== i.supersedesId && (c.validTo ?? "9999-12-31") >= i.validFrom && (i.validTo ?? "9999-12-31") >= c.validFrom);
      if (overlap.length && !(i.correction === true || i.correction === "true" || i.correction === "on")) throw new ValidationError("Die bestätigte Periode überlappt eine bestehende bestätigte Periode. Entweder die alte als abgelöst angeben oder ausdrücklich als Korrektur kennzeichnen.");
    }
    const [row] = await tx
      .insert(schema.engagementPeriods)
      .values({ workspaceId: actor.workspaceId, engagementId, kind: i.kind, validFrom: i.validFrom, validTo: nul(i.validTo), ek: nul(i.ek), vk: nul(i.vk), rateUnit: i.rateUnit, scopeAmount: i.scopeAmount === "" || i.scopeAmount === undefined ? null : i.scopeAmount, scopeUnit: i.scopeUnit || null, source: nul(i.source), note: nul(i.note), confirmedBy: i.kind === "BESTAETIGT" ? actor.userId : null, confirmedAt: i.kind === "BESTAETIGT" ? new Date() : null, createdBy: actor.userId })
      .returning();
    if (i.supersedesId) {
      const prev = await tx.query.engagementPeriods.findFirst({ where: and(eq(schema.engagementPeriods.id, i.supersedesId), eq(schema.engagementPeriods.engagementId, engagementId)) });
      if (!prev) throw new ValidationError("Abgelöste Periode nicht gefunden.");
      await tx.update(schema.engagementPeriods).set({ supersededById: row!.id }).where(eq(schema.engagementPeriods.id, prev.id));
    }
    await recordAudit(tx, actor, "engagement.period_added", "ENGAGEMENT", engagementId, { art: i.kind, von: i.validFrom, bis: i.validTo || null, abgeloest: i.supersedesId || null });
    void a;
    return row!;
  };
  return tx0 ? run(tx0) : db.transaction(run);
}

// ---------------------------------------------------------------------------
// Beschaffungsprofil und Unterlagen
// ---------------------------------------------------------------------------

export const profileInput = z.object({
  version: z.coerce.number().int().min(0).optional(),
  note: opt(1000),
  approve: z.union([z.boolean(), z.enum(["true", "on"])]).optional(),
});

/** Profil pflegen: Felder `req_<SIDE>_<TYPE>=on`. Freigabe durch Principal/CEO/zuständigen BD (Entwicklungsdefault, Abschnitt 16). */
export async function saveProcurementProfile(actor: Actor, accountId: string, raw: Record<string, unknown>) {
  const p = profileInput.safeParse(raw);
  if (!p.success) throw new ValidationError(issues(p.error));
  const { getAccount } = await import("@/modules/accounts/service");
  const account = await getAccount(actor, accountId);
  const { isStaffingManager } = await import("@/modules/staffing/authz");
  if (!isStaffingManager(actor, account, null)) throw new ForbiddenError("Das Beschaffungsprofil pflegen zuständiger BD, Principal oder CEO.");
  const required: { side: string; docType: string }[] = [];
  for (const side of ["KUNDE", "FREELANCER"]) for (const t of docTypeValues) if (raw[`req_${side}_${t}`] === "on" || raw[`req_${side}_${t}`] === "true") required.push({ side, docType: t });
  const approve = p.data.approve === true || p.data.approve === "true" || p.data.approve === "on";
  await db.transaction(async (tx) => {
    await tx
      .insert(schema.procurementProfiles)
      .values({ accountId, workspaceId: actor.workspaceId, required, note: nul(p.data.note), approvedBy: approve ? actor.userId : null, approvedAt: approve ? new Date() : null })
      .onConflictDoUpdate({ target: schema.procurementProfiles.accountId, set: { required, note: nul(p.data.note), approvedBy: approve ? actor.userId : null, approvedAt: approve ? new Date() : null, updatedAt: new Date() } });
    await recordAudit(tx, actor, approve ? "procurement_profile.approved" : "procurement_profile.saved", "ACCOUNT", accountId, { anzahl: required.length });
  });
}

export const contractDocInput = z.object({
  side: z.enum(["KUNDE", "FREELANCER"]),
  docType: z.enum(docTypeValues),
  title: z.string().trim().min(2).max(200),
  versionLabel: opt(50),
  validFrom: dateStr,
  validTo: dateStr,
  signedStatus: z.enum(["ENTWURF", "VERSENDET", "UNTERSCHRIEBEN", "GEKUENDIGT"]).default("ENTWURF"),
  link: opt(500),
  reference: opt(200),
  reviewNote: opt(1000),
  sourceId: opt(100),
});

/** Dokumenttyp-Vorschlag aus extrahiertem Text (regelbasiert) – mit Belegstelle, nie automatisch übernommen. */
export function suggestDocType(text: string): { docType: (typeof docTypeValues)[number]; evidence: string } | null {
  const rules: [RegExp, (typeof docTypeValues)[number]][] = [
    [/rahmenvertrag|rahmenvereinbarung|master services agreement/i, "RAHMENVERTRAG"],
    [/\bnachtrag|änderungsvereinbarung|amendment\b/i, "NACHTRAG"],
    [/kündigung|kuendigung|termination/i, "KUENDIGUNG"],
    [/geheimhaltung|vertraulichkeitsvereinbarung|non-disclosure|\bnda\b/i, "NDA"],
    [/bestellung|bestellnummer|purchase order|\bpo[-\s]?nr/i, "BESTELLUNG"],
    [/einzelbeauftragung|einzelauftrag|leistungsschein|statement of work|\bsow\b|beauftragung/i, "EINZELBEAUFTRAGUNG"],
  ];
  for (const [re, t] of rules) {
    const m = re.exec(text);
    if (m) {
      const start = Math.max(0, m.index - 60);
      return { docType: t, evidence: text.slice(start, m.index + m[0].length + 60).replace(/\s+/g, " ").trim() };
    }
  }
  return null;
}

/** Unterlage anlegen (optional mit hochgeladenem Dokument) und mit dem Einsatz verknüpfen. */
export async function addContractDocument(actor: Actor, engagementId: string, raw: unknown, file: { name: string; type: string; size: number; arrayBuffer: () => Promise<ArrayBuffer> } | null) {
  const p = contractDocInput.safeParse(raw);
  if (!p.success) throw new ValidationError(issues(p.error));
  const a = await requireEngagement(actor, engagementId);
  if (!(a.manage || a.care)) throw new ForbiddenError();
  const i = p.data;
  let sourceId: string | null = i.sourceId || null;
  let suggestion: { docType: string; evidence: string; extractStatus: string; note: string | null } | null = null;
  if (file && file.size > 0) {
    const { uploadDocument } = await import("@/modules/documents/service");
    const up = await uploadDocument(actor, { setupId: a.engagement.setupId, title: i.title, accessClass: "ACCOUNT_TEAM" }, file);
    sourceId = up.sourceId;
    const sug = up.extract.status === "OK" || up.extract.status === "TEILWEISE" ? suggestDocType(up.extract.text) : null;
    suggestion = { docType: sug?.docType ?? "", evidence: sug?.evidence ?? "", extractStatus: up.extract.status, note: up.extract.status === "LEER" ? "Scan erkannt – nicht ausgewertet. Typ und Angaben bitte manuell prüfen." : up.extract.note };
  }
  if (i.signedStatus === "UNTERSCHRIEBEN" && !sourceId && !i.link) throw new ValidationError("„Unterschrieben“ braucht einen Beleg: Datei oder Link zum führenden Ablageort.");
  return db.transaction(async (tx) => {
    const [d] = await tx
      .insert(schema.contractDocuments)
      .values({ workspaceId: actor.workspaceId, accountId: a.engagement.accountId, side: i.side, docType: i.docType, title: i.title, versionLabel: nul(i.versionLabel), validFrom: nul(i.validFrom), validTo: nul(i.validTo), signedStatus: i.signedStatus, sourceId, link: nul(i.link), reference: nul(i.reference), freelancerId: i.side === "FREELANCER" ? a.engagement.freelancerId : null, reviewNote: nul(i.reviewNote), reviewedBy: a.manage ? actor.userId : null, reviewedAt: a.manage ? new Date() : null, suggestion, createdBy: actor.userId })
      .returning();
    await tx.insert(schema.engagementDocuments).values({ engagementId, documentId: d!.id }).onConflictDoNothing();
    await recordAudit(tx, actor, "contract_document.added", "ENGAGEMENT", engagementId, { typ: i.docType, seite: i.side, status: i.signedStatus, vorschlag: suggestion?.docType ?? null });
    return { document: d!, suggestion };
  });
}

export const docStatusInput = z.object({
  version: z.coerce.number().int().positive(),
  signedStatus: z.enum(["ENTWURF", "VERSENDET", "UNTERSCHRIEBEN", "GEKUENDIGT"]),
  reviewNote: opt(1000),
  link: opt(500),
  /** Korrektur von Seite/Typ (z. B. „Bestellung“ war eigentlich die Einzelbeauftragung) */
  side: z.enum(["KUNDE", "FREELANCER", ""]).optional(),
  docType: z.enum([...docTypeValues, ""]).optional(),
});

export async function setContractDocumentStatus(actor: Actor, engagementId: string, documentId: string, raw: unknown) {
  const p = docStatusInput.safeParse(raw);
  if (!p.success) throw new ValidationError(issues(p.error));
  const a = await requireEngagement(actor, engagementId);
  if (!a.manage) throw new ForbiddenError("Den Vertragsstatus setzt der verantwortliche BD, Principal oder CEO.");
  const d = await db.query.contractDocuments.findFirst({ where: and(eq(schema.contractDocuments.id, documentId), eq(schema.contractDocuments.workspaceId, actor.workspaceId)) });
  if (!d) throw new NotFoundError("Unterlage");
  if (p.data.signedStatus === "UNTERSCHRIEBEN" && !d.sourceId && !d.link && !p.data.link) throw new ValidationError("„Unterschrieben“ braucht einen Beleg: Datei oder Link.");
  return db.transaction(async (tx) => {
    const [u] = await tx
      .update(schema.contractDocuments)
      .set({ signedStatus: p.data.signedStatus, side: p.data.side || d.side, docType: p.data.docType || d.docType, freelancerId: (p.data.side || d.side) === "FREELANCER" ? (d.freelancerId ?? a.engagement.freelancerId) : null, reviewNote: p.data.reviewNote || d.reviewNote, link: p.data.link || d.link, reviewedBy: actor.userId, reviewedAt: new Date(), version: p.data.version + 1, updatedAt: new Date() })
      .where(and(eq(schema.contractDocuments.id, documentId), eq(schema.contractDocuments.version, p.data.version)))
      .returning();
    if (!u) throw new ConflictError();
    await recordAudit(tx, actor, "contract_document.status", "ENGAGEMENT", engagementId, { dokument: documentId, status: p.data.signedStatus });
    return u;
  });
}

/** Bestehende Unterlage des Kunden (z. B. Rahmenvertrag) an einen weiteren Einsatz hängen. */
export async function linkContractDocument(actor: Actor, engagementId: string, documentId: string) {
  const a = await requireEngagement(actor, engagementId);
  if (!(a.manage || a.care)) throw new ForbiddenError();
  const d = await db.query.contractDocuments.findFirst({ where: and(eq(schema.contractDocuments.id, documentId), eq(schema.contractDocuments.accountId, a.engagement.accountId)) });
  if (!d) throw new NotFoundError("Unterlage");
  await db.transaction(async (tx) => {
    await tx.insert(schema.engagementDocuments).values({ engagementId, documentId }).onConflictDoNothing();
    await recordAudit(tx, actor, "contract_document.linked", "ENGAGEMENT", engagementId, { dokument: documentId });
  });
}

// ---------------------------------------------------------------------------
// Listen und Detail
// ---------------------------------------------------------------------------

export type EngagementView = EngagementRow & { accountName: string; freelancerName: string; bdName: string; careNames: string[]; daysToEnd: number | null; nextCheckin: string | null; checkinOverdue: boolean; procurement: ProcurementCheck; renewalStatus: string | null; pingDate: string | null; triggerDate: string | null };

async function decorate(actor: Actor, rows: EngagementRow[]): Promise<EngagementView[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [accounts, fls, users, cares, cis, rens] = await Promise.all([
    db.query.accounts.findMany({ where: inArray(schema.accounts.id, [...new Set(rows.map((r) => r.accountId))]), columns: { id: true, name: true } }),
    db.query.freelancers.findMany({ where: inArray(schema.freelancers.id, [...new Set(rows.map((r) => r.freelancerId).filter((x): x is string => !!x)), "-"]), columns: { id: true, displayName: true } }),
    db.query.users.findMany({ where: eq(schema.users.workspaceId, actor.workspaceId), columns: { id: true, displayName: true } }),
    db.query.careAssignments.findMany({ where: and(inArray(schema.careAssignments.engagementId, ids), isNull(schema.careAssignments.toDate)) }),
    db.query.checkins.findMany({ where: and(inArray(schema.checkins.engagementId, ids), inArray(schema.checkins.status, ["FAELLIG", "ANGEFRAGT", "GEPLANT"])) }),
    db.query.renewalDecisions.findMany({ where: inArray(schema.renewalDecisions.engagementId, ids), orderBy: desc(schema.renewalDecisions.createdAt) }),
  ]);
  const an = new Map(accounts.map((a) => [a.id, a.name]));
  const fn = new Map(fls.map((f) => [f.id, f.displayName]));
  const un = new Map(users.map((u) => [u.id, u.displayName]));
  const t = todayIso();
  const out: EngagementView[] = [];
  for (const r of rows) {
    const next = cis.filter((c) => c.engagementId === r.id).map((c) => c.dueDate).sort()[0] ?? null;
    out.push({
      ...r,
      accountName: an.get(r.accountId) ?? "?",
      freelancerName: r.freelancerId ? fn.get(r.freelancerId) ?? "?" : r.internalUserId ? `${un.get(r.internalUserId) ?? "?"} (intern)` : "?",
      bdName: un.get(r.bdUserId) ?? "?",
      careNames: cares.filter((c) => c.engagementId === r.id).map((c) => `${un.get(c.userId) ?? "?"} (${careRoleLabel[c.role] ?? c.role})`),
      daysToEnd: r.plannedEnd ? Math.round((new Date(r.plannedEnd).getTime() - new Date(t).getTime()) / 86400000) : null,
      nextCheckin: next,
      checkinOverdue: !!next && next < t,
      procurement: await procurementCheck(r),
      renewalStatus: rens.find((x) => x.engagementId === r.id)?.status ?? null,
      pingDate: renewalPingDate(r),
      triggerDate: renewalTriggerDate(r),
    });
  }
  return out;
}

export const engagementFilterValues = ["alle", "aktiv", "vertrag_offen", "enden_30", "enden_60", "enden_90", "checkin_ueberfaellig", "betreuung", "abgeschlossen"] as const;
export type EngagementFilter = (typeof engagementFilterValues)[number];

export async function listEngagements(actor: Actor, filter: EngagementFilter = "alle") {
  const rows = await db.query.engagements.findMany({ where: eq(schema.engagements.workspaceId, actor.workspaceId), orderBy: [asc(schema.engagements.plannedEnd), desc(schema.engagements.createdAt)] });
  const visible: EngagementRow[] = [];
  const mine = new Set<string>();
  for (const r of rows) {
    const a = await engagementAccess(actor, r);
    if (!a) continue;
    visible.push(r);
    if (a.care) mine.add(r.id);
  }
  const v = await decorate(actor, visible);
  const active = (x: EngagementView) => ["GEPLANT", "AKTIV", "PAUSIERT", "ENDET", "VORBEREITUNG"].includes(x.status);
  const counts = {
    alle: v.length,
    aktiv: v.filter((x) => x.status === "AKTIV").length,
    vertrag_offen: v.filter((x) => active(x) && x.procurement.complete !== true && !x.procurementException).length,
    enden_30: v.filter((x) => active(x) && x.daysToEnd !== null && x.daysToEnd <= 30).length,
    enden_60: v.filter((x) => active(x) && x.daysToEnd !== null && x.daysToEnd <= 60).length,
    enden_90: v.filter((x) => active(x) && x.daysToEnd !== null && x.daysToEnd <= 90).length,
    checkin_ueberfaellig: v.filter((x) => x.checkinOverdue).length,
    betreuung: v.filter((x) => mine.has(x.id)).length,
    abgeschlossen: v.filter((x) => ["ABGESCHLOSSEN", "ABGEBROCHEN"].includes(x.status)).length,
  };
  const items =
    filter === "aktiv" ? v.filter((x) => x.status === "AKTIV")
    : filter === "vertrag_offen" ? v.filter((x) => active(x) && x.procurement.complete !== true && !x.procurementException)
    : filter === "enden_30" ? v.filter((x) => active(x) && x.daysToEnd !== null && x.daysToEnd <= 30)
    : filter === "enden_60" ? v.filter((x) => active(x) && x.daysToEnd !== null && x.daysToEnd <= 60)
    : filter === "enden_90" ? v.filter((x) => active(x) && x.daysToEnd !== null && x.daysToEnd <= 90)
    : filter === "checkin_ueberfaellig" ? v.filter((x) => x.checkinOverdue)
    : filter === "betreuung" ? v.filter((x) => mine.has(x.id))
    : filter === "abgeschlossen" ? v.filter((x) => ["ABGESCHLOSSEN", "ABGEBROCHEN"].includes(x.status))
    : v;
  return { items, counts };
}

export async function getEngagementDetail(actor: Actor, id: string) {
  const a = await requireEngagement(actor, id);
  const [view] = await decorate(actor, [a.engagement]);
  const e = a.engagement;
  const [periods, cares, docsLinks, checkinsRows, renewals, users, persons, orders, accountDocs, position, candidacy] = await Promise.all([
    db.query.engagementPeriods.findMany({ where: eq(schema.engagementPeriods.engagementId, id), orderBy: [asc(schema.engagementPeriods.validFrom), asc(schema.engagementPeriods.createdAt)] }),
    db.query.careAssignments.findMany({ where: eq(schema.careAssignments.engagementId, id), orderBy: asc(schema.careAssignments.createdAt) }),
    db.query.engagementDocuments.findMany({ where: eq(schema.engagementDocuments.engagementId, id) }),
    db.query.checkins.findMany({ where: eq(schema.checkins.engagementId, id), orderBy: [desc(schema.checkins.dueDate)] }),
    db.query.renewalDecisions.findMany({ where: eq(schema.renewalDecisions.engagementId, id), orderBy: desc(schema.renewalDecisions.createdAt) }),
    db.query.users.findMany({ where: and(eq(schema.users.workspaceId, actor.workspaceId), eq(schema.users.status, "ACTIVE")), columns: { id: true, displayName: true } }),
    db.query.persons.findMany({ where: eq(schema.persons.accountId, e.accountId), columns: { id: true, displayName: true } }),
    db.query.orders.findMany({ where: eq(schema.orders.opportunityId, e.opportunityId), columns: { id: true, orderReference: true, status: true, plannedEnd: true } }),
    db.query.contractDocuments.findMany({ where: eq(schema.contractDocuments.accountId, e.accountId), orderBy: desc(schema.contractDocuments.createdAt) }),
    db.query.staffingPositions.findFirst({ where: eq(schema.staffingPositions.id, e.positionId), columns: { id: true, title: true, status: true } }),
    db.query.candidacies.findFirst({ where: eq(schema.candidacies.id, e.candidacyId), columns: { id: true, status: true } }),
  ]);
  const un = new Map(users.map((u) => [u.id, u.displayName]));
  const linked = new Set(docsLinks.map((l) => l.documentId));
  const history = await db.query.auditEvents.findMany({ where: and(eq(schema.auditEvents.objectType, "ENGAGEMENT"), eq(schema.auditEvents.objectId, id)), orderBy: asc(schema.auditEvents.at) });
  const profile = await db.query.procurementProfiles.findFirst({ where: eq(schema.procurementProfiles.accountId, e.accountId) });
  const freelancer = e.freelancerId ? await db.query.freelancers.findFirst({ where: eq(schema.freelancers.id, e.freelancerId) }) : null;
  return {
    access: a,
    view: view!,
    freelancer,
    position,
    candidacy,
    periods: periods.map((p) => ({ ...p, confirmedName: p.confirmedBy ? un.get(p.confirmedBy) ?? "?" : null, current: !p.supersededById && (p.validTo ?? "9999") >= todayIso() })),
    cares: cares.map((c) => ({ ...c, name: un.get(c.userId) ?? "?", grantedName: un.get(c.grantedBy) ?? "?" })),
    documents: accountDocs.filter((d) => linked.has(d.id)),
    otherAccountDocuments: accountDocs.filter((d) => !linked.has(d.id)),
    checkins: checkinsRows.map((c) => ({ ...c, ownerName: un.get(c.ownerUserId) ?? "?" })),
    renewals: renewals.map((r) => ({ ...r, ownerName: r.commercialOwnerUserId ? un.get(r.commercialOwnerUserId) ?? "?" : null })),
    users: users.map((u) => ({ id: u.id, name: u.displayName })),
    persons,
    orders,
    profile,
    history: history.map((h) => ({ at: h.at, who: h.actorUserId ? un.get(h.actorUserId) ?? "?" : "System", action: h.action, changes: h.changes as Record<string, unknown> | null })),
  };
}

