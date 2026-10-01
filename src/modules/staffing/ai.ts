import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db/client";
import { ConflictError, ForbiddenError, NotFoundError, TransitionError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/identity/actor";
import { getAIProvider } from "@/modules/ai";
import { evidenceFound, runAiJob } from "@/modules/ai/jobs";
import { STAFFING_AD_PROMPT_VERSION, STAFFING_TEXT_PROMPT_VERSION } from "@/modules/ai/prompts";
import { staffingAdSchema, staffingTextSchema, type StaffingAd, type StaffingTextProposal } from "@/modules/ai/schemas";
import type { StaffingAdInput } from "@/modules/ai/provider";
import { ruleBasedStaffingAd, ruleBasedStaffingText } from "./drafts";
import { requireFullPosition } from "./authz";
import { canManageStaffingAt, createPosition, scopeUnitLabel } from "./service";
import { loadSetupContext } from "@/modules/identity/authz";

/**
 * KI der Besetzung (Etappe 28, E1): Ausschreibungsentwurf und Texteingang. Beides sind Entwürfe/Vorschläge; der
 * Mensch gibt frei bzw. übernimmt. Bei deaktivierter KI greift der regelbasierte Ersatzweg – der Ablauf bleibt möglich.
 * In den KI-Kontext gehen ausschließlich freigegebene Bedarfsfelder (keine EK, keine internen Notizen).
 */

export type AdDraftStored = StaffingAd & { note: string; promptVersion: string; channel: string; tone: string; releasedInfo: string; generatedAt: string; editedAt?: string };

export const adDraftInput = z.object({
  version: z.coerce.number().int().positive(),
  channel: z.enum(["FREELANCER_PLATTFORM", "NETZWERK", "INTERN"]).default("FREELANCER_PLATTFORM"),
  tone: z.enum(["SACHLICH", "ANSPRECHEND"]).default("SACHLICH"),
  /** ausdrücklich freigegebene Zusatzinformationen – bewusst leer, wenn der Kunde nicht genannt werden darf */
  releasedInfo: z.string().trim().max(500).optional().or(z.literal("")),
});

export function adInputFor(position: typeof schema.staffingPositions.$inferSelect, i: { channel: StaffingAdInput["channel"]; tone: StaffingAdInput["tone"]; releasedInfo?: string }): StaffingAdInput {
  return {
    title: position.title,
    tasks: position.tasks ?? "",
    mustHave: position.mustHave ?? "",
    niceToHave: position.niceToHave ?? "",
    location: position.location ?? "",
    language: position.language ?? "",
    desiredStart: position.desiredStart ?? "",
    plannedEnd: position.plannedEnd ?? (position.endOpen ? "offen" : ""),
    scope: position.scopeAmount && position.scopeUnit ? `${position.scopeAmount} ${scopeUnitLabel[position.scopeUnit] ?? position.scopeUnit}` : "",
    channel: i.channel,
    tone: i.tone,
    releasedInfo: i.releasedInfo ?? "",
  };
}

export async function generateAdDraft(actor: Actor, positionId: string, raw: unknown) {
  const p = adDraftInput.safeParse(raw);
  if (!p.success) throw new ValidationError(p.error.issues.map((x) => x.message).join("; "));
  const a = await requireFullPosition(actor, positionId);
  if (!a.manage && !a.searcher) throw new ForbiddenError("Den Ausschreibungsentwurf erzeugen BD und Suchbearbeiter:in.");
  if (a.position.adStatus === "FREIGEGEBEN") throw new TransitionError("Der Entwurf ist freigegeben – zum Neuentwerfen zuerst die Freigabe zurücknehmen.");
  const input = adInputFor(a.position, { channel: p.data.channel, tone: p.data.tone, releasedInfo: p.data.releasedInfo });
  const provider = getAIProvider();
  const info = provider.info();
  let ad: StaffingAd;
  let note = "";
  let promptVersion = "regelbasiert";
  if (!info.enabled || !provider.draftStaffingAd) {
    ad = ruleBasedStaffingAd(input);
    note = "KI deaktiviert – regelbasierter Entwurf aus den Bedarfsfeldern.";
  } else {
    const allowed = Object.values(input).join("\n");
    const run = await runAiJob(
      actor,
      { task: "STAFFING_AD_DRAFT", setupId: a.position.setupId, promptVersion: STAFFING_AD_PROMPT_VERSION, inputText: allowed, dedupeKey: `staffing-ad:${positionId}:${Date.now()}`, provider },
      async (prov, opts) => {
        const rawOut = await prov.draftStaffingAd!(input, opts);
        const parsed = staffingAdSchema.safeParse(rawOut);
        if (!parsed.success) throw new ValidationError("Die KI-Antwort entsprach nicht dem Schema.");
        return { result: parsed.data, itemCount: parsed.data.tasks.length + parsed.data.must.length };
      },
    ).catch((e: unknown) => {
      note = `KI-Entwurf nicht möglich (${e instanceof Error ? e.message.slice(0, 100) : "Fehler"}) – regelbasierter Entwurf.`;
      return null;
    });
    if (run) {
      ad = run.result;
      promptVersion = STAFFING_AD_PROMPT_VERSION;
      note = "KI-Entwurf (vorläufiger Prompt) – vor jeder Verwendung prüfen; fehlende Angaben stehen unter „Offen“.";
    } else {
      ad = ruleBasedStaffingAd(input);
      note ||= "Regelbasierter Entwurf.";
    }
  }
  const stored: AdDraftStored = { ...ad, note, promptVersion, channel: p.data.channel, tone: p.data.tone, releasedInfo: p.data.releasedInfo ?? "", generatedAt: new Date().toISOString() };
  return db.transaction(async (tx) => {
    const [u] = await tx
      .update(schema.staffingPositions)
      .set({ adDraft: stored, adStatus: "ENTWURF", adApprovedBy: null, adApprovedAt: null, version: p.data.version + 1, updatedAt: new Date() })
      .where(and(eq(schema.staffingPositions.id, positionId), eq(schema.staffingPositions.version, p.data.version)))
      .returning();
    if (!u) throw new ConflictError();
    await recordAudit(tx, actor, "position.ad_drafted", "POSITION", positionId, { mitKI: promptVersion !== "regelbasiert", kanal: p.data.channel });
    return u;
  });
}

export const adEditInput = z.object({
  version: z.coerce.number().int().positive(),
  title: z.string().trim().min(3).max(200),
  intro: z.string().trim().max(1000).optional().or(z.literal("")),
  tasksText: z.string().max(4000).optional().or(z.literal("")),
  mustText: z.string().max(4000).optional().or(z.literal("")),
  niceText: z.string().max(4000).optional().or(z.literal("")),
  conditionsText: z.string().max(2000).optional().or(z.literal("")),
  approve: z.union([z.boolean(), z.enum(["true", "false", "on"])]).optional(),
  withdraw: z.union([z.boolean(), z.enum(["true", "false", "on"])]).optional(),
});
const truthy = (v: unknown) => v === true || v === "true" || v === "on";
const toList = (t?: string) => (t ?? "").split(/\r?\n/).map((x) => x.replace(/^\s*[-•*]\s*/, "").trim()).filter(Boolean).slice(0, 20);

/** Entwurf bearbeiten; Freigabe (expliziter Stand) nur durch BD-Kontext. Veröffentlichen bleibt manuell (Kopieren). */
export async function saveAdDraft(actor: Actor, positionId: string, raw: unknown) {
  const p = adEditInput.safeParse(raw);
  if (!p.success) throw new ValidationError(p.error.issues.map((x) => x.message).join("; "));
  const a = await requireFullPosition(actor, positionId);
  const prev = (a.position.adDraft as AdDraftStored | null) ?? null;
  if (!prev) throw new NotFoundError("Ausschreibungsentwurf");
  const approve = truthy(p.data.approve);
  const withdraw = truthy(p.data.withdraw);
  if ((approve || withdraw) && !a.manage) throw new ForbiddenError("Die Freigabe des Ausschreibungstextes liegt beim verantwortlichen BD.");
  if (!approve && !withdraw && a.position.adStatus === "FREIGEGEBEN") throw new TransitionError("Freigegebener Text – zum Ändern erst die Freigabe zurücknehmen.");
  if (!a.manage && !a.searcher) throw new ForbiddenError();
  const next: AdDraftStored = { ...prev, title: p.data.title, intro: p.data.intro ?? "", tasks: toList(p.data.tasksText), must: toList(p.data.mustText), nice: toList(p.data.niceText), conditions: toList(p.data.conditionsText), editedAt: new Date().toISOString() };
  return db.transaction(async (tx) => {
    const [u] = await tx
      .update(schema.staffingPositions)
      .set({ adDraft: withdraw ? prev : next, adStatus: approve ? "FREIGEGEBEN" : "ENTWURF", adApprovedBy: approve ? actor.userId : null, adApprovedAt: approve ? new Date() : null, version: p.data.version + 1, updatedAt: new Date() })
      .where(and(eq(schema.staffingPositions.id, positionId), eq(schema.staffingPositions.version, p.data.version)))
      .returning();
    if (!u) throw new ConflictError();
    await recordAudit(tx, actor, approve ? "position.ad_approved" : withdraw ? "position.ad_withdrawn" : "position.ad_edited", "POSITION", positionId, {});
    return u;
  });
}

/** Freigegebenen oder entworfenen Text als kopierbaren Klartext. */
export function adToText(ad: AdDraftStored): string {
  const sec = (h: string, items: string[]) => (items.length ? `\n${h}\n${items.map((x) => `• ${x}`).join("\n")}\n` : "");
  return `${ad.title}\n\n${ad.intro ?? ""}\n${sec("Aufgaben", ad.tasks)}${sec("Das bringen Sie mit (Muss)", ad.must)}${sec("Wünschenswert", ad.nice)}${sec("Rahmen", ad.conditions)}`.replace(/\n{3,}/g, "\n\n").trim();
}

// ---------------------------------------------------------------------------
// Texteingang
// ---------------------------------------------------------------------------

export const intakeInput = z.object({ text: z.string().trim().min(20, "Bitte den Text (E-Mail, Notiz) einfügen – mindestens ein paar Sätze.").max(40000) });

/** Text aufnehmen (Quelle), Vorschlag erzeugen, zur Prüfung speichern. Noch keine Position. */
export async function createIntake(actor: Actor, opportunityId: string, raw: unknown) {
  const p = intakeInput.safeParse(raw);
  if (!p.success) throw new ValidationError(p.error.issues.map((x) => x.message).join("; "));
  if (!(await canManageStaffingAt(actor, opportunityId))) throw new ForbiddenError("Bedarfe aus Text übernimmt der zuständige BD, Principal oder CEO.");
  const opp = (await db.query.opportunities.findFirst({ where: and(eq(schema.opportunities.id, opportunityId), eq(schema.opportunities.workspaceId, actor.workspaceId)) }))!;
  const ctx = (await loadSetupContext(actor, opp.setupId))!;
  const text = p.data.text;
  const provider = getAIProvider();
  const info = provider.info();
  let proposal: StaffingTextProposal;
  let note = "";
  let promptVersion = "regelbasiert";
  const base = { text, opportunityTitle: opp.title, accountName: ctx.account.name };
  if (!info.enabled || !provider.structureStaffingText) {
    proposal = ruleBasedStaffingText(base);
    note = "KI deaktiviert – regelbasierte Erkennung (Rollen, Umfang, Ort, Sprache, Start).";
  } else {
    const run = await runAiJob(
      actor,
      { task: "STAFFING_NOTE_STRUCTURE", setupId: ctx.setup.id, promptVersion: STAFFING_TEXT_PROMPT_VERSION, inputText: text, dedupeKey: `staffing-text:${opportunityId}:${Date.now()}`, provider },
      async (prov, opts) => {
        const rawOut = await prov.structureStaffingText!(base, opts);
        const parsed = staffingTextSchema.safeParse(rawOut);
        if (!parsed.success) throw new ValidationError("Die KI-Antwort entsprach nicht dem Schema.");
        const kept = parsed.data.positions.filter((x) => evidenceFound(text, x.evidenceQuote));
        return { result: { ...parsed.data, positions: kept }, itemCount: kept.length, rejectedCount: parsed.data.positions.length - kept.length };
      },
    ).catch((e: unknown) => {
      note = `KI nicht verfügbar (${e instanceof Error ? e.message.slice(0, 100) : "Fehler"}) – regelbasierte Erkennung.`;
      return null;
    });
    if (run) {
      proposal = run.result;
      promptVersion = STAFFING_TEXT_PROMPT_VERSION;
      note = "KI-Vorschlag (vorläufiger Prompt). Jede Position zitiert eine Textstelle; nicht belegbare Vorschläge wurden entfernt.";
    } else {
      proposal = ruleBasedStaffingText(base);
      note ||= "Regelbasierte Erkennung.";
    }
  }
  return db.transaction(async (tx) => {
    const [src] = await tx
      .insert(schema.sources)
      .values({ workspaceId: actor.workspaceId, setupId: ctx.setup.id, type: /^(von|from|betreff|subject):/im.test(text) ? "EMAIL" : "NOTIZ", title: `Besetzungsbedarf (Texteingang) – ${opp.title}`.slice(0, 200), body: text, origin: "Besetzung · Texteingang", sourceTime: new Date(), ownerUserId: actor.userId, accessClass: "SETUP" })
      .returning();
    const [row] = await tx.insert(schema.staffingIntakes).values({ workspaceId: actor.workspaceId, opportunityId, sourceId: src!.id, proposal: { ...proposal, note, promptVersion }, createdBy: actor.userId }).returning();
    await recordAudit(tx, actor, "staffing.intake_created", "OPPORTUNITY", opportunityId, { eingang: row!.id, positionen: proposal.positions.length, mitKI: promptVersion !== "regelbasiert" });
    return row!;
  });
}

export async function getIntake(actor: Actor, intakeId: string) {
  const row = await db.query.staffingIntakes.findFirst({ where: and(eq(schema.staffingIntakes.id, intakeId), eq(schema.staffingIntakes.workspaceId, actor.workspaceId)) });
  if (!row) throw new NotFoundError("Texteingang");
  if (!(await canManageStaffingAt(actor, row.opportunityId))) throw new NotFoundError("Texteingang");
  const opp = (await db.query.opportunities.findFirst({ where: eq(schema.opportunities.id, row.opportunityId) }))!;
  const source = await db.query.sources.findFirst({ where: eq(schema.sources.id, row.sourceId) });
  return { intake: row, proposal: row.proposal as StaffingTextProposal & { note: string; promptVersion: string }, opportunity: opp, sourceBody: source?.body ?? "" };
}

/** Ausgewählte Vorschläge als Entwurfs-Positionen übernehmen (Vorschau → Übernahme, Quelle bleibt verknüpft). */
export async function applyIntake(actor: Actor, intakeId: string, raw: Record<string, string>) {
  const { intake, proposal } = await getIntake(actor, intakeId);
  if (intake.status !== "OFFEN") throw new TransitionError("Dieser Texteingang wurde bereits entschieden.");
  if (raw.decision === "VERWERFEN") {
    await db.transaction(async (tx) => {
      await tx.update(schema.staffingIntakes).set({ status: "VERWORFEN", decidedAt: new Date() }).where(eq(schema.staffingIntakes.id, intakeId));
      await recordAudit(tx, actor, "staffing.intake_discarded", "OPPORTUNITY", intake.opportunityId, { eingang: intakeId });
    });
    return { created: [] as string[] };
  }
  const picked = proposal.positions.map((_, idx) => idx).filter((idx) => raw[`take_${idx}`] === "on" || raw[`take_${idx}`] === "true");
  if (!picked.length) throw new ValidationError("Bitte mindestens eine Position auswählen oder den Eingang verwerfen.");
  return db.transaction(async (tx) => {
    const created: string[] = [];
    for (const idx of picked) {
      const x = proposal.positions[idx]!;
      const title = (raw[`title_${idx}`] ?? x.title).trim() || x.title;
      const scopeM = x.scopeText.match(/(\d{1,3})\s*(Tage|Tag|h|Stunden|%)/i);
      const scopeUnit = scopeM ? (/%/.test(scopeM[2]!) ? "PROZENT" : /tag/i.test(scopeM[2]!) ? "TAGE_PRO_WOCHE" : "STUNDEN_PRO_WOCHE") : "";
      const pos = await createPosition(
        actor,
        intake.opportunityId,
        {
          title,
          tasks: x.tasks,
          mustHave: x.mustHave,
          niceToHave: x.niceToHave,
          location: x.location,
          language: x.language,
          desiredStart: /^\d{4}-\d{2}-\d{2}$/.test(x.desiredStart) ? x.desiredStart : "",
          plannedEnd: /^\d{4}-\d{2}-\d{2}$/.test(x.plannedEnd) ? x.plannedEnd : "",
          endOpen: !x.plannedEnd && !x.endHint,
          scopeAmount: scopeM ? Number(scopeM[1]) : "",
          scopeUnit,
          internalNotes: [x.startHint && `Start laut Text: ${x.startHint}`, x.endHint && `Ende laut Text: ${x.endHint}`, x.rateHint && `Hinweis zu Sätzen/Budget laut Text: ${x.rateHint}`, `Belegstelle: „${x.evidenceQuote}“`].filter(Boolean).join("\n"),
        },
        { sourceId: intake.sourceId, tx },
      );
      created.push(pos.id);
    }
    await tx.update(schema.staffingIntakes).set({ status: "UEBERNOMMEN", decidedAt: new Date() }).where(eq(schema.staffingIntakes.id, intakeId));
    await recordAudit(tx, actor, "staffing.intake_applied", "OPPORTUNITY", intake.opportunityId, { eingang: intakeId, positionen: created.length });
    return { created };
  });
}
