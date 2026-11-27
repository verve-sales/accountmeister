import { createHash } from "node:crypto";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db/client";
import { getConfig } from "@/lib/config";
import { ConflictError, ForbiddenError, NotFoundError, TransitionError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import { hasRole, type Actor } from "@/modules/identity/actor";
import { canViewAccount } from "@/modules/identity/authz";
import { todayIso } from "@/modules/work/calendar";
import { canonicalMime, extensionOf, extractDocumentText } from "@/modules/documents/extract";
import { readStoredFile, relativePathFor, storeFile } from "@/modules/documents/storage";
import type { ParsedDoc } from "./parse";
import { openPoints, plan, type CaseFacts, type PlanStep } from "./plan";

/**
 * Auftragseingang (e67, Konzept Offer-to-Order v2): Angebote und Bestellungen werden im Assignmentmanager hochgeladen
 * (oder ein Angebot ohne Dokument erfasst). Die App liest vor, die Person bestätigt, dann entstehen Chance, Angebot,
 * Auftrag, Einsatz und Unterlagen. Moco wird als Soll-Zustand geplant (Probelauf), SharePoint wird beschrieben, wenn
 * die Anbindung eingerichtet ist. Beim Vermittler darf der Endkunde offen bleiben und wird später nachgezogen.
 */

export type CaseRow = typeof schema.orderCases.$inferSelect;
export const caseStatusLabel: Record<string, string> = { ENTWURF: "zu bestätigen", ANGEBOT_VERSENDET: "Angebot versendet", BEAUFTRAGT: "beauftragt", ABGESAGT: "abgesagt", STORNIERT: "storniert" };
export const channelLabel: Record<string, string> = { DIREKT: "direkt", VERMITTLER: "über Vermittler" };

export async function canUseOrderIntake(actor: Actor): Promise<boolean> {
  if (hasRole(actor, "BD") || hasRole(actor, "PRINCIPAL")) return true;
  const { canUseAssignments } = await import("@/modules/assignments/service");
  return canUseAssignments(actor);
}

async function requireIntake(actor: Actor) {
  if (!(await canUseOrderIntake(actor))) throw new ForbiddenError("Angebote und Bestellungen laden BD, Principal, Sales Operations, Backoffice und Geschäftsführung hoch.");
}

/** Sales Operations, Backoffice, GF und Admin sehen alle Vorgänge; BD und Principal die ihrer Kunden und ihre eigenen. */
async function seesAll(actor: Actor): Promise<boolean> {
  const { canUseAssignments } = await import("@/modules/assignments/service");
  return canUseAssignments(actor);
}

async function canSeeCase(actor: Actor, c: CaseRow): Promise<boolean> {
  if (c.workspaceId !== actor.workspaceId) return false;
  if (c.createdBy === actor.userId || (await seesAll(actor))) return true;
  const ids = [c.partnerAccountId, c.endCustomerAccountId].filter((x): x is string => !!x);
  if (!ids.length) return false;
  const accs = await db.query.accounts.findMany({ where: inArray(schema.accounts.id, ids) });
  return accs.some((a) => canViewAccount(actor, a));
}

export async function requireCase(actor: Actor, id: string): Promise<CaseRow> {
  const c = await db.query.orderCases.findFirst({ where: and(eq(schema.orderCases.id, id), eq(schema.orderCases.workspaceId, actor.workspaceId)) });
  if (!c || !(await canSeeCase(actor, c))) throw new NotFoundError("Vorgang");
  return c;
}

async function nextNumber(workspaceId: string): Promise<string> {
  const year = todayIso().slice(0, 4);
  const rows = await db.query.orderCases.findMany({ where: eq(schema.orderCases.workspaceId, workspaceId), columns: { number: true } });
  const max = rows.map((r) => /^VG-(\d{4})-(\d+)$/.exec(r.number)).filter((m) => m && m[1] === year).reduce((n, m) => Math.max(n, Number(m![2])), 0);
  return `VG-${year}-${String(max + 1).padStart(4, "0")}`;
}

async function insertCase(actor: Actor, values: Omit<typeof schema.orderCases.$inferInsert, "workspaceId" | "number" | "createdBy">): Promise<CaseRow> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const number = await nextNumber(actor.workspaceId);
    const rows = await db.insert(schema.orderCases).values({ ...values, workspaceId: actor.workspaceId, number, createdBy: actor.userId }).onConflictDoNothing().returning();
    if (rows[0]) return rows[0];
  }
  throw new ConflictError("Vorgangsnummer konnte nicht vergeben werden – bitte erneut versuchen.");
}

// ---------------------------------------------------------------------------
// Datei ablegen und vorlesen
// ---------------------------------------------------------------------------

export type UploadedFile = { name: string; type: string; size: number; arrayBuffer: () => Promise<ArrayBuffer> };

/** Datei als persönliche Quelle ablegen; sie wird einem Setup zugeordnet, sobald der Vorgang bestätigt ist. */
async function storeUpload(actor: Actor, file: UploadedFile) {
  const cfg = getConfig();
  if (!file || file.size === 0) throw new ValidationError("Bitte eine Datei auswählen.");
  if (file.size > cfg.MAX_UPLOAD_MB * 1024 * 1024) throw new ValidationError(`Die Datei ist größer als ${cfg.MAX_UPLOAD_MB} MB.`);
  const ext = extensionOf(file.name);
  if (!ext) throw new ValidationError("Dateityp nicht unterstützt. Möglich sind PDF, Word (.docx), Excel (.xlsx), Text und E-Mail (.eml).");
  const buf = Buffer.from(await file.arrayBuffer());
  const extract = await extractDocumentText(buf, ext);
  if (extract.status === "FEHLER") throw new ValidationError(extract.note ?? "Die Datei konnte nicht gelesen werden.");
  const title = file.name.replace(/\.[a-z0-9]+$/i, "").slice(0, 200) || "Dokument";
  const { sourceId, documentId, rel } = await db.transaction(async (tx) => {
    const [source] = await tx.insert(schema.sources).values({ workspaceId: actor.workspaceId, setupId: null, type: "DOKUMENT", title, body: extract.text || null, origin: `Auftragseingang ${file.name}`, sourceTime: new Date(), ownerUserId: actor.userId, accessClass: "PERSOENLICH" }).returning();
    await tx.insert(schema.sourceVersions).values({ sourceId: source!.id, versionNo: 1, body: extract.text || null, contentHash: createHash("sha256").update(extract.text).digest("hex") });
    const [doc] = await tx
      .insert(schema.documents)
      .values({ workspaceId: actor.workspaceId, sourceId: source!.id, fileName: file.name.slice(0, 255), mimeType: canonicalMime(ext), sizeBytes: file.size, sha256: createHash("sha256").update(buf).digest("hex"), storagePath: null, extractStatus: extract.status, extractNote: extract.note, pageCount: extract.pageCount, uploadedBy: actor.userId })
      .returning();
    const rel = relativePathFor(actor.workspaceId, doc!.id, ext);
    await tx.update(schema.documents).set({ storagePath: rel }).where(eq(schema.documents.id, doc!.id));
    await recordAudit(tx, actor, "document.uploaded", "SOURCE", source!.id, { auftragseingang: true, sizeBytes: file.size, extractStatus: extract.status });
    return { sourceId: source!.id, documentId: doc!.id, rel };
  });
  try {
    await storeFile(rel, buf);
  } catch (e) {
    await db.update(schema.documents).set({ storagePath: null, extractNote: `Datei konnte nicht abgelegt werden: ${e instanceof Error ? e.message.slice(0, 120) : "Fehler"}` }).where(eq(schema.documents.id, documentId));
  }
  return { sourceId, documentId, text: extract.text, extractStatus: extract.status, fileName: file.name, title };
}

/** Namen von Freelancern und internen Personen für die Personenerkennung. */
async function knownPersons(workspaceId: string) {
  const [fls, users] = await Promise.all([
    db.query.freelancers.findMany({ where: eq(schema.freelancers.workspaceId, workspaceId), columns: { id: true, displayName: true, mergedIntoId: true } }),
    db.query.users.findMany({ where: and(eq(schema.users.workspaceId, workspaceId), eq(schema.users.status, "ACTIVE")), columns: { id: true, displayName: true } }),
  ]);
  return { freelancers: fls.filter((f) => !f.mergedIntoId), users };
}

const normName = (n: string) => n.toLocaleLowerCase("de").replace(/\(.*?\)/g, " ").replace(/\b(gmbh|ag|eg|se|kg|mbh|co|e\.?v\.?|deutschland|germany)\b/g, " ").replace(/[^a-z0-9äöüß]+/g, " ").trim();

/** Kunde zu einem Namen: exakter Treffer nach Normalisierung, sonst ein eindeutiger Treffer über das erste Wort. */
async function findAccountByName(actor: Actor, name: string) {
  const n = normName(name);
  if (n.length < 2) return null;
  const all = await db.query.accounts.findMany({ where: and(eq(schema.accounts.workspaceId, actor.workspaceId), inArray(schema.accounts.status, ["ACTIVE", "DORMANT"])) });
  const exact = all.filter((a) => normName(a.name) === n || a.aliases.some((x) => normName(x) === n));
  if (exact.length === 1) return exact[0]!;
  const first = n.split(" ")[0]!;
  const loose = first.length >= 4 ? all.filter((a) => normName(a.name).split(" ").includes(first)) : [];
  return loose.length === 1 ? loose[0]! : null;
}

export type Suggestion = {
  parsed: ParsedDoc;
  partnerAccountId: string | null;
  partnerReason: string | null;
  endCustomerAccountId: string | null;
  personKind: "FREELANCER" | "INTERN" | null;
  personId: string | null;
  /** passender offener Vorgang (Bestellung zum Angebot) und laufender Einsatz derselben Person (Verlängerung) */
  matchCaseId: string | null;
  matchReason: string | null;
  renewalEngagementId: string | null;
  sourceId: string | null;
  fileName: string | null;
  extractStatus: string | null;
  /** wie gelesen wurde: KI (mit Modell) oder Regeln */
  readMode?: "KI" | "REGELN";
  readNote?: string;
};

/** Hochladen: Datei ablegen, vorlesen, Kunde, Person und passenden Vorgang vorschlagen; der Vorgang steht dann „zu bestätigen“. */
export async function uploadForCase(actor: Actor, file: UploadedFile, opts: { forCaseId?: string } = {}): Promise<CaseRow> {
  await requireIntake(actor);
  const base = opts.forCaseId ? await requireCase(actor, opts.forCaseId) : null;
  // B8: dieselbe Datei nicht zweimal – ein offener Entwurf wird wieder geöffnet, ein bestätigter Vorgang genannt
  if (file && file.size > 0) {
    const sha = createHash("sha256").update(Buffer.from(await file.arrayBuffer())).digest("hex");
    const same = await db.query.documents.findMany({ where: and(eq(schema.documents.workspaceId, actor.workspaceId), eq(schema.documents.sha256, sha)), columns: { sourceId: true } });
    if (same.length) {
      const srcIds = new Set(same.map((d) => d.sourceId));
      const cases = await db.query.orderCases.findMany({ where: and(eq(schema.orderCases.workspaceId, actor.workspaceId), inArray(schema.orderCases.status, ["ENTWURF", "ANGEBOT_VERSENDET", "BEAUFTRAGT"])) });
      const hit = cases.find((c) => srcIds.has(String((c.parsed as { sourceId?: string } | null)?.sourceId ?? "")));
      if (hit?.status === "ENTWURF" && hit.createdBy === actor.userId) return hit;
      if (hit) throw new ConflictError(`Diese Datei ist bereits als ${hit.number} erfasst.`);
    }
  }
  const up = await storeUpload(actor, file);
  const persons = await knownPersons(actor.workspaceId);
  const accountNames = (await db.query.accounts.findMany({ where: and(eq(schema.accounts.workspaceId, actor.workspaceId), inArray(schema.accounts.status, ["ACTIVE", "DORMANT"])), columns: { name: true } })).map((a) => a.name);
  const { readDocument } = await import("./ai");
  const read = await readDocument(actor, { text: up.text, fileName: up.fileName, knownPersons: [...persons.freelancers.map((f) => f.displayName), ...persons.users.map((u) => u.displayName)], knownAccounts: accountNames });
  const parsed = read.parsed;
  // Vertragspartner: zuerst die Vertragspartei laut Dokument (bekannt → Kunde, unbekannt → als neuer Name vorbelegt);
  // nur wenn das Dokument keine nennt, die allgemeine Erkennung (Kennung, Domäne, Name) – ohne den genannten Endkunden
  let partnerAccountId: string | null = base?.partnerAccountId ?? null;
  let partnerReason: string | null = base ? "vom Vorgang" : null;
  if (!partnerAccountId && parsed.sender) {
    const senderAcc = await findAccountByName(actor, parsed.sender.value);
    if (senderAcc) {
      partnerAccountId = senderAcc.id;
      partnerReason = `Vertragspartei „${parsed.sender.value}“ im Dokument`;
    } else partnerReason = `Vertragspartei „${parsed.sender.value}“ ist noch nicht angelegt – wird beim Bestätigen neu angelegt`;
  }
  if (!partnerAccountId && !parsed.sender && up.text) {
    const { routeText } = await import("@/modules/eingang/service");
    const withoutEnd = parsed.endCustomer ? up.text.split(parsed.endCustomer.value).join(" ") : up.text;
    const r = await routeText(actor, withoutEnd.slice(0, 20000)).catch(() => null);
    if (r?.account) {
      partnerAccountId = r.account.id;
      partnerReason = r.reason;
    }
  }
  const endCustomer = base?.endCustomerAccountId ? { id: base.endCustomerAccountId } : parsed.endCustomer ? await findAccountByName(actor, parsed.endCustomer.value) : null;
  if (endCustomer && partnerAccountId === endCustomer.id && !base) {
    partnerAccountId = null;
    partnerReason = null;
  }
  const partner = partnerAccountId ? await db.query.accounts.findFirst({ where: eq(schema.accounts.id, partnerAccountId) }) : null;
  const fl = parsed.person ? persons.freelancers.find((f) => f.displayName === parsed.person!.value) : null;
  const us = parsed.person && !fl ? persons.users.find((u) => u.displayName === parsed.person!.value) : null;
  const sug: Suggestion = {
    parsed,
    partnerAccountId,
    partnerReason,
    endCustomerAccountId: endCustomer?.id ?? null,
    personKind: fl ? "FREELANCER" : us ? "INTERN" : null,
    personId: fl?.id ?? us?.id ?? null,
    matchCaseId: base?.id ?? null,
    matchReason: base ? "Upload am Vorgang" : null,
    renewalEngagementId: null,
    sourceId: up.sourceId,
    fileName: up.fileName,
    extractStatus: up.extractStatus,
    readMode: read.mode,
    readNote: read.note,
  };
  if (!base && parsed.kind?.value === "BESTELLUNG") {
    const m = await matchOpenCase(actor, { offerNumber: parsed.offerNumber?.value ?? null, brokerRef: parsed.brokerRef?.value ?? null, partnerAccountId, freelancerId: fl?.id ?? null, internalUserId: us?.id ?? null });
    if (m) {
      sug.matchCaseId = m.case.id;
      sug.matchReason = m.reason;
    }
  }
  // Verlängerung: dieselbe Person läuft schon beim Vertragspartner bzw. Endkunden
  if (fl || us) {
    const accIds = [partnerAccountId, endCustomer?.id ?? null, base?.endCustomerAccountId ?? null].filter((x): x is string => !!x);
    if (accIds.length) {
      const running = await db.query.engagements.findMany({ where: and(inArray(schema.engagements.accountId, accIds), inArray(schema.engagements.status, ["GEPLANT", "AKTIV", "PAUSIERT", "ENDET"]), fl ? eq(schema.engagements.freelancerId, fl.id) : eq(schema.engagements.internalUserId, us!.id)) });
      if (running.length === 1 && !sug.matchCaseId) sug.renewalEngagementId = running[0]!.id;
    }
  }
  // Vermittler: als solcher geführt, laut KI ein Vermittler, oder das Dokument nennt einen Endkunden neben dem Vertragspartner
  const channel = partner?.accountKind === "VERMITTLER" || parsed.intermediary?.value === true || (!base && parsed.endCustomer && parsed.endCustomer.value !== parsed.sender?.value) ? "VERMITTLER" : base?.channel ?? "DIREKT";
  const c = await insertCase(actor, {
    channel,
    status: "ENTWURF",
    partnerAccountId,
    endCustomerAccountId: sug.endCustomerAccountId,
    endCustomerHint: parsed.endCustomer?.value ?? null,
    personName: parsed.person?.value ?? base?.personName ?? null,
    freelancerId: fl?.id ?? null,
    internalUserId: us?.id ?? null,
    role: parsed.role?.value ?? base?.role ?? null,
    startDate: parsed.start?.value ?? null,
    endDate: parsed.end?.value ?? null,
    dailyRate: parsed.dailyRate ? String(parsed.dailyRate.value) : base?.dailyRate ?? null,
    days: parsed.days?.value ?? null,
    offerNumber: parsed.offerNumber?.value ?? base?.offerNumber ?? null,
    brokerRef: parsed.brokerRef?.value ?? base?.brokerRef ?? null,
    orderNumber: parsed.orderNumber?.value ?? null,
    parsed: sug as unknown as Record<string, unknown>,
  });
  await recordAudit(db, actor, "order_case.uploaded", "ORDER_CASE", c.id, { datei: up.fileName, art: parsed.kind?.value ?? null, vorgang: sug.matchCaseId });
  return c;
}

/** Zuordnung einer Bestellung zum Angebot: Moco-Angebotsnummer, Vermittler-Referenz oder Person beim selben Vertragspartner. */
export async function matchOpenCase(actor: Actor, k: { offerNumber: string | null; brokerRef: string | null; partnerAccountId: string | null; freelancerId: string | null; internalUserId: string | null }): Promise<{ case: CaseRow; reason: string } | null> {
  const open = await db.query.orderCases.findMany({ where: and(eq(schema.orderCases.workspaceId, actor.workspaceId), eq(schema.orderCases.status, "ANGEBOT_VERSENDET")) });
  if (k.offerNumber) {
    const m = open.filter((c) => c.offerNumber && c.offerNumber.toLowerCase() === k.offerNumber!.toLowerCase());
    if (m.length === 1) return { case: m[0]!, reason: `Angebotsnummer ${k.offerNumber}` };
  }
  if (k.brokerRef) {
    const m = open.filter((c) => c.brokerRef && c.brokerRef.toLowerCase() === k.brokerRef!.toLowerCase() && (!k.partnerAccountId || c.partnerAccountId === k.partnerAccountId));
    if (m.length === 1) return { case: m[0]!, reason: `Referenz ${k.brokerRef}` };
  }
  if (k.freelancerId || k.internalUserId) {
    const m = open.filter((c) => (k.freelancerId ? c.freelancerId === k.freelancerId : c.internalUserId === k.internalUserId) && (!k.partnerAccountId || c.partnerAccountId === k.partnerAccountId));
    if (m.length === 1) return { case: m[0]!, reason: "dieselbe Person beim selben Vertragspartner" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Bestätigen
// ---------------------------------------------------------------------------

const opt = (n: number) => z.string().trim().max(n).optional().default("");
const dateOpt = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).or(z.literal("")).optional().default("");

export const confirmInput = z.object({
  kind: z.enum(["ANGEBOT", "BESTELLUNG"]),
  channel: z.enum(["DIREKT", "VERMITTLER"]),
  partnerAccountId: opt(100),
  partnerNewName: opt(200),
  endCustomerAccountId: opt(100),
  endCustomerNewName: opt(200),
  endCustomerHint: opt(200),
  personKind: z.enum(["FREELANCER", "INTERN", ""]).optional().default(""),
  freelancerId: opt(100),
  internalUserId: opt(100),
  personNewName: opt(200),
  role: opt(200),
  startDate: dateOpt,
  endDate: dateOpt,
  dailyRate: z.string().trim().regex(/^(\d{1,5}([.,]\d{1,2})?)?$/, "Tagessatz bitte als Zahl, z. B. 960 oder 960,50").optional().default(""),
  days: z.string().trim().regex(/^\d{0,4}$/, "Tage bitte als ganze Zahl").optional().default(""),
  offerNumber: opt(100),
  brokerRef: opt(100),
  orderNumber: opt(100),
  /** Bestellung gehört zu diesem Vorgang (Angebot) */
  matchCaseId: opt(100),
  /** Bestellung verlängert diesen laufenden Einsatz */
  renewalEngagementId: opt(100),
  /** verantwortlicher BD, wenn der Kunde noch keinen hat */
  bdUserId: opt(100),
  /** Abweichungen zum Angebot bewusst bestätigt (B7) */
  deviationsOk: z.union([z.literal("on"), z.literal("true"), z.literal("")]).optional().default(""),
  note: opt(1000),
});
export type ConfirmInput = z.infer<typeof confirmInput>;

async function ensureAccount(actor: Actor, id: string, newName: string, kind: "KUNDE" | "VERMITTLER"): Promise<typeof schema.accounts.$inferSelect | null> {
  if (id) {
    const a = await db.query.accounts.findFirst({ where: and(eq(schema.accounts.id, id), eq(schema.accounts.workspaceId, actor.workspaceId)) });
    if (!a) throw new NotFoundError("Kunde");
    return a;
  }
  if (!newName) return null;
  // R3: nie still eine Dublette anlegen – ein gleichnamiger Kunde wird genommen
  const existing = await findAccountByName(actor, newName);
  if (existing) return existing;
  const { createAccount } = await import("@/modules/accounts/service");
  const a = await createAccount(actor, { name: newName, orgType: "SONSTIGE", responsibleBdUserId: hasRole(actor, "BD") ? actor.userId : null });
  if (kind === "VERMITTLER") await db.update(schema.accounts).set({ accountKind: "VERMITTLER", procurementChannel: "VERMITTLER" }).where(eq(schema.accounts.id, a.id));
  return (await db.query.accounts.findFirst({ where: eq(schema.accounts.id, a.id) }))!;
}

/**
 * Verantwortlich für Chance und Einsatz: der BD des Kunden, sonst der des Vertragspartners, sonst die gewählte Person,
 * sonst wer hochlädt (wenn BD oder Principal). Hat der Kunde noch keinen BD, wird die gewählte Person dort eingetragen.
 */
async function ownerFor(actor: Actor, target: typeof schema.accounts.$inferSelect, i: ConfirmInput): Promise<string> {
  if (target.responsibleBdUserId) return target.responsibleBdUserId;
  const partner = i.partnerAccountId ? await db.query.accounts.findFirst({ where: eq(schema.accounts.id, i.partnerAccountId), columns: { responsibleBdUserId: true } }) : null;
  const pick = i.bdUserId || partner?.responsibleBdUserId || (hasRole(actor, "BD") || hasRole(actor, "PRINCIPAL") ? actor.userId : "");
  if (!pick) throw new ValidationError(`Für ${target.name} ist noch kein BD hinterlegt – bitte im Formular „Verantwortlicher BD“ wählen.`);
  const u = await db.query.users.findFirst({ where: and(eq(schema.users.id, pick), eq(schema.users.workspaceId, actor.workspaceId)) });
  if (!u) throw new NotFoundError("BD");
  await db.update(schema.accounts).set({ responsibleBdUserId: u.id, updatedAt: new Date() }).where(and(eq(schema.accounts.id, target.id), eq(schema.accounts.workspaceId, actor.workspaceId)));
  const has = await db.query.roleAssignments.findFirst({ where: and(eq(schema.roleAssignments.userId, u.id), eq(schema.roleAssignments.accountId, target.id), eq(schema.roleAssignments.role, "BD")) });
  if (!has) await db.insert(schema.roleAssignments).values({ workspaceId: actor.workspaceId, userId: u.id, role: "BD", scope: "ACCOUNT", accountId: target.id });
  return u.id;
}

/** Setup als Gruppierung: das jüngste offene Setup des Kunden, sonst „Allgemein“. */
async function ensureSetup(actor: Actor, account: typeof schema.accounts.$inferSelect): Promise<string> {
  const setups = (await db.query.projectSetups.findMany({ where: eq(schema.projectSetups.accountId, account.id), orderBy: desc(schema.projectSetups.updatedAt) })).filter((s) => s.status !== "ARCHIVIERT");
  const general = setups.find((s) => s.name === "Allgemein") ?? setups[0];
  if (general) return general.id;
  const { createSetup } = await import("@/modules/setups/service");
  const s = await createSetup(actor, { accountId: account.id, name: "Allgemein", contextNote: "Angelegt aus dem Auftragseingang.", bdUserId: account.responsibleBdUserId ?? (hasRole(actor, "BD") ? actor.userId : null) });
  return s.id;
}

async function resolvePersonFields(actor: Actor, i: ConfirmInput) {
  if (i.personKind === "INTERN" && i.internalUserId) {
    const u = await db.query.users.findFirst({ where: and(eq(schema.users.id, i.internalUserId), eq(schema.users.workspaceId, actor.workspaceId)) });
    if (!u) throw new NotFoundError("Person");
    return { personName: u.displayName, freelancerId: null, internalUserId: u.id };
  }
  if (i.personKind === "FREELANCER" && i.freelancerId) {
    const f = await db.query.freelancers.findFirst({ where: and(eq(schema.freelancers.id, i.freelancerId), eq(schema.freelancers.workspaceId, actor.workspaceId)) });
    if (!f) throw new NotFoundError("Freelancer");
    return { personName: f.displayName, freelancerId: f.id, internalUserId: null };
  }
  return { personName: i.personNewName || null, freelancerId: null, internalUserId: null };
}

/** Datei des Vorgangs als Unterlage beim richtigen Kunden; Quelle dem Setup zuordnen; SharePoint, falls eingerichtet. */
async function attachFile(actor: Actor, c: CaseRow, kind: "ANGEBOT" | "BESTELLUNG", accountId: string, setupId: string, engagementId: string | null, title: string): Promise<{ documentId: string; sharepoint: { state: string; note: string | null; link: string | null } } | null> {
  const sug = (c.parsed ?? {}) as Partial<Suggestion>;
  if (!sug.sourceId) return null;
  const src = await db.query.sources.findFirst({ where: eq(schema.sources.id, sug.sourceId) });
  if (src && !src.setupId) await db.update(schema.sources).set({ setupId, accessClass: "ACCOUNT_TEAM" }).where(eq(schema.sources.id, src.id));
  const [d] = await db
    .insert(schema.contractDocuments)
    .values({ workspaceId: actor.workspaceId, accountId, side: "KUNDE", docType: kind, title, signedStatus: kind === "BESTELLUNG" ? "UNTERSCHRIEBEN" : "VERSENDET", sourceId: sug.sourceId, reference: kind === "BESTELLUNG" ? c.orderNumber : c.offerNumber, validFrom: c.startDate, validTo: c.endDate, reviewNote: `Auftragseingang ${c.number}`, reviewedBy: actor.userId, reviewedAt: new Date(), createdBy: actor.userId })
    .returning();
  await db.insert(schema.orderCaseDocuments).values({ caseId: c.id, documentId: d!.id, kind }).onConflictDoNothing();
  if (engagementId) await db.insert(schema.engagementDocuments).values({ engagementId, documentId: d!.id }).onConflictDoNothing();
  let sharepoint: { state: string; note: string | null; link: string | null } = { state: "AUS", note: "SharePoint ist nicht eingerichtet.", link: null };
  try {
    const file = await db.query.documents.findFirst({ where: eq(schema.documents.sourceId, sug.sourceId) });
    if (file?.storagePath) {
      const bytes = await readStoredFile(file.storagePath);
      const { fileDocument } = await import("@/modules/sharepoint/documents");
      const sp = await fileDocument(d!.id, file.fileName, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
      if (sp) sharepoint = { state: "ABGELEGT", note: null, link: sp.webUrl };
    }
  } catch (err) {
    sharepoint = { state: "FEHLER", note: (err as Error).message.slice(0, 200), link: null };
  }
  return { documentId: d!.id, sharepoint };
}

async function facts(c: CaseRow): Promise<CaseFacts> {
  const ids = [c.partnerAccountId, c.endCustomerAccountId].filter((x): x is string => !!x);
  const accs = ids.length ? await db.query.accounts.findMany({ where: inArray(schema.accounts.id, ids), columns: { id: true, name: true, responsibleBdUserId: true } }) : [];
  const an = new Map(accs.map((a) => [a.id, a]));
  const target = an.get(c.endCustomerAccountId ?? "") ?? an.get(c.partnerAccountId ?? "");
  const bd = target?.responsibleBdUserId ? await db.query.users.findFirst({ where: eq(schema.users.id, target.responsibleBdUserId), columns: { displayName: true } }) : null;
  return {
    channel: c.channel === "VERMITTLER" ? "VERMITTLER" : "DIREKT",
    status: c.status,
    partnerName: an.get(c.partnerAccountId ?? "")?.name ?? null,
    endCustomerName: an.get(c.endCustomerAccountId ?? "")?.name ?? (c.channel === "DIREKT" ? an.get(c.partnerAccountId ?? "")?.name ?? null : null),
    personName: c.personName,
    role: c.role,
    startDate: c.startDate,
    endDate: c.endDate,
    dailyRate: c.dailyRate != null ? Number(c.dailyRate) : null,
    days: c.days,
    offerNumber: c.offerNumber,
    brokerRef: c.brokerRef,
    orderNumber: c.orderNumber,
    isRenewal: c.isRenewal,
    bdName: bd?.displayName ?? null,
  };
}

type Systems = { moco: { mode: "PROBELAUF"; steps: PlanStep[] }; sharepoint: { state: string; note: string | null; link: string | null }; accountmeister: { state: string } };

async function refreshSystems(c: CaseRow, sharepoint?: Systems["sharepoint"]): Promise<CaseRow> {
  const f = await facts(c);
  const prev = (c.systems ?? {}) as Partial<Systems>;
  const sp = sharepoint ?? prev.sharepoint ?? { state: "AUS", note: "SharePoint ist nicht eingerichtet.", link: null };
  const systems: Systems = {
    moco: { mode: "PROBELAUF", steps: plan(f).filter((s) => s.system === "MOCO") },
    sharepoint: sp.state === "AUS" || sp.state === "FEHLER" ? { ...sp, note: sp.note ?? plan(f).find((s) => s.system === "SHAREPOINT")?.detail ?? null } : sp,
    accountmeister: { state: c.status === "BEAUFTRAGT" ? (c.engagementId ? "ERLEDIGT" : "AUSSTEHEND") : c.opportunityId ? "ERLEDIGT" : "AUSSTEHEND" },
  };
  const [row] = await db.update(schema.orderCases).set({ systems: systems as unknown as Record<string, unknown>, updatedAt: new Date() }).where(eq(schema.orderCases.id, c.id)).returning();
  return row!;
}

/** Feld-für-Feld-Vergleich Bestellung ↔ Angebot (B7). */
export function deviations(offer: Pick<CaseRow, "dailyRate" | "startDate" | "endDate" | "days" | "freelancerId" | "internalUserId" | "personName">, order: { dailyRate: string | null; startDate: string | null; endDate: string | null; days: number | null; freelancerId: string | null; internalUserId: string | null; personName: string | null }): string[] {
  const out: string[] = [];
  const r1 = offer.dailyRate != null ? Number(offer.dailyRate) : null;
  const r2 = order.dailyRate != null ? Number(order.dailyRate) : null;
  if (r1 != null && r2 != null && Math.abs(r1 - r2) > 0.005) out.push(`Satz ${r1} € → ${r2} €${Math.abs(r2 - r1) / r1 > 0.2 ? " (mehr als 20 % Abweichung)" : ""}`);
  if (offer.startDate && order.startDate && offer.startDate !== order.startDate) out.push(`Start ${offer.startDate} → ${order.startDate}`);
  if (offer.endDate && order.endDate && offer.endDate !== order.endDate) out.push(`Ende ${offer.endDate} → ${order.endDate}`);
  if (offer.days && order.days && offer.days !== order.days) out.push(`Tage ${offer.days} → ${order.days}`);
  const p1 = offer.freelancerId ?? offer.internalUserId ?? offer.personName;
  const p2 = order.freelancerId ?? order.internalUserId ?? order.personName;
  if (p1 && p2 && p1 !== p2) out.push(`Person ${offer.personName ?? "?"} → ${order.personName ?? "?"}`);
  return out;
}

/** Plausibilität (R2): Ende vor Start, Laufzeit über 24 Monate. */
function plausibility(i: { startDate: string; endDate: string }) {
  if (i.startDate && i.endDate && i.endDate < i.startDate) throw new ValidationError("Das Ende liegt vor dem Start.");
  if (i.startDate && i.endDate) {
    const months = (Date.parse(i.endDate) - Date.parse(i.startDate)) / (30.4 * 86400000);
    if (months > 24) throw new ValidationError("Die Laufzeit ist länger als 24 Monate – bitte Datum prüfen.");
  }
}

export async function confirmCase(actor: Actor, caseId: string, raw: unknown): Promise<CaseRow> {
  await requireIntake(actor);
  const p = confirmInput.safeParse(raw);
  if (!p.success) throw new ValidationError(p.error.issues.map((x) => x.message).join("; "));
  const i = p.data;
  const draft = await requireCase(actor, caseId);
  if (draft.status !== "ENTWURF") throw new TransitionError("Dieser Vorgang ist bereits bestätigt.");
  plausibility(i);
  const partner = await ensureAccount(actor, i.partnerAccountId, i.partnerNewName, i.channel === "VERMITTLER" ? "VERMITTLER" : "KUNDE");
  if (!partner) throw new ValidationError(i.channel === "VERMITTLER" ? "Bitte den Vermittler wählen oder eintragen." : "Bitte den Kunden wählen oder eintragen.");
  const endCustomer = i.channel === "VERMITTLER" ? await ensureAccount(actor, i.endCustomerAccountId, i.endCustomerNewName, "KUNDE") : null;
  const person = await resolvePersonFields(actor, i);
  const rate = i.dailyRate ? i.dailyRate.replace(",", ".") : null;
  const common = {
    channel: i.channel,
    partnerAccountId: partner.id,
    endCustomerAccountId: endCustomer?.id ?? null,
    endCustomerHint: i.endCustomerHint || null,
    ...person,
    role: i.role || null,
    startDate: i.startDate || null,
    endDate: i.endDate || null,
    dailyRate: rate,
    days: i.days ? Number(i.days) : null,
    offerNumber: i.offerNumber || null,
    brokerRef: i.brokerRef || null,
    orderNumber: i.orderNumber || null,
    statusReason: i.note || null,
  };
  if (i.kind === "ANGEBOT") return confirmOffer(actor, draft, common, i);
  return confirmOrder(actor, draft, common, i);
}

type Common = Omit<Partial<typeof schema.orderCases.$inferInsert>, "id">;

async function confirmOffer(actor: Actor, draft: CaseRow, common: Common, i: ConfirmInput): Promise<CaseRow> {
  if (!common.role) throw new ValidationError("Bitte die Rolle angeben (wird Titel der Chance).");
  // Angebot zur Verlängerung: am laufenden Einsatz, kein neuer Lead
  if (i.renewalEngagementId) {
    const { startRenewal } = await import("@/modules/engagements/care");
    if (!common.endDate) throw new ValidationError("Für das Verlängerungsangebot bitte das neue Ende angeben.");
    await startRenewal(actor, i.renewalEngagementId, { newEnd: common.endDate, vk: common.dailyRate ?? "", rateUnit: "TAG", offerNumber: common.offerNumber ?? "", note: `Angebot ${draft.number}` });
    const e = (await db.query.engagements.findFirst({ where: eq(schema.engagements.id, i.renewalEngagementId) }))!;
    let [row] = await db.update(schema.orderCases).set({ ...common, isRenewal: true, engagementId: e.id, opportunityId: e.opportunityId, endCustomerAccountId: common.channel === "VERMITTLER" ? e.accountId : null, status: "ANGEBOT_VERSENDET", updatedAt: new Date(), version: draft.version + 1 }).where(eq(schema.orderCases.id, draft.id)).returning();
    const file = await attachFile(actor, row!, "ANGEBOT", e.accountId, e.setupId, e.id, `Angebot Verlängerung ${row!.number}`);
    row = await refreshSystems(row!, file?.sharepoint);
    await recordAudit(db, actor, "order_case.offer_confirmed", "ORDER_CASE", row.id, { verlaengerung: e.id });
    return row;
  }
  // Neue Fassung eines bestehenden Angebots (A10)
  const base = i.matchCaseId ? await requireCase(actor, i.matchCaseId) : null;
  const target = (common.endCustomerAccountId ? await db.query.accounts.findFirst({ where: eq(schema.accounts.id, common.endCustomerAccountId) }) : null) ?? (await db.query.accounts.findFirst({ where: eq(schema.accounts.id, common.partnerAccountId!) }))!;
  const owner = await ownerFor(actor, target, i);
  const setupId = await ensureSetup(actor, { ...target, responsibleBdUserId: owner });
  const intermediary = common.channel === "VERMITTLER" ? (await db.query.accounts.findFirst({ where: eq(schema.accounts.id, common.partnerAccountId!) }))!.name : null;
  let opportunityId = base?.opportunityId ?? null;
  if (!opportunityId) {
    const [opp] = await db
      .insert(schema.opportunities)
      .values({ workspaceId: actor.workspaceId, accountId: target.id, setupId, title: common.role!, needDescription: `Angebot ${draft.number}${intermediary ? ` über ${intermediary}` : ""}${common.personName ? ` mit ${common.personName}` : ""}.`, endCustomerNote: common.endCustomerAccountId ? null : common.endCustomerHint ?? null, status: "PROFIL_ANGEBOT_VORGESTELLT", kind: common.internalUserId ? "VERVE_EXPERTE" : "FREELANCER_EXPERTE", headcount: 1, ownerUserId: owner, confirmedAt: new Date(), confirmedNote: `Auftragseingang ${draft.number}`, createdBy: actor.userId })
      .returning();
    opportunityId = opp!.id;
  } else {
    await db.update(schema.offers).set({ status: "ZURUECKGEZOGEN", statusReason: `ersetzt durch neue Fassung ${draft.number}`, updatedAt: new Date() }).where(and(eq(schema.offers.opportunityId, opportunityId), inArray(schema.offers.status, ["ENTWURF", "GEPRUEFT", "VORGESTELLT", "RUECKMELDUNG_OFFEN"])));
  }
  const [offer] = await db.insert(schema.offers).values({ workspaceId: actor.workspaceId, opportunityId, title: `Angebot ${common.offerNumber ?? draft.number}${common.personName ? ` – ${common.personName}` : ""}`, summary: [common.dailyRate ? `${common.dailyRate} €/Tag` : null, common.days ? `${common.days} Tage` : null, common.startDate && common.endDate ? `${common.startDate} bis ${common.endDate}` : null].filter(Boolean).join(" · ") || null, status: "VORGESTELLT", presentedAt: new Date(), createdBy: actor.userId }).returning();
  const caseId = base?.id ?? draft.id;
  let [row] = await db.update(schema.orderCases).set({ ...common, opportunityId, offerId: offer!.id, status: "ANGEBOT_VERSENDET", parsed: draft.parsed, updatedAt: new Date() }).where(eq(schema.orderCases.id, caseId)).returning();
  if (base) await db.delete(schema.orderCases).where(eq(schema.orderCases.id, draft.id));
  const file = await attachFile(actor, row!, "ANGEBOT", target.id, setupId, null, `Angebot ${row!.offerNumber ?? row!.number}`);
  row = await refreshSystems(row!, file?.sharepoint);
  await recordAudit(db, actor, "order_case.offer_confirmed", "ORDER_CASE", row.id, { chance: opportunityId, neueFassung: !!base });
  return row;
}

async function confirmOrder(actor: Actor, draft: CaseRow, common: Common, i: ConfirmInput): Promise<CaseRow> {
  const base = i.matchCaseId ? await requireCase(actor, i.matchCaseId) : null;
  if (base && base.status !== "ANGEBOT_VERSENDET") throw new TransitionError("Der gewählte Vorgang hat kein offenes Angebot.");
  // R7 / B8: dieselbe Bestellnummer desselben Vertragspartners gibt es nur einmal
  if (common.orderNumber) {
    const dup = await db.query.orderCases.findFirst({ where: and(eq(schema.orderCases.workspaceId, actor.workspaceId), eq(schema.orderCases.partnerAccountId, common.partnerAccountId!), eq(schema.orderCases.orderNumber, common.orderNumber), inArray(schema.orderCases.status, ["BEAUFTRAGT", "ANGEBOT_VERSENDET"])) });
    if (dup && dup.id !== base?.id) throw new ConflictError(`Die Bestellung ${common.orderNumber} ist bereits als ${dup.number} erfasst.`);
  }
  if (base && i.deviationsOk !== "on" && i.deviationsOk !== "true") {
    const dev = deviations(base, { dailyRate: common.dailyRate ?? null, startDate: common.startDate ?? null, endDate: common.endDate ?? null, days: common.days ?? null, freelancerId: common.freelancerId ?? null, internalUserId: common.internalUserId ?? null, personName: common.personName ?? null });
    if (dev.length) throw new ValidationError(`Die Bestellung weicht vom Angebot ab: ${dev.join("; ")}. Bitte prüfen und „Abweichungen bestätigt“ anhaken.`);
  }
  // Verlängerung eines laufenden Einsatzes
  if (i.renewalEngagementId) {
    if (!common.endDate) throw new ValidationError("Für die Verlängerung bitte das neue Ende angeben.");
    const { startRenewal, decideRenewal } = await import("@/modules/engagements/care");
    await startRenewal(actor, i.renewalEngagementId, { newEnd: common.endDate, vk: common.dailyRate ?? "", rateUnit: "TAG", orderReference: common.orderNumber ?? "", offerNumber: common.offerNumber ?? "", note: `Bestellung ${draft.number}` }, { direct: true });
    await decideRenewal(actor, i.renewalEngagementId, { decision: "BESTAETIGEN", orderReference: common.orderNumber ?? "" });
    const e = (await db.query.engagements.findFirst({ where: eq(schema.engagements.id, i.renewalEngagementId) }))!;
    let [row] = await db.update(schema.orderCases).set({ ...common, isRenewal: true, engagementId: e.id, opportunityId: e.opportunityId, orderId: e.orderId, endCustomerAccountId: common.channel === "VERMITTLER" ? e.accountId : null, status: "BEAUFTRAGT", updatedAt: new Date() }).where(eq(schema.orderCases.id, draft.id)).returning();
    const file = await attachFile(actor, row!, "BESTELLUNG", e.accountId, e.setupId, e.id, `Bestellung Verlängerung ${row!.orderNumber ?? row!.number}`);
    row = await refreshSystems(row!, file?.sharepoint);
    await recordAudit(db, actor, "order_case.order_confirmed", "ORDER_CASE", row.id, { verlaengerung: e.id, bestellnummer: common.orderNumber ?? null });
    return row;
  }
  if (!common.role && !base?.role) throw new ValidationError("Bitte die Rolle angeben.");
  if (!common.personName && !base?.personName) throw new ValidationError("Bitte die Person angeben (oder „Person offen“ als Name eintragen, wenn die Bestellung keine nennt).");
  const merged = { ...common, role: common.role || base?.role || null, personName: common.personName || base?.personName || null, freelancerId: common.freelancerId ?? base?.freelancerId ?? null, internalUserId: common.internalUserId ?? base?.internalUserId ?? null, offerNumber: common.offerNumber || base?.offerNumber || null, brokerRef: common.brokerRef || base?.brokerRef || null };
  const target = (merged.endCustomerAccountId ? await db.query.accounts.findFirst({ where: eq(schema.accounts.id, merged.endCustomerAccountId) }) : null) ?? (await db.query.accounts.findFirst({ where: eq(schema.accounts.id, merged.partnerAccountId!) }))!;
  const owner = await ownerFor(actor, target, i);
  const setupId = base?.opportunityId ? (await db.query.opportunities.findFirst({ where: eq(schema.opportunities.id, base.opportunityId) }))!.setupId : await ensureSetup(actor, { ...target, responsibleBdUserId: owner });
  const t = todayIso();
  const started = !!merged.startDate && merged.startDate <= t;
  // Chance: aus dem Angebot (B1/B2) oder neu als beauftragt (B5)
  let opportunityId = base?.opportunityId ?? null;
  if (opportunityId) {
    await db.update(schema.opportunities).set({ status: "BEAUFTRAGT", updatedAt: new Date() }).where(eq(schema.opportunities.id, opportunityId));
    if (base?.offerId) await db.update(schema.offers).set({ status: "AKZEPTIERT", updatedAt: new Date() }).where(eq(schema.offers.id, base.offerId));
  } else {
    const [opp] = await db
      .insert(schema.opportunities)
      .values({ workspaceId: actor.workspaceId, accountId: target.id, setupId, title: merged.role!, needDescription: `Bestellung ${draft.number} ohne vorheriges Angebot.`, endCustomerNote: merged.endCustomerAccountId ? null : merged.endCustomerHint ?? null, status: "BEAUFTRAGT", kind: merged.internalUserId ? "VERVE_EXPERTE" : "FREELANCER_EXPERTE", headcount: 1, ownerUserId: owner, confirmedAt: new Date(), confirmedNote: `Auftragseingang ${draft.number}`, createdBy: actor.userId })
      .returning();
    opportunityId = opp!.id;
  }
  const [order] = await db
    .insert(schema.orders)
    .values({ workspaceId: actor.workspaceId, opportunityId, offerId: base?.offerId ?? null, orderReference: merged.orderNumber, evidenceNote: `Auftragseingang ${draft.number}`, plannedStart: merged.startDate, plannedEnd: merged.endDate, consultantUserId: merged.internalUserId, consultantName: merged.personName, status: "BEAUFTRAGUNG_BESTAETIGT", confirmedAt: new Date(), confirmedBy: actor.userId, engagementStatus: started ? "GESTARTET" : "GEPLANT", startedAt: started ? new Date(merged.startDate!) : null, createdBy: actor.userId })
    .returning();
  // Einsatz über die Schnellbesetzung (Position, Kandidatur, Einsatzakte); EK kommt erst mit dem Projekteinzelvertrag
  const { quickFill } = await import("@/modules/staffing/service");
  const r = await quickFill(
    actor,
    opportunityId,
    {
      title: merged.role!,
      resourceKind: merged.internalUserId ? "INTERN" : "FREELANCER",
      ...(merged.internalUserId ? { internalUserId: merged.internalUserId } : merged.freelancerId ? { freelancerId: merged.freelancerId } : { newName: merged.personName! }),
      vkRate: merged.dailyRate ?? "",
      rateUnit: "TAG",
      desiredStart: merged.startDate ?? "",
      plannedEnd: merged.endDate ?? "",
      endOpen: merged.endDate ? "false" : "on",
      bdUserId: owner,
      reason: `Bestellung ${draft.number} (Auftragseingang).`,
    },
    { trusted: true, allowMissingEk: true },
  );
  const [e] = await db
    .update(schema.engagements)
    .set({ orderId: order!.id, orderReference: merged.orderNumber, ...(started ? { status: "AKTIV", actualStart: merged.startDate } : { status: "GEPLANT" }), updatedAt: new Date() })
    .where(eq(schema.engagements.id, r.engagement.id))
    .returning();
  const caseId = base?.id ?? draft.id;
  let [row] = await db.update(schema.orderCases).set({ ...merged, opportunityId, orderId: order!.id, engagementId: e!.id, status: "BEAUFTRAGT", parsed: draft.parsed, updatedAt: new Date() }).where(eq(schema.orderCases.id, caseId)).returning();
  if (base) {
    // Unterlagen des Entwurfs gehören jetzt zum Angebotsvorgang
    await db.update(schema.orderCaseDocuments).set({ caseId: base.id }).where(eq(schema.orderCaseDocuments.caseId, draft.id));
    await db.delete(schema.orderCases).where(eq(schema.orderCases.id, draft.id));
  }
  const file = await attachFile(actor, row!, "BESTELLUNG", target.id, e!.setupId, e!.id, `Bestellung ${row!.orderNumber ?? row!.number}`);
  // Angebotsunterlagen auch am Einsatz zeigen
  const offerDocs = await db.query.orderCaseDocuments.findMany({ where: and(eq(schema.orderCaseDocuments.caseId, row!.id), eq(schema.orderCaseDocuments.kind, "ANGEBOT")) });
  for (const d of offerDocs) await db.insert(schema.engagementDocuments).values({ engagementId: e!.id, documentId: d.documentId }).onConflictDoNothing();
  row = await refreshSystems(row!, file?.sharepoint);
  await recordAudit(db, actor, "order_case.order_confirmed", "ORDER_CASE", row.id, { einsatz: e!.id, bestellnummer: merged.orderNumber, ohneAngebot: !base });
  return row;
}

// ---------------------------------------------------------------------------
// Ohne Dokument, Endkunde nachtragen, Absage
// ---------------------------------------------------------------------------

/** Angebot ohne Dokument (A4): beim Vermittler oft nur mündlich oder per kurzer Mail – dieselben Felder, kein Upload. */
export async function createOfferWithoutDocument(actor: Actor, raw: unknown): Promise<CaseRow> {
  await requireIntake(actor);
  const draft = await insertCase(actor, { channel: "VERMITTLER", status: "ENTWURF", parsed: { manual: true } });
  try {
    return await confirmCase(actor, draft.id, { ...(raw as Record<string, unknown>), kind: "ANGEBOT" });
  } catch (err) {
    await db.delete(schema.orderCases).where(and(eq(schema.orderCases.id, draft.id), eq(schema.orderCases.status, "ENTWURF")));
    throw err;
  }
}

/**
 * Endkunde nachtragen (das häufigste Nachziehen): Chance, Position, Einsatz und Unterlagen ziehen zum Endkunden,
 * der Vermittler bleibt Vertragspartner. Danach wird der Soll-Zustand neu berechnet.
 */
export async function setEndCustomer(actor: Actor, caseId: string, raw: unknown): Promise<CaseRow> {
  await requireIntake(actor);
  const p = z.object({ endCustomerAccountId: opt(100), endCustomerNewName: opt(200) }).safeParse(raw);
  if (!p.success) throw new ValidationError("Bitte den Endkunden angeben.");
  const c = await requireCase(actor, caseId);
  if (c.channel !== "VERMITTLER") throw new TransitionError("Einen Endkunden gibt es nur beim Vertrieb über Vermittler.");
  if (["ABGESAGT", "STORNIERT", "ENTWURF"].includes(c.status)) throw new TransitionError("Der Vorgang ist nicht offen.");
  const acc = await ensureAccount(actor, p.data.endCustomerAccountId, p.data.endCustomerNewName, "KUNDE");
  if (!acc) throw new ValidationError("Bitte den Endkunden wählen oder eintragen.");
  if (acc.id === c.partnerAccountId) throw new ValidationError("Der Endkunde ist nicht der Vermittler.");
  const setupId = await ensureSetup(actor, acc);
  await db.transaction(async (tx) => {
    if (c.opportunityId) {
      await tx.update(schema.opportunities).set({ accountId: acc.id, setupId, endCustomerNote: null, updatedAt: new Date() }).where(eq(schema.opportunities.id, c.opportunityId));
      await tx.update(schema.staffingPositions).set({ accountId: acc.id, setupId, updatedAt: new Date() }).where(eq(schema.staffingPositions.opportunityId, c.opportunityId));
      await tx.update(schema.engagements).set({ accountId: acc.id, setupId, updatedAt: new Date() }).where(eq(schema.engagements.opportunityId, c.opportunityId));
    }
    const docs = await tx.query.orderCaseDocuments.findMany({ where: eq(schema.orderCaseDocuments.caseId, c.id) });
    if (docs.length) await tx.update(schema.contractDocuments).set({ accountId: acc.id, updatedAt: new Date() }).where(inArray(schema.contractDocuments.id, docs.map((d) => d.documentId)));
    await tx.update(schema.orderCases).set({ endCustomerAccountId: acc.id, version: c.version + 1, updatedAt: new Date() }).where(eq(schema.orderCases.id, c.id));
    await recordAudit(tx, actor, "order_case.end_customer", "ORDER_CASE", c.id, { endkunde: acc.name });
  });
  return refreshSystems((await db.query.orderCases.findFirst({ where: eq(schema.orderCases.id, c.id) }))!);
}

/** Absage oder Rückzug (A12): Vorgang „abgesagt“ mit Grund, Chance zurückgestellt, Angebot abgelehnt, Datei bleibt. */
export async function cancelCase(actor: Actor, caseId: string, reason: string): Promise<CaseRow> {
  await requireIntake(actor);
  const c = await requireCase(actor, caseId);
  if (c.status === "ENTWURF") {
    await db.delete(schema.orderCases).where(eq(schema.orderCases.id, c.id));
    await recordAudit(db, actor, "order_case.discarded", "ORDER_CASE", c.id, {});
    return { ...c, status: "VERWORFEN" };
  }
  if (c.status !== "ANGEBOT_VERSENDET") throw new TransitionError("Absagen lässt sich nur ein offenes Angebot; ein beauftragter Einsatz wird am Einsatz beendet.");
  const why = reason.trim() || "abgesagt";
  if (c.offerId) await db.update(schema.offers).set({ status: "ABGELEHNT", statusReason: why, updatedAt: new Date() }).where(eq(schema.offers.id, c.offerId));
  if (c.opportunityId && !c.isRenewal) await db.update(schema.opportunities).set({ status: "ZURUECKGESTELLT", statusReason: why, updatedAt: new Date() }).where(eq(schema.opportunities.id, c.opportunityId));
  const [row] = await db.update(schema.orderCases).set({ status: "ABGESAGT", statusReason: why, version: c.version + 1, updatedAt: new Date() }).where(eq(schema.orderCases.id, c.id)).returning();
  await recordAudit(db, actor, "order_case.cancelled", "ORDER_CASE", c.id, { grund: why });
  return refreshSystems(row!);
}

// ---------------------------------------------------------------------------
// Listen und Detail
// ---------------------------------------------------------------------------

export type CaseView = CaseRow & { partnerName: string | null; endCustomerName: string | null; open: string[]; creatorName: string; documents: { id: string; kind: string; title: string; link: string | null; sourceId: string | null; fileId: string | null; fileName: string | null }[] };

async function views(rows: CaseRow[]): Promise<CaseView[]> {
  const accIds = [...new Set(rows.flatMap((r) => [r.partnerAccountId, r.endCustomerAccountId]).filter((x): x is string => !!x))];
  const [accs, users, docLinks] = await Promise.all([
    accIds.length ? db.query.accounts.findMany({ where: inArray(schema.accounts.id, accIds), columns: { id: true, name: true } }) : Promise.resolve([]),
    rows.length ? db.query.users.findMany({ where: inArray(schema.users.id, [...new Set(rows.map((r) => r.createdBy))]), columns: { id: true, displayName: true } }) : Promise.resolve([]),
    rows.length ? db.query.orderCaseDocuments.findMany({ where: inArray(schema.orderCaseDocuments.caseId, rows.map((r) => r.id)) }) : Promise.resolve([]),
  ]);
  const docs = docLinks.length ? await db.query.contractDocuments.findMany({ where: inArray(schema.contractDocuments.id, docLinks.map((d) => d.documentId)), columns: { id: true, title: true, link: true, sourceId: true } }) : [];
  const srcIds = docs.map((d) => d.sourceId).filter((x): x is string => !!x);
  const files = srcIds.length ? await db.query.documents.findMany({ where: inArray(schema.documents.sourceId, srcIds), columns: { id: true, sourceId: true, fileName: true } }) : [];
  const an = new Map(accs.map((a) => [a.id, a.name]));
  const un = new Map(users.map((u) => [u.id, u.displayName]));
  const out: CaseView[] = [];
  for (const r of rows) {
    const f = await facts(r);
    out.push({
      ...r,
      partnerName: an.get(r.partnerAccountId ?? "") ?? null,
      endCustomerName: an.get(r.endCustomerAccountId ?? "") ?? null,
      open: r.status === "ENTWURF" || r.status === "ABGESAGT" || r.status === "STORNIERT" ? [] : openPoints(f),
      creatorName: un.get(r.createdBy) ?? "?",
      documents: docLinks
        .filter((d) => d.caseId === r.id)
        .map((d) => {
          const doc = docs.find((x) => x.id === d.documentId);
          const f = doc?.sourceId ? files.find((x) => x.sourceId === doc.sourceId) : null;
          return doc ? { kind: d.kind, ...doc, fileId: f?.id ?? null, fileName: f?.fileName ?? null } : null;
        })
        .filter((d): d is NonNullable<typeof d> => !!d),
    });
  }
  return out;
}

export async function listCases(actor: Actor, filter: "offen" | "alle" = "offen"): Promise<CaseView[]> {
  await requireIntake(actor);
  const all = await db.query.orderCases.findMany({ where: and(eq(schema.orderCases.workspaceId, actor.workspaceId), filter === "offen" ? inArray(schema.orderCases.status, ["ENTWURF", "ANGEBOT_VERSENDET", "BEAUFTRAGT"]) : undefined), orderBy: desc(schema.orderCases.updatedAt) });
  const visible: CaseRow[] = [];
  for (const c of all) if (await canSeeCase(actor, c)) visible.push(c);
  const v = await views(visible);
  // „offen“: Beauftragte nur, solange noch etwas fehlt
  return filter === "offen" ? v.filter((c) => c.status !== "BEAUFTRAGT" || c.open.length > 0) : v;
}

export async function getCase(actor: Actor, id: string): Promise<CaseView> {
  const c = await requireCase(actor, id);
  return (await views([c]))[0]!;
}

/** Auswahl für das Bestätigungsformular. */
export async function caseChoices(actor: Actor) {
  const [accounts, persons, open, running] = await Promise.all([
    db.query.accounts.findMany({ where: and(eq(schema.accounts.workspaceId, actor.workspaceId), inArray(schema.accounts.status, ["ACTIVE", "DORMANT"])), columns: { id: true, name: true, accountKind: true }, orderBy: (a, { asc }) => [asc(a.name)] }),
    knownPersons(actor.workspaceId),
    db.query.orderCases.findMany({ where: and(eq(schema.orderCases.workspaceId, actor.workspaceId), eq(schema.orderCases.status, "ANGEBOT_VERSENDET")), orderBy: desc(schema.orderCases.updatedAt) }),
    db.query.engagements.findMany({ where: and(eq(schema.engagements.workspaceId, actor.workspaceId), inArray(schema.engagements.status, ["GEPLANT", "AKTIV", "PAUSIERT", "ENDET"])), columns: { id: true, title: true, accountId: true, plannedEnd: true } }),
  ]);
  const an = new Map(accounts.map((a) => [a.id, a.name]));
  const bdRoles = await db.query.roleAssignments.findMany({ where: and(eq(schema.roleAssignments.workspaceId, actor.workspaceId), inArray(schema.roleAssignments.role, ["BD", "PRINCIPAL"])), columns: { userId: true } });
  const bdIds = new Set(bdRoles.map((r) => r.userId));
  return {
    bds: persons.users.filter((u) => bdIds.has(u.id)).map((u) => ({ id: u.id, name: u.displayName })),
    accounts: accounts.map((a) => ({ id: a.id, name: a.name, broker: a.accountKind === "VERMITTLER" })),
    freelancers: persons.freelancers.map((f) => ({ id: f.id, name: f.displayName })),
    users: persons.users.map((u) => ({ id: u.id, name: u.displayName })),
    openOffers: open.map((c) => ({ id: c.id, label: `${c.number} · ${an.get(c.partnerAccountId ?? "") ?? "?"} · ${c.personName ?? "Person offen"} · ${c.role ?? ""}`.trim() })),
    running: running.map((e) => ({ id: e.id, label: `${e.title} · ${an.get(e.accountId) ?? "?"}${e.plannedEnd ? ` · bis ${e.plannedEnd.split("-").reverse().join(".")}` : ""}` })),
  };
}

/** Kurzzählung für Navigation und Start: zu bestätigen und offene Angaben. */
export async function intakeCounts(actor: Actor): Promise<{ drafts: number; open: number }> {
  if (!(await canUseOrderIntake(actor))) return { drafts: 0, open: 0 };
  const rows = await db.query.orderCases.findMany({ where: and(eq(schema.orderCases.workspaceId, actor.workspaceId), or(eq(schema.orderCases.status, "ENTWURF"), eq(schema.orderCases.status, "ANGEBOT_VERSENDET"), eq(schema.orderCases.status, "BEAUFTRAGT"))), columns: { id: true } });
  if (!rows.length) return { drafts: 0, open: 0 };
  const v = await listCases(actor, "offen");
  return { drafts: v.filter((c) => c.status === "ENTWURF" && c.createdBy === actor.userId).length, open: v.filter((c) => c.open.length > 0).length };
}
