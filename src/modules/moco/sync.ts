import { createHmac, timingSafeEqual } from "node:crypto";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { getConfig } from "@/lib/config";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/identity/actor";
import { notify } from "@/modules/notifications/service";
import { todayIso } from "@/modules/work/calendar";
import { getMocoClient, isIgnoredMocoUser, mocoEnabled, type MocoClient, type MocoProject } from "./client";
import { canRunMocoImport } from "./import";

/**
 * Laufender Abgleich Moco → Accountmeister (Einbahnstraße). Abweichungen werden nie still übernommen, sondern als
 * Hinweis (moco_hints) an den betroffenen Einsatz gehängt; die zuständige Person bestätigt mit einem Klick.
 * Neue Nutzer kommen automatisch als Anker, neue Freelancer in den Pool (Entscheidung vom Oktober 2026).
 */

export type HintKind = "ENDE_GEAENDERT" | "PROJEKT_BEENDET" | "CONTRACT_INAKTIV" | "NEUER_CONTRACT" | "NEUES_PROJEKT" | "GRUPPE_GEWECHSELT" | "NUTZER_INAKTIV";
export const hintKindLabel: Record<HintKind, string> = {
  ENDE_GEAENDERT: "Projektende in Moco geändert",
  PROJEKT_BEENDET: "Projekt in Moco beendet/archiviert",
  CONTRACT_INAKTIV: "Zuweisung in Moco inaktiv",
  NEUER_CONTRACT: "Neue Zuweisung in Moco",
  NEUES_PROJEKT: "Neues Projekt in Moco",
  GRUPPE_GEWECHSELT: "Projekt in andere Projektgruppe verschoben",
  NUTZER_INAKTIV: "Nutzer in Moco deaktiviert",
};

async function upsertHint(workspaceId: string, h: { subjectType: string; subjectId: string | null; kind: HintKind; title: string; payload: Record<string, unknown>; dedupeKey: string; notifyUserIds?: string[]; link?: string }) {
  const [row] = await db
    .insert(schema.mocoHints)
    .values({ workspaceId, subjectType: h.subjectType, subjectId: h.subjectId, kind: h.kind, title: h.title, payload: h.payload, dedupeKey: h.dedupeKey })
    .onConflictDoNothing()
    .returning({ id: schema.mocoHints.id });
  if (row && h.notifyUserIds?.length) await notify(db, { workspaceId, userIds: h.notifyUserIds, kind: "KOMMENTAR", title: `Moco: ${h.title}`, link: h.link ?? "/moco", dedupeKey: `moco:${h.dedupeKey}` });
  return row ? 1 : 0;
}

async function careUserIds(engagementId: string, bdUserId: string): Promise<string[]> {
  const cares = await db.query.careAssignments.findMany({ where: and(eq(schema.careAssignments.engagementId, engagementId), isNull(schema.careAssignments.toDate)) });
  return [...new Set([bdUserId, ...cares.map((c) => c.userId)])];
}

export type SyncCounts = { projekteGeprueft: number; hinweise: number; neueNutzer: number; neueFreelancer: number };

/** Delta-Abgleich: Projekte (inkl. archivierte, geändert seit `since`) und Nutzer. */
export async function runMocoSync(opts: { since?: string; client?: MocoClient; workspaceId?: string } = {}): Promise<SyncCounts> {
  const counts: SyncCounts = { projekteGeprueft: 0, hinweise: 0, neueNutzer: 0, neueFreelancer: 0 };
  if (!mocoEnabled()) return counts;
  const client = opts.client ?? getMocoClient();
  const cfg = getConfig();
  const ws = opts.workspaceId ?? (await db.query.workspaces.findFirst())?.id;
  if (!ws) return counts;
  const lastRun = await db.query.jobRuns.findFirst({ where: and(eq(schema.jobRuns.name, "moco-sync"), eq(schema.jobRuns.ok, true)), orderBy: desc(schema.jobRuns.startedAt) });
  const since = opts.since ?? (lastRun?.startedAt ? lastRun.startedAt.toISOString().slice(0, 10) : undefined);

  // --- Nutzer: neue automatisch nachziehen, deaktivierte als Hinweis ---------------------------------------
  const mUsers = await client.users({ includeArchived: true });
  const users = await db.query.users.findMany({ where: eq(schema.users.workspaceId, ws) });
  const freelancers = await db.query.freelancers.findMany({ where: and(eq(schema.freelancers.workspaceId, ws), isNull(schema.freelancers.mergedIntoId)) });
  const isFreelancerUnit = (name: string | undefined) => (name ?? "").trim().toLowerCase() === cfg.MOCO_FREELANCER_UNIT.trim().toLowerCase();
  const systemActor = users.find((u) => u.status === "ACTIVE");
  for (const u of mUsers) {
    if (isIgnoredMocoUser(u)) continue;
    const name = `${u.firstname} ${u.lastname}`.trim();
    if (isFreelancerUnit(u.unit?.name)) {
      if (!u.active) continue;
      const known = freelancers.find((f) => f.mocoUserId === u.id) ?? (u.email ? freelancers.find((f) => (f.email ?? "").toLowerCase() === u.email) : undefined);
      if (known) {
        if (!known.mocoUserId) await db.update(schema.freelancers).set({ mocoUserId: u.id }).where(eq(schema.freelancers.id, known.id));
        continue;
      }
      if (!systemActor) continue;
      await db.insert(schema.freelancers).values({ workspaceId: ws, displayName: name, email: u.email, mocoUserId: u.id, createdBy: systemActor.id, availabilitySource: "Moco (Sync)" });
      counts.neueFreelancer++;
      continue;
    }
    const known = users.find((x) => x.mocoUserId === u.id) ?? (u.email ? users.find((x) => x.email.toLowerCase() === u.email) : undefined);
    if (!u.active) {
      if (known && known.status === "ACTIVE") counts.hinweise += await upsertHint(ws, { subjectType: "USER", subjectId: known.id, kind: "NUTZER_INAKTIV", title: `${known.displayName} ist in Moco deaktiviert – Zugang prüfen (Verwaltung)`, payload: { mocoUserId: u.id }, dedupeKey: `user-inactive:${u.id}` });
      continue;
    }
    if (known) {
      if (!known.mocoUserId) await db.update(schema.users).set({ mocoUserId: u.id }).where(eq(schema.users.id, known.id));
      continue;
    }
    if (!u.email) continue;
    const [created] = await db.insert(schema.users).values({ workspaceId: ws, email: u.email, displayName: name, mocoUserId: u.id }).onConflictDoNothing().returning({ id: schema.users.id });
    if (created) {
      await db.insert(schema.roleAssignments).values({ workspaceId: ws, userId: created.id, role: "ANKER", scope: "WORKSPACE" });
      counts.neueNutzer++;
      // Team-Zugehörigkeit nachziehen, wenn das Moco-Team bekannt ist
      if (u.unit) {
        const team = await db.query.teams.findFirst({ where: and(eq(schema.teams.workspaceId, ws), eq(schema.teams.mocoUnitId, u.unit.id)) });
        if (team) await db.insert(schema.teamMembers).values({ teamId: team.id, userId: created.id, role: (u.role?.name ?? "").trim().toLowerCase() === cfg.MOCO_TEAMLEAD_ROLE.trim().toLowerCase() ? "LEITUNG" : "MITGLIED" }).onConflictDoNothing();
      }
    }
  }

  // --- Projekte -----------------------------------------------------------------------------------------------
  const projects = await client.projects({ includeArchived: true, updatedFrom: since });
  const engagements = await db.query.engagements.findMany({ where: and(eq(schema.engagements.workspaceId, ws), inArray(schema.engagements.status, ["VORBEREITUNG", "GEPLANT", "AKTIV", "PAUSIERT", "ENDET"])) });
  const linkedProjectIds = new Set(engagements.map((e) => e.mocoProjectId).filter((x): x is number => x != null));
  for (const p of projects) {
    counts.projekteGeprueft++;
    const mine = engagements.filter((e) => e.mocoProjectId === p.id);
    if (!mine.length) {
      // Unbekanntes aktives Projekt mit aktiven Zuweisungen → Hinweis zur Übernahme über einen neuen Importlauf
      if (p.active && p.contracts.some((c) => c.active)) counts.hinweise += await upsertHint(ws, { subjectType: "PROJECT", subjectId: String(p.id), kind: "NEUES_PROJEKT", title: `„${p.name}“ (${p.customer?.name ?? "ohne Kunde"}) ist in Moco neu – per Import übernehmen`, payload: { mocoProjectId: p.id, customer: p.customer?.name ?? null, contracts: p.contracts.filter((c) => c.active).map((c) => `${c.firstname} ${c.lastname}`) }, dedupeKey: `new-project:${p.id}` });
      continue;
    }
    for (const e of mine) {
      const who = await careUserIds(e.id, e.bdUserId);
      const link = `/einsaetze/${e.id}`;
      if (!p.active) {
        counts.hinweise += await upsertHint(ws, { subjectType: "ENGAGEMENT", subjectId: e.id, kind: "PROJEKT_BEENDET", title: `„${e.title}“: Projekt in Moco beendet – Einsatz beenden?`, payload: { mocoProjectId: p.id, finishDate: p.finish_date }, dedupeKey: `project-ended:${p.id}:${e.id}`, notifyUserIds: who, link });
        continue;
      }
      const contract = p.contracts.find((c) => c.id === e.mocoContractId);
      if (contract && !contract.active && ["AKTIV", "PAUSIERT", "GEPLANT", "VORBEREITUNG"].includes(e.status)) {
        counts.hinweise += await upsertHint(ws, { subjectType: "ENGAGEMENT", subjectId: e.id, kind: "CONTRACT_INAKTIV", title: `„${e.title}“: Zuweisung in Moco inaktiv – Einsatz beenden?`, payload: { mocoProjectId: p.id, mocoContractId: contract.id, finishDate: p.finish_date }, dedupeKey: `contract-inactive:${contract.id}`, notifyUserIds: who, link });
      }
      if (p.finish_date && e.plannedEnd && p.finish_date !== e.plannedEnd) {
        counts.hinweise += await upsertHint(ws, { subjectType: "ENGAGEMENT", subjectId: e.id, kind: "ENDE_GEAENDERT", title: `„${e.title}“: Projektende in Moco jetzt ${p.finish_date} (AM: ${e.plannedEnd})`, payload: { mocoProjectId: p.id, finishDate: p.finish_date, previous: e.plannedEnd }, dedupeKey: `end-changed:${p.id}:${e.id}:${p.finish_date}`, notifyUserIds: who, link });
      }
      const setup = await db.query.projectSetups.findFirst({ where: eq(schema.projectSetups.id, e.setupId), columns: { id: true, name: true, mocoProjectGroupId: true } });
      if (setup && p.project_group && setup.mocoProjectGroupId && setup.mocoProjectGroupId !== p.project_group.id) {
        counts.hinweise += await upsertHint(ws, { subjectType: "ENGAGEMENT", subjectId: e.id, kind: "GRUPPE_GEWECHSELT", title: `„${e.title}“: Projekt liegt in Moco jetzt in „${p.project_group.name}“ (AM-Setup: ${setup.name})`, payload: { mocoProjectId: p.id, groupId: p.project_group.id, groupName: p.project_group.name }, dedupeKey: `group-moved:${p.id}:${p.project_group.id}`, notifyUserIds: who, link });
      }
      // Neue aktive Zuweisung an bekanntem Projekt ohne Einsatz
      for (const c of p.contracts.filter((x) => x.active && !engagements.some((y) => y.mocoContractId === x.id))) {
        counts.hinweise += await upsertHint(ws, { subjectType: "PROJECT", subjectId: String(p.id), kind: "NEUER_CONTRACT", title: `„${p.name}“: ${c.firstname} ${c.lastname} ist in Moco neu zugewiesen – per Import übernehmen`, payload: { mocoProjectId: p.id, mocoContractId: c.id, person: `${c.firstname} ${c.lastname}` }, dedupeKey: `new-contract:${c.id}`, notifyUserIds: who, link: "/moco" });
      }
    }
  }
  void linkedProjectIds;
  return counts;
}

// ---------------------------------------------------------------------------
// Hinweise lesen und mit einem Klick bearbeiten
// ---------------------------------------------------------------------------

export async function listHints(actor: Actor, opts: { subjectType?: string; subjectId?: string; status?: "OFFEN" | "UEBERNOMMEN" | "VERWORFEN" } = {}) {
  const rows = await db.query.mocoHints.findMany({
    where: and(eq(schema.mocoHints.workspaceId, actor.workspaceId), opts.status ? eq(schema.mocoHints.status, opts.status) : undefined, opts.subjectType ? eq(schema.mocoHints.subjectType, opts.subjectType) : undefined, opts.subjectId ? eq(schema.mocoHints.subjectId, opts.subjectId) : undefined),
    orderBy: desc(schema.mocoHints.createdAt),
    limit: 200,
  });
  if (opts.subjectType === "ENGAGEMENT" && opts.subjectId) return rows; // Zugriff hat die aufrufende Seite geprüft
  // Übersicht: Einsatz-Hinweise nur für den BD-Kontext/Betreuung, Projekt-/Nutzer-Hinweise für Importberechtigte
  const { engagementAccess } = await import("@/modules/engagements/authz");
  const out: typeof rows = [];
  for (const h of rows) {
    if (h.subjectType === "ENGAGEMENT" && h.subjectId) {
      const e = await db.query.engagements.findFirst({ where: eq(schema.engagements.id, h.subjectId) });
      if (e && (await engagementAccess(actor, e))) out.push(h);
    } else if (canRunMocoImport(actor)) out.push(h);
  }
  return out;
}

export async function openHintCount(actor: Actor): Promise<number> {
  return (await listHints(actor, { status: "OFFEN" })).length;
}

/** Hinweis übernehmen (Änderung ausführen) oder verwerfen. */
export async function resolveHint(actor: Actor, hintId: string, decision: "UEBERNEHMEN" | "VERWERFEN") {
  const h = await db.query.mocoHints.findFirst({ where: and(eq(schema.mocoHints.id, hintId), eq(schema.mocoHints.workspaceId, actor.workspaceId)) });
  if (!h) throw new NotFoundError("Moco-Hinweis");
  if (h.status !== "OFFEN") throw new ValidationError("Der Hinweis ist bereits bearbeitet.");
  const payload = h.payload as Record<string, unknown>;
  if (h.subjectType === "ENGAGEMENT" && h.subjectId) {
    const { requireEngagement } = await import("@/modules/engagements/authz");
    const a = await requireEngagement(actor, h.subjectId);
    if (!a.manage) throw new ForbiddenError("Moco-Hinweise am Einsatz bearbeitet der verantwortliche BD, Principal oder CEO.");
    if (decision === "UEBERNEHMEN") {
      const e = a.engagement;
      if (h.kind === "ENDE_GEAENDERT") {
        await db.update(schema.engagements).set({ plannedEnd: String(payload.finishDate), version: e.version + 1, updatedAt: new Date() }).where(eq(schema.engagements.id, e.id));
        if (e.orderId) await db.update(schema.orders).set({ plannedEnd: String(payload.finishDate), updatedAt: new Date() }).where(eq(schema.orders.id, e.orderId));
        await recordAudit(db, actor, "engagement.updated", "ENGAGEMENT", e.id, { ende: payload.finishDate, quelle: "Moco" });
      } else if (h.kind === "PROJEKT_BEENDET" || h.kind === "CONTRACT_INAKTIV") {
        const end = typeof payload.finishDate === "string" && payload.finishDate <= todayIso() ? payload.finishDate : todayIso();
        const to = e.status === "ENDET" ? "ABGESCHLOSSEN" : ["AKTIV", "PAUSIERT"].includes(e.status) ? "ENDET" : "ABGEBROCHEN";
        await db.update(schema.engagements).set({ status: to, actualEnd: to === "ENDET" ? end : e.actualEnd, statusReason: `Laut Moco ${h.kind === "PROJEKT_BEENDET" ? "Projekt beendet" : "Zuweisung inaktiv"}.`, version: e.version + 1, updatedAt: new Date() }).where(eq(schema.engagements.id, e.id));
        const open = await db.query.checkins.findMany({ where: and(eq(schema.checkins.engagementId, e.id), eq(schema.checkins.status, "FAELLIG")) });
        for (const c of open) await db.update(schema.checkins).set({ status: "ABGESAGT", note: `${c.note ?? ""}\nEntfallen: Einsatz laut Moco beendet.`.trim(), version: c.version + 1, updatedAt: new Date() }).where(eq(schema.checkins.id, c.id));
        await recordAudit(db, actor, "engagement.status", "ENGAGEMENT", e.id, { von: e.status, nach: to, quelle: "Moco" });
      } else if (h.kind === "GRUPPE_GEWECHSELT") {
        const target = await db.query.projectSetups.findFirst({ where: and(eq(schema.projectSetups.accountId, e.accountId), eq(schema.projectSetups.mocoProjectGroupId, Number(payload.groupId))) });
        if (!target) throw new ValidationError("Die Ziel-Projektgruppe ist noch keinem Setup zugeordnet – zuerst einen Importlauf machen.");
        await db.update(schema.engagements).set({ setupId: target.id, version: e.version + 1, updatedAt: new Date() }).where(eq(schema.engagements.id, e.id));
        await db.update(schema.opportunities).set({ setupId: target.id, updatedAt: new Date() }).where(eq(schema.opportunities.id, e.opportunityId));
        await db.update(schema.staffingPositions).set({ setupId: target.id, updatedAt: new Date() }).where(eq(schema.staffingPositions.id, e.positionId));
        await recordAudit(db, actor, "engagement.moved", "ENGAGEMENT", e.id, { setup: target.id, quelle: "Moco" });
      }
    }
  } else {
    if (!canRunMocoImport(actor)) throw new ForbiddenError("Diese Hinweise bearbeiten CEO oder Principal.");
    if (decision === "UEBERNEHMEN" && h.kind === "NUTZER_INAKTIV" && h.subjectId) {
      await db.update(schema.users).set({ status: "INACTIVE", updatedAt: new Date() }).where(eq(schema.users.id, h.subjectId));
      await recordAudit(db, actor, "user.deactivated", "USER", h.subjectId, { quelle: "Moco" });
    }
    // NEUES_PROJEKT / NEUER_CONTRACT: Übernahme läuft über einen Importlauf – hier nur als erledigt markieren
  }
  await db.update(schema.mocoHints).set({ status: decision === "UEBERNEHMEN" ? "UEBERNOMMEN" : "VERWORFEN", resolvedAt: new Date(), resolvedBy: actor.userId }).where(eq(schema.mocoHints.id, h.id));
  await recordAudit(db, actor, "moco.hint_resolved", "MOCO_HINT", h.id, { art: h.kind, entscheidung: decision });
  return h;
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

export function verifyMocoSignature(rawBody: string, signature: string | null, secret = getConfig().MOCO_WEBHOOK_SECRET): boolean {
  if (!secret || !signature) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature.trim().toLowerCase());
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Verarbeitet ein Webhook-Ereignis: protokolliert Kopfdaten, stößt bei Projekt-/Nutzer-Ereignissen den Abgleich an. */
export async function handleMocoWebhook(headers: { target: string | null; event: string | null; signature: string | null }, rawBody: string, opts: { wait?: boolean } = {}): Promise<{ accepted: boolean; reason?: string }> {
  const ok = verifyMocoSignature(rawBody, headers.signature);
  let mocoId: number | null = null;
  try {
    const body = JSON.parse(rawBody) as { id?: number };
    mocoId = typeof body.id === "number" ? body.id : null;
  } catch {
    /* Nutzlast ohne JSON – nur Kopfdaten protokollieren */
  }
  const [ev] = await db.insert(schema.mocoEvents).values({ target: headers.target ?? "?", event: headers.event ?? "?", mocoId, signatureOk: ok }).returning({ id: schema.mocoEvents.id });
  if (!ok) return { accepted: false, reason: "Signatur ungültig" };
  const target = (headers.target ?? "").toLowerCase();
  if (["project", "user", "company", "customer", "contract", "projectcontract", "project_contract"].some((t) => target.includes(t))) {
    // Abgleich im Hintergrund – Moco erwartet die Antwort innerhalb von 10 Sekunden
    const run = async () => {
      try {
        const sinceYesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
        await runMocoSync({ since: sinceYesterday });
        await db.update(schema.mocoEvents).set({ processedAt: new Date() }).where(eq(schema.mocoEvents.id, ev!.id));
      } catch (e) {
        await db.update(schema.mocoEvents).set({ processedAt: new Date(), error: (e as Error).message.slice(0, 500) }).where(eq(schema.mocoEvents.id, ev!.id));
      }
    };
    if (opts.wait) await run();
    else void run();
  } else {
    await db.update(schema.mocoEvents).set({ processedAt: new Date() }).where(eq(schema.mocoEvents.id, ev!.id));
  }
  return { accepted: true };
}

export async function mocoStatus(actor: Actor) {
  const cfg = getConfig();
  const lastRun = await db.query.jobRuns.findFirst({ where: eq(schema.jobRuns.name, "moco-sync"), orderBy: desc(schema.jobRuns.startedAt) });
  const events = canRunMocoImport(actor) ? await db.query.mocoEvents.findMany({ orderBy: desc(schema.mocoEvents.receivedAt), limit: 10 }) : [];
  const linked = await db.select({ n: schema.engagements.id }).from(schema.engagements).where(and(eq(schema.engagements.workspaceId, actor.workspaceId), isNull(schema.engagements.mocoContractId)));
  return { mode: cfg.MOCO_MODE, enabled: mocoEnabled(), subdomain: cfg.MOCO_SUBDOMAIN ?? null, webhookConfigured: !!cfg.MOCO_WEBHOOK_SECRET, lastRun, events, unlinkedEngagements: linked.length };
}

export type { MocoProject };
