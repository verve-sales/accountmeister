import { createHash } from "node:crypto";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db/client";
import { ConflictError, ForbiddenError, NotFoundError, TransitionError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/identity/actor";
import { canEditSetup, canViewSetup, loadSetupContext, type SetupContext } from "@/modules/identity/authz";
import { listMySetups } from "@/modules/setups/service";
import { structureText } from "@/modules/suggestions/service";
import { sanitizeToText } from "@/modules/integrations/graph/adapter";
import { getMailCalendarAdapter } from "@/modules/integrations";
import { adapterErrorToDomain } from "@/modules/integrations/service";
import type { FetchedSource, SelectableKind } from "@/modules/integrations/adapter";

/**
 * Importprozess (Briefing 13.2):
 *  1 berechtigte Quelle wählen · 2 Zielkunde/Setup vorschlagen oder wählen · 3 Umfang und Empfängerkreis anzeigen
 *  4 Quelle sicher übernehmen · 5 Personen/Aussagen/Hinweise/Aktionen extrahieren (KI-Kette) · 6 Konflikte, unklare
 *  Zuordnungen und sensible Inhalte sichtbar machen · 7 Ergänzungen prüfen/bestätigen (Vorschläge) · 8 protokollieren.
 *
 * Beweiskraft (13.3): Mail belegt eine Aussage, Termin belegt Planung, Notiz belegt Dokumentation. Nichts davon wird
 * automatisch zu einem bestätigten Sachverhalt oder einer Beziehung.
 */

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const MAX_TEXT_CHARS = 200_000;
const ALLOWED_FILE_TYPES = [".txt", ".md"]; // freigegebene Dateitypen im Pilot; PDF/DOCX folgen nach Prüfung der Verarbeitung
const SENSITIVE = /\b(gehalt|krank|krankheit|schwanger|kündigung|abmahnung|privat|scheidung|religion|gewerkschaft|behinder)\w*/i;

export type ImportProposal = {
  suggestedSetups: { id: string; name: string; accountName: string; reason: string }[];
  warnings: string[];
  scopeSummary: string;
  mentionedPeople: { name: string; email?: string; candidates: { id: string; displayName: string }[] }[];
};

// ---------------------------------------------------------------------------
// Schritt 1–3: Vorschau/Vorschlag ohne Speichern
// ---------------------------------------------------------------------------

export const previewProtocolInput = z.object({
  title: z.string().trim().min(3, "Titel fehlt").max(200),
  text: z.string().min(12, "Text ist zu kurz").max(MAX_TEXT_CHARS),
  fileName: z.string().max(200).optional().or(z.literal("")),
});

export function validateFileName(fileName: string | undefined): void {
  if (!fileName) return;
  const lower = fileName.toLowerCase();
  if (!ALLOWED_FILE_TYPES.some((ext) => lower.endsWith(ext))) throw new ValidationError(`Dateityp nicht freigegeben. Zulässig: ${ALLOWED_FILE_TYPES.join(", ")}.`);
}

export async function proposeForText(actor: Actor, text: string, participants: { name: string; email?: string }[] = []): Promise<ImportProposal> {
  const warnings: string[] = [];
  if (/<[a-z][\s\S]*>/i.test(text)) warnings.push("HTML-Auszeichnungen wurden entfernt; es wird nur Text übernommen.");
  if (/https?:\/\//i.test(text)) warnings.push("Links bleiben als Text stehen und werden nicht abgerufen.");
  if (SENSITIVE.test(text)) warnings.push("Der Text enthält möglicherweise sensible personenbezogene Inhalte. Bitte prüfen, ob der Import zulässig und der Empfängerkreis eng genug ist.");

  // Zielsetup vorschlagen: E-Mail-Adressen/Namen der Beteiligten mit bekannten Personen abgleichen → Kunde → Setups des Akteurs
  const mySetups = await listMySetups(actor);
  const clean = sanitizeToText(text);
  const persons = await db.query.persons.findMany({ where: eq(schema.persons.workspaceId, actor.workspaceId) });
  // Verve-eigene Nutzer sind keine Kundenpersonen – sie erscheinen nicht in der Zuordnungsprüfliste
  const ownUsers = await db.query.users.findMany({ where: eq(schema.users.workspaceId, actor.workspaceId) });
  const ownEmails = new Set(ownUsers.map((u) => u.email.toLowerCase()));
  const mentioned: ImportProposal["mentionedPeople"] = [];
  const hitAccounts = new Map<string, string>();
  const nameOf = (p: (typeof persons)[number]) => p.displayName.replace(/\(.*?\)/g, "").trim();
  const lastName = (n: string) => n.replace(/^(Frau|Herr|Fr\.|Hr\.)\s+/i, "").split(",")[0]!.split(/\s+/).pop()!.toLowerCase();

  for (const part of participants) {
    if (!part.name && !part.email) continue;
    if (part.email && ownEmails.has(part.email.toLowerCase())) continue;
    const byEmail = part.email ? persons.filter((p) => p.email && p.email.toLowerCase() === part.email!.toLowerCase()) : [];
    const byName = persons.filter((p) => lastName(nameOf(p)) === lastName(part.name));
    const candidates = byEmail.length ? byEmail : byName;
    // Gleicher Name ist kein Identitätsbeweis: nur eindeutige E-Mail-Treffer gelten als sicher (13.4)
    if (byEmail.length === 1 && byEmail[0]!.accountId) hitAccounts.set(byEmail[0]!.accountId, `Beteiligte ${part.name} ist per E-Mail eindeutig bekannt`);
    mentioned.push({ name: part.name, email: part.email, candidates: candidates.map((c) => ({ id: c.id, displayName: c.displayName })) });
  }
  // Namen im Text
  for (const p of persons) {
    const ln = lastName(nameOf(p));
    if (ln.length >= 3 && new RegExp(`\\b${ln}\\b`, "i").test(clean) && !mentioned.some((m) => lastName(m.name) === ln)) {
      const same = persons.filter((x) => lastName(nameOf(x)) === ln);
      mentioned.push({ name: nameOf(p), candidates: same.map((c) => ({ id: c.id, displayName: c.displayName })) });
      if (same.length === 1 && p.accountId) hitAccounts.set(p.accountId, `Name „${nameOf(p)}“ im Text; nur eine Person dieses Namens bekannt`);
    }
  }
  const suggestedSetups = mySetups
    .filter((s) => hitAccounts.has(s.accountId))
    .map((s) => ({ id: s.id, name: s.name, accountName: s.accountName, reason: hitAccounts.get(s.accountId)! }));

  const ambiguous = mentioned.filter((m) => m.candidates.length > 1);
  if (ambiguous.length) warnings.push(`Mehrdeutige Personen: ${ambiguous.map((m) => m.name).join(", ")} – keine automatische Zusammenführung, Prüfliste wird angelegt.`);

  return { suggestedSetups, warnings, scopeSummary: `${clean.length} Zeichen Text`, mentionedPeople: mentioned };
}

// ---------------------------------------------------------------------------
// Schritt 4–8: Übernahme, Auswertung, Protokoll
// ---------------------------------------------------------------------------

export const importProtocolInput = z.object({
  title: z.string().trim().min(3, "Titel fehlt").max(200),
  text: z.string().min(12).max(MAX_TEXT_CHARS),
  fileName: z.string().max(200).optional().or(z.literal("")),
  setupId: z.string().min(1, "Zielsetup fehlt"),
  accessClass: z.enum(schema.accessClassEnum.enumValues).default("SETUP"),
  sourceTime: z.string().optional().or(z.literal("")),
  structure: z.union([z.boolean(), z.string()]).optional(),
});

/** Protokoll als Text/Datei importieren: erzeugt Quelle + Version + Importauftrag, optional Strukturierung. Wiederimport ist idempotent. */
export async function importProtocol(actor: Actor, raw: unknown) {
  const parsed = importProtocolInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  validateFileName(input.fileName || undefined);
  const ctx = await requireEditableCtx(actor, input.setupId);
  const clean = sanitizeToText(input.text);
  const externalKey = `protokoll:${sha(clean)}`;
  const proposal = await proposeForText(actor, input.text);
  const kind = input.fileName ? "PROTOKOLL_DATEI" : "PROTOKOLL_TEXT";
  return persistImport(actor, ctx, {
    kind,
    externalKey,
    title: input.title,
    sourceType: "PROTOKOLL",
    body: clean,
    origin: input.fileName ? `Datei ${input.fileName}` : "Protokolltext (manuell eingefügt)",
    sourceTime: input.sourceTime ? new Date(input.sourceTime) : new Date(),
    accessClass: input.accessClass,
    contentHash: sha(clean),
    warnings: proposal.warnings,
    scopeSummary: proposal.scopeSummary,
    mentioned: proposal.mentionedPeople,
    participantsForAi: [actor.userId],
    structure: input.structure === true || input.structure === "true" || input.structure === "on",
  });
}

export const importMailboxItemInput = z.object({
  kind: z.enum(["MAIL", "TERMIN"]),
  externalId: z.string().min(1),
  setupId: z.string().min(1, "Zielsetup fehlt"),
  accessClass: z.enum(schema.accessClassEnum.enumValues).default("PERSOENLICH"),
  structure: z.union([z.boolean(), z.string()]).optional(),
});

/** Einzelne Mail/einzelnen Termin aus dem eigenen Postfach importieren (nach Auswahl, 13.1). Anhänge werden nicht übernommen. */
export async function importMailboxItem(actor: Actor, raw: unknown) {
  const parsed = importMailboxItemInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  const conn = await db.query.integrationConnections.findFirst({ where: and(eq(schema.integrationConnections.userId, actor.userId), eq(schema.integrationConnections.provider, "MICROSOFT_GRAPH")) });
  if (!conn || conn.status === "WIDERRUFEN" || !conn.tokenRef) throw new ValidationError("Kein verbundenes Postfach.");
  const ctx = await requireEditableCtx(actor, input.setupId);
  let fetched: FetchedSource;
  try {
    fetched = await getMailCalendarAdapter().fetch({ tokenRef: conn.tokenRef, fixture: conn.fixtureMode, kind: input.kind as SelectableKind, externalId: input.externalId });
  } catch (e) {
    throw adapterErrorToDomain(e);
  }
  const clean = sanitizeToText(fetched.bodyText);
  const header = [
    fetched.kind === "MAIL" ? `Von: ${fetched.from?.name ?? "?"}${fetched.from?.email ? ` <${fetched.from.email}>` : ""}` : `Organisator: ${fetched.from?.name ?? "?"}`,
    fetched.participants.length ? `Beteiligte: ${fetched.participants.map((p) => p.name).join(", ")}` : "",
    fetched.kind === "TERMIN" ? `Hinweis: Ein Termin belegt Planung, nicht Teilnahme (${fetched.meetingAcceptedByUser ? "vom Nutzer angenommen" : "nicht angenommen"}).` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const body = `${header}\n\n${clean}`;
  const participants = [...(fetched.from ? [fetched.from] : []), ...fetched.participants];
  const proposal = await proposeForText(actor, clean, participants);
  const warnings = [...proposal.warnings];
  if (fetched.attachmentNames.length) warnings.push(`${fetched.attachmentNames.length} Anhang/Anhänge nicht übernommen (${fetched.attachmentNames.join(", ")}).`);
  if (conn.fixtureMode) warnings.push("Fixture-Modus: Diese Quelle ist eine fiktive Testquelle, kein echtes Postfachobjekt.");
  return persistImport(actor, ctx, {
    kind: input.kind,
    externalKey: `${conn.provider}:${fetched.kind}:${fetched.externalId}`,
    connectionId: conn.id,
    title: fetched.subject,
    sourceType: fetched.kind === "MAIL" ? "EMAIL" : "TERMIN",
    body,
    origin: `${conn.fixtureMode ? "Fixture" : "Microsoft 365"} · ${fetched.kind === "MAIL" ? "E-Mail" : "Termin"} · Import durch ${actor.displayName}`,
    sourceTime: new Date(fetched.at),
    accessClass: input.accessClass,
    contentHash: fetched.contentHash,
    warnings,
    scopeSummary: `1 ${fetched.kind === "MAIL" ? "E-Mail" : "Termin"}, ${clean.length} Zeichen Text, ${fetched.attachmentNames.length} Anhänge ausgeschlossen`,
    mentioned: proposal.mentionedPeople,
    participantsForAi: [actor.userId],
    structure: input.structure === true || input.structure === "true" || input.structure === "on",
  });
}

type PersistInput = {
  kind: "PROTOKOLL_TEXT" | "PROTOKOLL_DATEI" | "MAIL" | "TERMIN";
  externalKey: string;
  connectionId?: string;
  title: string;
  sourceType: "PROTOKOLL" | "EMAIL" | "TERMIN";
  body: string;
  origin: string;
  sourceTime: Date;
  accessClass: (typeof schema.accessClassEnum.enumValues)[number];
  contentHash: string;
  warnings: string[];
  scopeSummary: string;
  mentioned: ImportProposal["mentionedPeople"];
  participantsForAi: string[];
  structure: boolean;
};

async function requireEditableCtx(actor: Actor, setupId: string): Promise<SetupContext> {
  const ctx = await loadSetupContext(actor, setupId);
  if (!ctx || !canViewSetup(actor, ctx)) throw new NotFoundError("Setup");
  if (!canEditSetup(actor, ctx)) throw new ForbiddenError("Sie dürfen in dieses Setup nichts importieren.");
  return ctx;
}

async function persistImport(actor: Actor, ctx: SetupContext, p: PersistInput) {
  // Idempotenz: gleiche externe Kennung → kein zweiter Import; bei geändertem Inhalt neue Quellenversion (Testfall 19.2)
  const existing = await db.query.importJobs.findFirst({ where: and(eq(schema.importJobs.workspaceId, actor.workspaceId), eq(schema.importJobs.kind, p.kind), eq(schema.importJobs.externalKey, p.externalKey)) });
  if (existing && existing.sourceId) {
    const versions = await db.query.sourceVersions.findMany({ where: eq(schema.sourceVersions.sourceId, existing.sourceId), orderBy: desc(schema.sourceVersions.versionNo) });
    const latest = versions[0];
    if (latest && latest.contentHash === p.contentHash) {
      return { job: existing, sourceId: existing.sourceId, repeated: true, newVersion: false, structured: null as null | Awaited<ReturnType<typeof structureText>> };
    }
    if (existing.actorUserId !== actor.userId && !canEditSetup(actor, ctx)) throw new ForbiddenError();
    const versionNo = (latest?.versionNo ?? 0) + 1;
    await db.transaction(async (tx) => {
      await tx.insert(schema.sourceVersions).values({ sourceId: existing.sourceId!, versionNo, body: p.body, contentHash: p.contentHash, importJobId: existing.id });
      await tx.update(schema.sources).set({ body: p.body, sourceTime: p.sourceTime }).where(eq(schema.sources.id, existing.sourceId!));
      await tx.update(schema.importJobs).set({ status: "UEBERNOMMEN", warnings: p.warnings, scopeSummary: p.scopeSummary, updatedAt: new Date(), version: existing.version + 1 }).where(eq(schema.importJobs.id, existing.id));
      await recordAudit(tx, actor, "import.reimported", "IMPORT", existing.id, { versionNo });
    });
    return { job: existing, sourceId: existing.sourceId, repeated: false, newVersion: true, structured: null as null | Awaited<ReturnType<typeof structureText>> };
  }

  const { job, sourceId } = await db.transaction(async (tx) => {
    const [source] = await tx
      .insert(schema.sources)
      .values({
        workspaceId: actor.workspaceId,
        setupId: ctx.setup.id,
        type: p.sourceType,
        title: p.title,
        body: p.body,
        origin: p.origin,
        externalKey: p.externalKey,
        sourceTime: p.sourceTime,
        ownerUserId: actor.userId,
        accessClass: p.accessClass,
      })
      .returning();
    if (!source) throw new Error("Quelle konnte nicht angelegt werden");
    const [job] = await tx
      .insert(schema.importJobs)
      .values({
        workspaceId: actor.workspaceId,
        actorUserId: actor.userId,
        kind: p.kind,
        connectionId: p.connectionId ?? null,
        externalKey: p.externalKey,
        title: p.title,
        setupId: ctx.setup.id,
        accountId: ctx.account.id,
        accessClass: p.accessClass,
        sourceId: source.id,
        status: "UEBERNOMMEN",
        scopeSummary: p.scopeSummary,
        warnings: p.warnings,
      })
      .returning();
    if (!job) throw new Error("Importauftrag konnte nicht angelegt werden");
    await tx.insert(schema.sourceVersions).values({ sourceId: source.id, versionNo: 1, body: p.body, contentHash: p.contentHash, importJobId: job.id });
    // Prüfliste für unsichere Personenzuordnungen (keine automatische Zusammenführung)
    for (const m of p.mentioned) {
      const unique = m.candidates.length === 1 && !!m.email; // eindeutig nur per E-Mail
      if (unique) continue;
      await tx.insert(schema.mergeReviewItems).values({ workspaceId: actor.workspaceId, importJobId: job.id, mentionedName: m.name, mentionedEmail: m.email ?? null, candidatePersonIds: m.candidates.map((c) => c.id) });
    }
    await recordAudit(tx, actor, "import.taken_over", "IMPORT", job.id, { kind: p.kind, accessClass: p.accessClass, warnings: p.warnings.length });
    return { job, sourceId: source.id };
  });

  let structured: Awaited<ReturnType<typeof structureText>> | null = null;
  if (p.structure) {
    try {
      structured = await structureText(actor, ctx, { text: p.body, dedupeScope: job.id, sourceIds: [sourceId], trigger: `Import „${p.title}“`, participantUserIds: p.participantsForAi });
      const [updated] = await db.update(schema.importJobs).set({ status: "AUSGEWERTET", aiJobId: structured.job.id, updatedAt: new Date() }).where(eq(schema.importJobs.id, job.id)).returning();
      if (updated) Object.assign(job, updated);
    } catch (e) {
      // KI nicht verfügbar oder abgelehnt: Import bleibt „übernommen“, kein Teilstand als ausgewertet (17.5)
      await db.update(schema.importJobs).set({ error: e instanceof Error ? e.message.slice(0, 300) : "Auswertung fehlgeschlagen", updatedAt: new Date() }).where(eq(schema.importJobs.id, job.id));
    }
  }
  return { job, sourceId, repeated: false, newVersion: false, structured };
}

// ---------------------------------------------------------------------------
// Prüfliste, Bestätigung, Listen
// ---------------------------------------------------------------------------

export const decideMergeInput = z.object({ itemId: z.string().min(1), decision: z.enum(["ZUSAMMENGEFUEHRT", "NEUE_PERSON", "IGNORIERT"]), personId: z.string().optional().or(z.literal("")) });

export async function decideMerge(actor: Actor, raw: unknown) {
  const parsed = decideMergeInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  const item = await db.query.mergeReviewItems.findFirst({ where: and(eq(schema.mergeReviewItems.id, input.itemId), eq(schema.mergeReviewItems.workspaceId, actor.workspaceId)) });
  if (!item) throw new NotFoundError("Prüfeintrag");
  const job = await db.query.importJobs.findFirst({ where: eq(schema.importJobs.id, item.importJobId) });
  if (!job || !job.setupId) throw new NotFoundError("Import");
  const ctx = await requireEditableCtx(actor, job.setupId);
  if (item.status !== "OFFEN") throw new TransitionError("Dieser Prüfeintrag ist bereits entschieden.");
  let personId: string | null = null;
  if (input.decision === "ZUSAMMENGEFUEHRT") {
    if (!input.personId || !item.candidatePersonIds.includes(input.personId)) throw new ValidationError("Bitte eine der vorgeschlagenen Personen wählen.");
    personId = input.personId;
  }
  if (input.decision === "NEUE_PERSON") {
    const [p] = await db.insert(schema.persons).values({ workspaceId: actor.workspaceId, accountId: ctx.account.id, displayName: item.mentionedName, email: item.mentionedEmail, createdBy: actor.userId }).returning();
    personId = p?.id ?? null;
    if (personId) await db.insert(schema.relationships).values({ personId, holderUserId: actor.userId, setupId: ctx.setup.id, state: "NAME_FUNKTION_BEKANNT", contextNote: `Aus Import „${job.title}“ – noch kein persönlicher Kontakt dokumentiert.`, evidenceSourceId: job.sourceId, createdBy: actor.userId });
  }
  return db.transaction(async (tx) => {
    await tx.update(schema.mergeReviewItems).set({ status: input.decision, decidedPersonId: personId, decidedBy: actor.userId, decidedAt: new Date() }).where(eq(schema.mergeReviewItems.id, item.id));
    await recordAudit(tx, actor, "import.merge_decided", "IMPORT", job.id, { decision: input.decision });
  });
}

export const confirmImportInput = z.object({ importJobId: z.string().min(1), version: z.coerce.number().int().positive() });

/** Schritt 7/8: Import bestätigen – Ergänzungen sind geprüft (offene Vorschläge dürfen bleiben), Prüfliste ist abgearbeitet. */
export async function confirmImport(actor: Actor, raw: unknown) {
  const parsed = confirmImportInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  const job = await db.query.importJobs.findFirst({ where: and(eq(schema.importJobs.id, input.importJobId), eq(schema.importJobs.workspaceId, actor.workspaceId)) });
  if (!job || !job.setupId) throw new NotFoundError("Import");
  await requireEditableCtx(actor, job.setupId);
  if (job.status === "BESTAETIGT") throw new TransitionError("Import ist bereits bestätigt.");
  const open = await db.query.mergeReviewItems.findMany({ where: and(eq(schema.mergeReviewItems.importJobId, job.id), eq(schema.mergeReviewItems.status, "OFFEN")) });
  if (open.length) throw new ValidationError(`Bitte zuerst ${open.length} unklare Personenzuordnung(en) entscheiden.`);
  return db.transaction(async (tx) => {
    const [u] = await tx.update(schema.importJobs).set({ status: "BESTAETIGT", updatedAt: new Date(), version: input.version + 1 }).where(and(eq(schema.importJobs.id, job.id), eq(schema.importJobs.version, input.version))).returning();
    if (!u) throw new ConflictError();
    await recordAudit(tx, actor, "import.confirmed", "IMPORT", job.id);
    return u;
  });
}

export async function listMyImports(actor: Actor) {
  const rows = await db.query.importJobs.findMany({ where: and(eq(schema.importJobs.workspaceId, actor.workspaceId), or(eq(schema.importJobs.actorUserId, actor.userId))), orderBy: desc(schema.importJobs.createdAt) });
  const jobIds = rows.map((r) => r.id);
  const items = jobIds.length ? await db.query.mergeReviewItems.findMany({ where: inArray(schema.mergeReviewItems.importJobId, jobIds) }) : [];
  const setupIds = [...new Set(rows.map((r) => r.setupId).filter((x): x is string => !!x))];
  const setups = setupIds.length ? await db.query.projectSetups.findMany({ where: inArray(schema.projectSetups.id, setupIds) }) : [];
  const personIds = [...new Set(items.flatMap((i) => i.candidatePersonIds))];
  const persons = personIds.length ? await db.query.persons.findMany({ where: inArray(schema.persons.id, personIds) }) : [];
  const pn = new Map(persons.map((p) => [p.id, p.displayName]));
  const sn = new Map(setups.map((s) => [s.id, s.name]));
  return rows.map((r) => ({
    ...r,
    setupName: r.setupId ? sn.get(r.setupId) ?? "" : "",
    mergeItems: items.filter((i) => i.importJobId === r.id).map((i) => ({ ...i, candidates: i.candidatePersonIds.map((id) => ({ id, displayName: pn.get(id) ?? "?" })) })),
  }));
}
