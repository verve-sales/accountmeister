import { and, desc, eq, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db/client";
import { ForbiddenError, NotFoundError, TransitionError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import { hasRole, type Actor } from "@/modules/identity/actor";
import { notify, resolveNotifications } from "@/modules/notifications/service";
import { backofficeUserIds, isBackoffice } from "./profile";

/**
 * Übergabe ans Backoffice (Etappe 51). Führend ist dieser Vorgang mit allen Angaben; die Benachrichtigung (in der App,
 * per Mail wenn der Versand eingeschaltet ist) ist nur der Hinweis darauf – ohne Konditionen.
 * Das Backoffice quittiert mit dem Moco-Projekt: So steht die Projektnummer am Einsatz, ohne dass sie jemand an
 * anderer Stelle tippt, und der Moco-Abgleich legt keinen zweiten Einsatz an.
 */

export const handoverKindValues = ["VORLAEUFIG", "BEAUFTRAGT", "BESTELLUNG_NACHGEREICHT", "VERLAENGERT", "KONDITIONEN", "BEENDET"] as const;
export type HandoverKind = (typeof handoverKindValues)[number];
export const handoverKindLabel: Record<string, string> = {
  VORLAEUFIG: "Vorläufig beauftragt (Start mit Zusage per Mail)",
  BEAUFTRAGT: "Beauftragt",
  BESTELLUNG_NACHGEREICHT: "Bestellung nachgereicht",
  VERLAENGERT: "Verlängert",
  KONDITIONEN: "Konditionen geändert",
  BEENDET: "Beendet",
};
/** Was das Backoffice in Moco zu tun hat – der Betreff der Übergabe. */
export const handoverTask: Record<string, string> = {
  VORLAEUFIG: "Projekt in Moco anlegen (Bestellung folgt)",
  BEAUFTRAGT: "Angebot in Moco in ein Projekt umwandeln",
  BESTELLUNG_NACHGEREICHT: "Bestellnummer am Moco-Projekt nachtragen",
  VERLAENGERT: "Laufzeit und Satz am Moco-Projekt anpassen",
  KONDITIONEN: "Satz bzw. Kontingent am Moco-Projekt anpassen",
  BEENDET: "Moco-Projekt abschließen",
};

export type HandoverRow = typeof schema.backofficeHandovers.$inferSelect;
export type HandoverPayload = {
  kunde: string;
  setup: string;
  person: string;
  personArt: "FREELANCER" | "INTERN";
  rolle: string;
  beginn: string | null;
  ende: string | null;
  bestellnummer: string | null;
  bestellungLink: string | null;
  angebotsnummer: string | null;
  angebotLink: string | null;
  vk: string | null;
  vkEinheit: string | null;
  kontingent: string | null;
  beschaffungsweg: string;
  vermittler: string | null;
  rechnungshinweis: string | null;
  /** e48: Rechnungsanschrift und Rechnungsweg des Kunden */
  rechnungsanschrift?: string | null;
  rechnungsweg?: string | null;
  /** e48: Zahlungsziel des Freelancers in Tagen (nur Berechtigten) */
  zahlungszielTage?: number | null;
  /** nur bei Freelancern; wird nur Berechtigten gezeigt */
  ek: string | null;
  ekEinheit: string | null;
  freelancerRechnungsdaten: string | null;
  unterlagen: { titel: string; typ: string; status: string; link: string | null }[];
  hinweis: string | null;
};

async function salesOpsUserIds(workspaceId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: schema.roleAssignments.userId })
    .from(schema.roleAssignments)
    .innerJoin(schema.users, eq(schema.users.id, schema.roleAssignments.userId))
    .where(and(eq(schema.users.workspaceId, workspaceId), eq(schema.users.status, "ACTIVE"), eq(schema.roleAssignments.role, "SALES_OPS")));
  return [...new Set(rows.map((r) => r.userId))];
}

async function buildPayload(engagementId: string, conversionId: string | null, hinweis: string | null): Promise<HandoverPayload> {
  const e = await db.query.engagements.findFirst({ where: eq(schema.engagements.id, engagementId) });
  if (!e) throw new NotFoundError("Einsatz");
  const [account, setup, position, freelancer, internal, periods, order, conv, links] = await Promise.all([
    db.query.accounts.findFirst({ where: eq(schema.accounts.id, e.accountId) }),
    db.query.projectSetups.findFirst({ where: eq(schema.projectSetups.id, e.setupId), columns: { name: true } }),
    db.query.staffingPositions.findFirst({ where: eq(schema.staffingPositions.id, e.positionId) }),
    e.freelancerId ? db.query.freelancers.findFirst({ where: eq(schema.freelancers.id, e.freelancerId) }) : Promise.resolve(null),
    e.internalUserId ? db.query.users.findFirst({ where: eq(schema.users.id, e.internalUserId), columns: { displayName: true } }) : Promise.resolve(null),
    db.query.engagementPeriods.findMany({ where: and(eq(schema.engagementPeriods.engagementId, e.id), isNull(schema.engagementPeriods.supersededById)), orderBy: desc(schema.engagementPeriods.validFrom) }),
    e.orderId ? db.query.orders.findFirst({ where: eq(schema.orders.id, e.orderId) }) : Promise.resolve(null),
    // ohne ausdrücklichen Vorgang: der Vorgang dieser Position (e43), nicht irgendeiner der Chance
    conversionId ? db.query.conversions.findFirst({ where: eq(schema.conversions.id, conversionId) }) : db.query.conversions.findFirst({ where: and(eq(schema.conversions.opportunityId, e.opportunityId), eq(schema.conversions.positionId, e.positionId)), orderBy: desc(schema.conversions.createdAt) }),
    db.query.engagementDocuments.findMany({ where: eq(schema.engagementDocuments.engagementId, e.id) }),
  ]);
  // e48e: Angebot der jüngsten Verlängerung geht vor dem ursprünglichen Angebot aus dem Vorgang
  const renewalOffer = await db.query.renewalDecisions.findFirst({ where: and(eq(schema.renewalDecisions.engagementId, e.id), isNotNull(schema.renewalDecisions.offerNumber)), orderBy: desc(schema.renewalDecisions.createdAt) });
  const docs = links.length ? await db.query.contractDocuments.findMany({ where: inArray(schema.contractDocuments.id, links.map((l) => l.documentId)) }) : [];
  const p = periods[0] ?? null;
  return {
    kunde: account?.name ?? "?",
    setup: setup?.name ?? "?",
    person: freelancer?.displayName ?? internal?.displayName ?? "?",
    personArt: e.freelancerId ? "FREELANCER" : "INTERN",
    rolle: position?.title ?? e.title,
    beginn: e.actualStart ?? e.plannedStart,
    ende: e.actualEnd ?? e.plannedEnd,
    // die aktuelle Nummer am Einsatz (nach einer Verlängerung) geht vor
    bestellnummer: e.orderReference ?? conv?.orderReference ?? order?.orderReference ?? null,
    bestellungLink: conv?.orderLink ?? order?.contractLink ?? null,
    angebotsnummer: renewalOffer?.offerNumber ?? (conv?.offerNumber ? `${conv.offerNumber}${conv.offerVersion > 1 ? ` (Fassung ${conv.offerVersion})` : ""}` : null),
    angebotLink: renewalOffer?.offerLink ?? conv?.offerLink ?? null,
    vk: p?.vk ?? null,
    vkEinheit: p?.rateUnit ?? null,
    kontingent: p?.scopeAmount ? `${p.scopeAmount} ${p.scopeUnit ?? ""}`.trim() : null,
    beschaffungsweg: account?.procurementChannel ?? "DIREKT",
    vermittler: account?.intermediaryName ?? null,
    rechnungshinweis: account?.procurementNote ?? null,
    rechnungsanschrift: account?.billingAddress ?? null,
    rechnungsweg: account?.invoiceRoute ?? null,
    zahlungszielTage: e.freelancerId ? freelancer?.paymentTermDays ?? null : null,
    ek: e.freelancerId ? p?.ek ?? freelancer?.ekRate ?? null : null,
    ekEinheit: e.freelancerId ? (p?.ek ? p.rateUnit : freelancer?.ekUnit ?? null) : null,
    freelancerRechnungsdaten: freelancer?.invoiceNote ?? null,
    unterlagen: docs.map((d) => ({ titel: d.title, typ: d.docType, status: d.signedStatus, link: d.link })),
    hinweis,
  };
}

/** Übergabe anlegen und Backoffice sowie Sales Operations benachrichtigen. Eine offene Übergabe derselben Art wird aktualisiert statt verdoppelt. */
export async function createHandover(actor: Actor, engagementId: string, kind: HandoverKind, opts: { conversionId?: string | null; hinweis?: string | null } = {}): Promise<HandoverRow> {
  const e = await db.query.engagements.findFirst({ where: and(eq(schema.engagements.id, engagementId), eq(schema.engagements.workspaceId, actor.workspaceId)) });
  if (!e) throw new NotFoundError("Einsatz");
  const payload = await buildPayload(e.id, opts.conversionId ?? null, opts.hinweis ?? null);
  const open = await db.query.backofficeHandovers.findFirst({ where: and(eq(schema.backofficeHandovers.engagementId, e.id), eq(schema.backofficeHandovers.kind, kind), eq(schema.backofficeHandovers.status, "OFFEN")) });
  let row: HandoverRow;
  if (open) {
    [row] = (await db.update(schema.backofficeHandovers).set({ payload }).where(eq(schema.backofficeHandovers.id, open.id)).returning()) as [HandoverRow];
  } else {
    [row] = (await db.insert(schema.backofficeHandovers).values({ workspaceId: actor.workspaceId, engagementId: e.id, conversionId: opts.conversionId ?? null, kind, payload, createdBy: actor.userId }).returning()) as [HandoverRow];
  }
  await recordAudit(db, actor, "handover.created", "ENGAGEMENT", e.id, { art: kind, uebergabe: row.id });
  const recipients = [...new Set([...(await backofficeUserIds(actor.workspaceId)), ...(await salesOpsUserIds(actor.workspaceId))])];
  await notify(db, { workspaceId: actor.workspaceId, userIds: recipients, kind: "ZUGEWIESEN", title: `Übergabe ans Backoffice: ${handoverTask[kind]} – ${payload.person} bei ${payload.kunde}`, link: `/uebergaben/${row.id}`, actorUserId: actor.userId, dedupeKey: `handover:${row.id}:${open ? Date.now() : "neu"}` });
  return row;
}

/** Backoffice, Sales Operations und Geschäftsführung bearbeiten Übergaben. */
export async function mayHandle(actor: Actor): Promise<boolean> {
  return hasRole(actor, "CEO") || actor.roles.has("SALES_OPS") || (await isBackoffice(actor));
}

async function mayView(actor: Actor, h: HandoverRow): Promise<{ full: boolean } | null> {
  if (h.workspaceId !== actor.workspaceId) return null;
  if (await mayHandle(actor)) return { full: true };
  const e = await db.query.engagements.findFirst({ where: eq(schema.engagements.id, h.engagementId), columns: { bdUserId: true } });
  if (h.createdBy === actor.userId || e?.bdUserId === actor.userId) return { full: e?.bdUserId === actor.userId };
  return null;
}

export type HandoverView = { handover: HandoverRow; payload: HandoverPayload; canAck: boolean; showConditions: boolean; createdByName: string; ackByName: string | null; mocoProjects: { id: number; label: string }[] };

export async function getHandover(actor: Actor, id: string): Promise<HandoverView> {
  const h = await db.query.backofficeHandovers.findFirst({ where: eq(schema.backofficeHandovers.id, id) });
  const v = h ? await mayView(actor, h) : null;
  if (!h || !v) throw new NotFoundError("Übergabe");
  const users = await db.query.users.findMany({ where: inArray(schema.users.id, [h.createdBy, h.ackBy ?? "-"]), columns: { id: true, displayName: true } });
  const payload = h.payload as unknown as HandoverPayload;
  // Abgleichsliste: neue Moco-Projekte, die noch keinem Einsatz zugeordnet sind
  const hints = await db.query.mocoHints.findMany({ where: and(eq(schema.mocoHints.workspaceId, actor.workspaceId), eq(schema.mocoHints.kind, "NEUES_PROJEKT"), eq(schema.mocoHints.status, "OFFEN")), orderBy: desc(schema.mocoHints.createdAt), limit: 50 });
  const mocoProjects = hints
    .map((x) => ({ id: Number((x.payload as { mocoProjectId?: number }).mocoProjectId), label: x.title.replace(/ ist in Moco neu.*$/, "") }))
    .filter((x) => Number.isFinite(x.id));
  if (v.full) await recordAudit(db, actor, "handover.viewed", "ENGAGEMENT", h.engagementId, { uebergabe: h.id });
  return {
    handover: h,
    payload: v.full ? payload : { ...payload, ek: null, ekEinheit: null, freelancerRechnungsdaten: null, zahlungszielTage: null },
    canAck: h.status === "OFFEN" && (await mayHandle(actor)),
    showConditions: v.full,
    createdByName: users.find((u) => u.id === h.createdBy)?.displayName ?? "?",
    ackByName: h.ackBy ? users.find((u) => u.id === h.ackBy)?.displayName ?? "?" : null,
    mocoProjects,
  };
}

export async function listHandovers(actor: Actor, filter: "offen" | "alle" = "offen") {
  if (!(await mayHandle(actor))) throw new ForbiddenError("Übergaben bearbeiten Backoffice, Sales Operations und Geschäftsführung.");
  const rows = await db.query.backofficeHandovers.findMany({ where: and(eq(schema.backofficeHandovers.workspaceId, actor.workspaceId), filter === "offen" ? eq(schema.backofficeHandovers.status, "OFFEN") : undefined), orderBy: desc(schema.backofficeHandovers.createdAt), limit: 200 });
  return rows.map((h) => {
    const p = h.payload as unknown as HandoverPayload;
    return { id: h.id, kind: h.kind, status: h.status, createdAt: h.createdAt, ackAt: h.ackAt, person: p.person, kunde: p.kunde, bestellnummer: p.bestellnummer, mocoProjectId: h.mocoProjectId };
  });
}

export async function openHandoverCount(actor: Actor): Promise<number> {
  if (!(await mayHandle(actor))) return 0;
  return (await db.query.backofficeHandovers.findMany({ where: and(eq(schema.backofficeHandovers.workspaceId, actor.workspaceId), eq(schema.backofficeHandovers.status, "OFFEN")), columns: { id: true } })).length;
}

const ackInput = z.object({ mocoProjectId: z.string().trim().regex(/^\d{0,12}$/, "Moco-Projekt-ID ist eine Zahl").optional().default(""), note: z.string().trim().max(1000).optional().default("") });

/**
 * Quittieren. Bei „beauftragt“ und „vorläufig beauftragt“ gehört das Moco-Projekt dazu: Es wird am Einsatz eingetragen,
 * die Zuweisung der Person – wenn Moco erreichbar ist – gleich mit, und der Hinweis „neues Projekt“ ist damit erledigt.
 */
export async function acknowledgeHandover(actor: Actor, id: string, raw: unknown) {
  const p = ackInput.safeParse(raw);
  if (!p.success) throw new ValidationError(p.error.issues.map((i) => i.message).join("; "));
  if (!(await mayHandle(actor))) throw new ForbiddenError("Übergaben quittieren Backoffice, Sales Operations und Geschäftsführung.");
  const h = await db.query.backofficeHandovers.findFirst({ where: and(eq(schema.backofficeHandovers.id, id), eq(schema.backofficeHandovers.workspaceId, actor.workspaceId)) });
  if (!h) throw new NotFoundError("Übergabe");
  if (h.status !== "OFFEN") throw new TransitionError("Diese Übergabe ist bereits quittiert.");
  const e = (await db.query.engagements.findFirst({ where: eq(schema.engagements.id, h.engagementId) }))!;
  const needsProject = ["BEAUFTRAGT", "VORLAEUFIG"].includes(h.kind) && !e.mocoProjectId;
  const mocoProjectId = p.data.mocoProjectId ? Number(p.data.mocoProjectId) : e.mocoProjectId ?? null;
  if (needsProject && !mocoProjectId) throw new ValidationError("Bitte das Moco-Projekt auswählen oder seine ID eintragen – damit steht die Projektnummer am Einsatz.");
  if (mocoProjectId && mocoProjectId !== e.mocoProjectId) {
    const taken = await db.query.engagements.findFirst({ where: and(eq(schema.engagements.workspaceId, actor.workspaceId), eq(schema.engagements.mocoProjectId, mocoProjectId), eq(schema.engagements.positionId, e.positionId)), columns: { id: true } });
    if (taken && taken.id !== e.id) throw new ValidationError("Dieses Moco-Projekt hängt bereits an einem anderen Einsatz derselben Position.");
  }
  let mocoContractId: number | null = e.mocoContractId;
  if (mocoProjectId && !mocoContractId) {
    // Zuweisung der Person im Moco-Projekt suchen – nur wenn Moco eingeschaltet und erreichbar ist
    try {
      const { mocoEnabled, getMocoClient } = await import("@/modules/moco/client");
      if (mocoEnabled()) {
        const project = await getMocoClient().project(mocoProjectId);
        const mocoUserId = e.freelancerId ? (await db.query.freelancers.findFirst({ where: eq(schema.freelancers.id, e.freelancerId), columns: { mocoUserId: true } }))?.mocoUserId : (await db.query.users.findFirst({ where: eq(schema.users.id, e.internalUserId ?? "-"), columns: { mocoUserId: true } }))?.mocoUserId;
        const c = project?.contracts.find((x) => x.active && mocoUserId != null && x.user_id === mocoUserId);
        if (c) {
          const used = await db.query.engagements.findFirst({ where: and(eq(schema.engagements.workspaceId, actor.workspaceId), eq(schema.engagements.mocoContractId, c.id)), columns: { id: true } });
          if (!used) mocoContractId = c.id;
        }
      }
    } catch {
      /* Moco nicht erreichbar: Projekt-ID genügt, die Zuweisung ordnet der nächste Abgleich zu */
    }
  }
  await db.transaction(async (tx) => {
    await tx.update(schema.backofficeHandovers).set({ status: "QUITTIERT", mocoProjectId, ackNote: p.data.note || null, ackBy: actor.userId, ackAt: new Date() }).where(eq(schema.backofficeHandovers.id, h.id));
    if (mocoProjectId && (mocoProjectId !== e.mocoProjectId || mocoContractId !== e.mocoContractId)) {
      await tx.update(schema.engagements).set({ mocoProjectId, mocoContractId, updatedAt: new Date() }).where(eq(schema.engagements.id, e.id));
      await tx.update(schema.opportunities).set({ mocoProjectId }).where(and(eq(schema.opportunities.id, e.opportunityId), isNull(schema.opportunities.mocoProjectId)));
      await tx
        .update(schema.mocoHints)
        .set({ status: "UEBERNOMMEN", resolvedAt: new Date(), resolvedBy: actor.userId })
        .where(and(eq(schema.mocoHints.workspaceId, actor.workspaceId), eq(schema.mocoHints.status, "OFFEN"), or(eq(schema.mocoHints.dedupeKey, `new-project:${mocoProjectId}`), mocoContractId ? eq(schema.mocoHints.dedupeKey, `new-contract:${mocoContractId}`) : undefined)));
    }
    await recordAudit(tx, actor, "handover.acknowledged", "ENGAGEMENT", e.id, { uebergabe: h.id, art: h.kind, mocoProjekt: mocoProjectId });
  });
  await resolveNotifications(db, actor.workspaceId, `/uebergaben/${h.id}`);
  await notify(db, { workspaceId: actor.workspaceId, userIds: [h.createdBy, e.bdUserId], kind: "ERLEDIGT", title: `Backoffice hat quittiert: ${handoverKindLabel[h.kind]} – ${(h.payload as unknown as HandoverPayload).person}${mocoProjectId ? ` (Moco-Projekt ${mocoProjectId})` : ""}`, link: `/einsaetze/${e.id}`, actorUserId: actor.userId, dedupeKey: `handover-ack:${h.id}` });
  // e48: Einsatzblatt für die Buchhaltung und SharePoint-Spalten (Bestellnummer, Moco-Projekt) nachführen
  let einsatzblatt: { kunde: string | null; freelancer: string | null } | null = null;
  let sharepointError: string | null = null;
  try {
    const { writeEinsatzblatt, syncEngagementDocs } = await import("@/modules/sharepoint/documents");
    const fresh = await buildPayload(e.id, h.conversionId ?? null, null);
    if (h.kind !== "BEENDET") einsatzblatt = await writeEinsatzblatt(e.id, fresh, mocoProjectId);
    await syncEngagementDocs(e.id, h.kind === "BEENDET" ? { validTo: e.actualEnd ?? e.plannedEnd ?? null } : {});
  } catch (err) {
    sharepointError = (err as Error).message;
    console.error("SharePoint nach Quittung", sharepointError);
  }
  return { mocoProjectId, mocoContractId, einsatzblatt, sharepointError };
}

/** Erinnerung für Übergaben, die länger als zwei Tage offen sind – danach höchstens wöchentlich (e44). */
export async function remindOpenHandovers(now = new Date()): Promise<number> {
  const limit = new Date(now.getTime() - 2 * 86400000);
  const again = new Date(now.getTime() - 7 * 86400000);
  const rows = await db.query.backofficeHandovers.findMany({ where: and(eq(schema.backofficeHandovers.status, "OFFEN"), lt(schema.backofficeHandovers.createdAt, limit), or(isNull(schema.backofficeHandovers.remindedAt), lt(schema.backofficeHandovers.remindedAt, again))) });
  for (const h of rows) {
    const p = h.payload as unknown as HandoverPayload;
    const recipients = [...new Set([...(await backofficeUserIds(h.workspaceId)), ...(await salesOpsUserIds(h.workspaceId)), h.createdBy])];
    await notify(db, { workspaceId: h.workspaceId, userIds: recipients, kind: "UEBERFAELLIG", title: `Übergabe noch nicht quittiert: ${handoverTask[h.kind]} – ${p.person} bei ${p.kunde}`, link: `/uebergaben/${h.id}`, dedupeKey: `handover-remind:${h.id}:${now.toISOString().slice(0, 10)}` });
    await db.update(schema.backofficeHandovers).set({ remindedAt: now }).where(eq(schema.backofficeHandovers.id, h.id));
  }
  return rows.length;
}

/**
 * Übergabe für Verlängerung, Konditionsänderung oder Ende (e48: immer, auch ohne Moco-Projekt).
 * Fehler hier dürfen die auslösende Entscheidung nicht verhindern.
 */
export async function handoverForChange(actor: Actor, engagementId: string, kind: "VERLAENGERT" | "KONDITIONEN" | "BEENDET", hinweis: string): Promise<HandoverRow | null> {
  try {
    const e = await db.query.engagements.findFirst({ where: eq(schema.engagements.id, engagementId), columns: { mocoProjectId: true, status: true } });
    if (!e) return null;
    // e48: auch ohne Moco-Projekt – dann ordnet das Backoffice das Projekt beim Quittieren zu
    const prior = await db.query.backofficeHandovers.findFirst({ where: eq(schema.backofficeHandovers.engagementId, engagementId), columns: { id: true } });
    return await createHandover(actor, engagementId, kind, { hinweis: !e.mocoProjectId && !prior ? `${hinweis ? `${hinweis} · ` : ""}Am Einsatz hängt noch kein Moco-Projekt – bitte zuordnen.` : hinweis });
  } catch (err) {
    console.error("Übergabe ans Backoffice", (err as Error).message);
    return null;
  }
}
