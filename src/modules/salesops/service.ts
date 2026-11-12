import { EXPIRY_WINDOW_DAYS } from "@/lib/window";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db/client";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import { hasRole, type Actor } from "@/modules/identity/actor";
import { todayIso, plusDaysIso } from "@/modules/work/calendar";
import { quickFill } from "@/modules/staffing/service";
import { listEngagements } from "@/modules/engagements/service";
import { listRenewalCards } from "@/modules/engagements/care";
import { approachValues, ensureContactPerson } from "@/modules/engagements/contacts";

/**
 * Sales-Ops-Sicht (e37): ein Arbeitsplatz für Sales Operations – was ist anzustoßen, wo fehlen Ansprechpartner oder
 * Unterlagen, was ist aufzuräumen – und eine Schnellerfassung für neue Assignments (Einsatz mit Auftrag/Bestellung).
 * Sales Operations trifft dabei keine kommerzielle Entscheidung; die Verlängerung bestätigt weiter der BD-Kontext.
 */

export function canUseSalesOps(actor: Actor): boolean {
  return actor.roles.has("SALES_OPS") || hasRole(actor, "CEO") || actor.roles.has("ADMIN");
}

export async function salesOpsOverview(actor: Actor) {
  if (!canUseSalesOps(actor)) throw new ForbiddenError("Die Sales-Ops-Sicht nutzen Sales Operations und Geschäftsführung.");
  const [{ items: running, counts }, cards, hints] = await Promise.all([
    listEngagements(actor, "laufend"),
    listRenewalCards(actor),
    db.query.mocoHints.findMany({ where: and(eq(schema.mocoHints.workspaceId, actor.workspaceId), eq(schema.mocoHints.status, "OFFEN")), columns: { id: true } }),
  ]);
  const { openHandoverCount } = await import("@/modules/conversion/handover");
  const { listRunningConversions } = await import("@/modules/conversion/service");
  const [uebergabenOffen, vorgaenge] = await Promise.all([openHandoverCount(actor), listRunningConversions(actor)]);
  const t = todayIso();
  const horizon = plusDaysIso(t, EXPIRY_WINDOW_DAYS);
  const ending = running.filter((e) => e.endDate && e.endDate <= horizon).sort((a, b) => (a.endDate ?? "").localeCompare(b.endDate ?? ""));
  const toStart = cards.filter((c) => c.mode === "ANSTOSSEN");
  const inDecision = cards.filter((c) => c.mode === "ENTSCHEIDEN" || c.status === "IN_ABSTIMMUNG" || c.status === "ANGEBOTEN");
  return {
    kpis: {
      anzustossen: toStart.length,
      inEntscheidung: inDecision.length,
      ohneAnsprechpartner: counts.ohne_ansprechpartner,
      unterlagenOffen: counts.vertrag_offen,
      endeUeberschritten: counts.ende_ueberschritten,
      mocoHinweise: hints.length,
      laufend: counts.laufend,
      uebergabenOffen,
      vorgaenge: vorgaenge.length,
    },
    vorgaenge,
    ending,
    renewalCards: toStart,
  };
}

/** Auswahl für die Schnellerfassung. */
export async function captureChoices(actor: Actor) {
  const [accounts, setups, freelancers, users] = await Promise.all([
    db.query.accounts.findMany({ where: and(eq(schema.accounts.workspaceId, actor.workspaceId), inArray(schema.accounts.status, ["ACTIVE", "DORMANT"])), columns: { id: true, name: true }, orderBy: (a, { asc }) => [asc(a.name)] }),
    db.query.projectSetups.findMany({ where: eq(schema.projectSetups.workspaceId, actor.workspaceId), columns: { id: true, name: true, accountId: true, status: true }, orderBy: (s, { asc }) => [asc(s.name)] }),
    db.query.freelancers.findMany({ where: eq(schema.freelancers.workspaceId, actor.workspaceId), columns: { id: true, displayName: true, mergedIntoId: true }, orderBy: (f, { asc }) => [asc(f.displayName)] }),
    db.query.users.findMany({ where: and(eq(schema.users.workspaceId, actor.workspaceId), eq(schema.users.status, "ACTIVE")), columns: { id: true, displayName: true }, orderBy: (u, { asc }) => [asc(u.displayName)] }),
  ]);
  const an = new Map(accounts.map((a) => [a.id, a.name]));
  return {
    setups: setups.filter((s) => s.status !== "ARCHIVIERT" && an.has(s.accountId)).map((s) => ({ id: s.id, label: `${an.get(s.accountId)} › ${s.name}`, accountId: s.accountId })).sort((a, b) => a.label.localeCompare(b.label)),
    freelancers: freelancers.filter((f) => !f.mergedIntoId).map((f) => ({ id: f.id, name: f.displayName })),
    users: users.map((u) => ({ id: u.id, name: u.displayName })),
  };
}

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).or(z.literal("")).optional().default("");
const money = z.string().trim().regex(/^(\d+([.,]\d{1,2})?)?$/, "Betrag bitte als Zahl").optional().default("");
export const captureInput = z.object({
  setupId: z.string().min(1, "Bitte Kunde/Setup wählen."),
  title: z.string().trim().min(3, "Rolle/Titel fehlt.").max(200),
  person: z.enum(["FREELANCER", "INTERN"]).default("FREELANCER"),
  freelancerId: z.string().optional().default(""),
  newName: z.string().trim().max(200).optional().default(""),
  internalUserId: z.string().optional().default(""),
  start: dateStr,
  end: dateStr,
  ekRate: money,
  vkRate: money,
  rateUnit: z.enum(["TAG", "STUNDE"]).default("TAG"),
  orderReference: z.string().trim().max(200).optional().default(""),
  renewalDeadline: dateStr,
  renewalContactPersonId: z.string().optional().default(""),
  orderContactPersonId: z.string().optional().default(""),
  renewalApproach: z.union([z.enum(approachValues), z.literal("")]).optional().default(""),
  newRenewalName: z.string().trim().max(200).optional().default(""),
  newRenewalEmail: z.string().trim().max(200).optional().default(""),
  note: z.string().trim().max(2000).optional().default(""),
});

/**
 * Neues Assignment erfassen: Chance „beauftragt“ + Auftrag/Bestellung (bestätigt) + besetzte Position + Einsatzakte.
 * Startet der Einsatz heute oder früher, steht er direkt auf aktiv. BD ist der Setup-BD (sonst der zuständige BD).
 */
export async function captureAssignment(actor: Actor, raw: unknown) {
  if (!canUseSalesOps(actor)) throw new ForbiddenError("Assignments erfassen hier Sales Operations und Geschäftsführung.");
  const p = captureInput.safeParse(raw);
  if (!p.success) throw new ValidationError(p.error.issues.map((i) => i.message).join("; "));
  const i = p.data;
  const setup = await db.query.projectSetups.findFirst({ where: and(eq(schema.projectSetups.id, i.setupId), eq(schema.projectSetups.workspaceId, actor.workspaceId)) });
  if (!setup) throw new ValidationError("Setup nicht gefunden.");
  const account = (await db.query.accounts.findFirst({ where: eq(schema.accounts.id, setup.accountId) }))!;
  const owner = setup.bdUserId ?? account.responsibleBdUserId;
  if (!owner) throw new ValidationError("Für diesen Kunden ist kein BD hinterlegt – bitte zuerst am Setup oder Kunden den BD eintragen.");
  if (i.person === "FREELANCER" && !i.freelancerId && i.newName.length < 2) throw new ValidationError("Bitte Freelancer wählen oder Namen eintragen.");
  if (i.person === "INTERN" && !i.internalUserId) throw new ValidationError("Bitte die interne Person wählen.");
  if (i.person === "FREELANCER" && !i.ekRate) throw new ValidationError("Für einen Freelancer bitte den Einkaufssatz (EK) angeben.");
  if (i.start && i.end && i.end < i.start) throw new ValidationError("Das Ende liegt vor dem Start.");
  for (const pid of [i.renewalContactPersonId, i.orderContactPersonId].filter(Boolean)) {
    const ok = await db.query.persons.findFirst({ where: and(eq(schema.persons.id, pid), eq(schema.persons.accountId, account.id)), columns: { id: true } });
    if (!ok) throw new ValidationError("Ansprechpartner müssen Personen dieses Kunden sein.");
  }
  const renewalContactId = i.newRenewalName ? await ensureContactPerson(actor, account.id, i.newRenewalName, i.newRenewalEmail) : i.renewalContactPersonId;
  const t = todayIso();
  const started = !!i.start && i.start <= t;
  const [opp] = await db
    .insert(schema.opportunities)
    .values({ workspaceId: actor.workspaceId, accountId: account.id, setupId: setup.id, title: i.title, needDescription: `Assignment von Sales Operations erfasst.${i.note ? ` ${i.note}` : ""}`.slice(0, 4000), status: "BEAUFTRAGT", kind: i.person === "FREELANCER" ? "FREELANCER_EXPERTE" : "VERVE_EXPERTE", headcount: 1, ownerUserId: owner, confirmedAt: new Date(), createdBy: actor.userId })
    .returning();
  const [order] = await db
    .insert(schema.orders)
    .values({ workspaceId: actor.workspaceId, opportunityId: opp!.id, orderReference: i.orderReference || null, evidenceNote: i.note || "Von Sales Operations erfasst", plannedStart: i.start || null, plannedEnd: i.end || null, renewalDeadline: i.renewalDeadline || null, status: "BEAUFTRAGUNG_BESTAETIGT", confirmedAt: new Date(), confirmedBy: actor.userId, engagementStatus: started ? "GESTARTET" : "GEPLANT", startedAt: started ? new Date(i.start) : null, createdBy: actor.userId })
    .returning();
  const cleanup = async () => {
    await db.delete(schema.orders).where(eq(schema.orders.id, order!.id));
    await db.delete(schema.opportunities).where(eq(schema.opportunities.id, opp!.id));
  };
  const r = await quickFill(
    actor,
    opp!.id,
    {
      title: i.title,
      resourceKind: i.person,
      ...(i.person === "FREELANCER" ? (i.freelancerId ? { freelancerId: i.freelancerId } : { newName: i.newName }) : { internalUserId: i.internalUserId }),
      ekRate: i.person === "FREELANCER" ? i.ekRate.replace(",", ".") : "",
      vkRate: i.vkRate.replace(",", "."),
      rateUnit: i.rateUnit,
      desiredStart: i.start,
      plannedEnd: i.end,
      endOpen: i.end ? "false" : "on",
      bdUserId: owner,
      reason: "Von Sales Operations erfasst (Person stand fest).",
    },
    { trusted: true },
  ).catch(async (err) => {
    await cleanup().catch(() => null);
    throw err;
  });
  const [e] = await db
    .update(schema.engagements)
    .set({
      orderId: order!.id,
      renewalDeadline: i.renewalDeadline || null,
      renewalContactPersonId: renewalContactId || null,
      orderContactPersonId: i.orderContactPersonId || null,
      renewalApproach: i.renewalApproach || null,
      ...(started ? { status: "AKTIV", actualStart: i.start } : { status: "GEPLANT" }),
      updatedAt: new Date(),
    })
    .where(eq(schema.engagements.id, r.engagement.id))
    .returning();
  await recordAudit(db, actor, "engagement.captured", "ENGAGEMENT", e!.id, { kunde: account.name, auftrag: order!.id, bestellnummer: i.orderReference || null });
  return e!;
}
