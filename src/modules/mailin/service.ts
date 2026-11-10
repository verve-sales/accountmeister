import { createHash } from "node:crypto";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { getConfig, type AppConfig } from "@/lib/config";
import { ValidationError } from "@/lib/errors";
import { loadActor } from "@/modules/identity/actor";
import { canEditSetup } from "@/modules/identity/authz";
import { notify } from "@/modules/notifications/service";
import { graphGet } from "@/modules/integrations/graph/client";
import { sanitizeToText } from "@/modules/integrations/graph/adapter";
import type { AIProvider } from "@/modules/ai/provider";

/**
 * Mail-Eingang (Etappe 49): Wer eine Mail an das Accountmeister-Postfach weiterleitet, findet die daraus abgeleiteten
 * Kärtchen auf seiner Startseite zur Bestätigung – dieselbe Auswertung wie „Was gibt es Neues?“.
 *
 * Regeln:
 *  - Das Postfach wird nur gelesen (Graph-Anwendungsrecht Mail.Read, auf dieses Postfach beschränkt). Nichts wird
 *    verändert, verschoben oder gelöscht; was schon verarbeitet ist, steht in `mail_inbox_items`.
 *  - Ausgewertet wird nur, was ein aktiver Accountmeister-Nutzer aus dem eigenen Mandanten geschickt hat. Der Absender
 *    bestimmt, wem die Kärtchen gehören und was er sehen darf. Alles andere (z. B. Bewerbungen von außen) wird
 *    übersprungen – der Inhalt wird dafür gar nicht erst abgerufen.
 *  - Weitergeleitete Bewerbungen werden nicht ausgewertet (Bewerberdaten gehören nicht in den Accountmeister).
 *  - Anhänge werden nicht übernommen.
 */

export type InboxMeta = { id: string; messageId: string; subject: string; fromEmail: string; fromName: string; receivedAt: string; /** true/false laut Exchange-Kopfzeile, null = nicht feststellbar */ internal: boolean | null };
export interface InboxClient {
  list(sinceIso: string): Promise<InboxMeta[]>;
  body(id: string): Promise<string>;
}

type GraphMessage = { id: string; internetMessageId?: string; subject?: string; receivedDateTime: string; from?: { emailAddress?: { address?: string; name?: string } }; internetMessageHeaders?: { name: string; value: string }[]; body?: { content?: string } };

export class GraphInboxClient implements InboxClient {
  constructor(private readonly cfg: AppConfig) {}
  private async token() {
    const { graphToken } = await import("@/modules/notifications/mailer");
    return graphToken(this.cfg);
  }
  private get box() {
    return encodeURIComponent(this.cfg.MAIL_INBOX!);
  }
  async list(sinceIso: string): Promise<InboxMeta[]> {
    const q = `$filter=${encodeURIComponent(`receivedDateTime ge ${sinceIso}`)}&$orderby=${encodeURIComponent("receivedDateTime asc")}&$top=50&$select=id,internetMessageId,subject,from,receivedDateTime,internetMessageHeaders`;
    const res = (await graphGet(`/users/${this.box}/mailFolders/inbox/messages?${q}`, await this.token())) as { value?: GraphMessage[] };
    return (res.value ?? []).map((m) => {
      const h = m.internetMessageHeaders?.find((x) => x.name.toLowerCase() === "x-ms-exchange-organization-authas")?.value;
      return { id: m.id, messageId: m.internetMessageId ?? m.id, subject: m.subject ?? "(ohne Betreff)", fromEmail: (m.from?.emailAddress?.address ?? "").toLowerCase(), fromName: m.from?.emailAddress?.name ?? "", receivedAt: m.receivedDateTime, internal: h ? h.toLowerCase() === "internal" : null };
    });
  }
  async body(id: string): Promise<string> {
    const m = (await graphGet(`/users/${this.box}/messages/${encodeURIComponent(id)}?$select=body`, await this.token())) as GraphMessage;
    return m.body?.content ?? "";
  }
}

export function mailInboxEnabled(cfg: AppConfig = getConfig()): boolean {
  return cfg.MAIL_INBOX_MODE === "graph" && !!cfg.MAIL_INBOX;
}

/** Adresse für die Oberfläche („Mail weiterleiten an …“) – null, wenn der Mail-Eingang aus ist. */
export function mailInboxAddress(cfg: AppConfig = getConfig()): string | null {
  return cfg.MAIL_INBOX_MODE !== "off" && cfg.MAIL_INBOX ? cfg.MAIL_INBOX : null;
}

const FWD_PREFIX = /^((WG|FW|Fwd|AW|RE|Antwort|Weiterleitung)\s*:\s*)+/i;
export const cleanSubject = (s: string) => s.replace(FWD_PREFIX, "").trim() || "(ohne Betreff)";

/** Sieht die Mail nach einer Bewerbung aus? Angebote auf Ausschreibungen („Bewerbung auf die Ausschreibung“) zählen nicht. */
export function looksLikeApplication(subject: string, body: string): boolean {
  const head = `${cleanSubject(subject)}\n${body.slice(0, 1200)}`;
  if (/ausschreibung|angebot|tender|rahmenvertrag/i.test(head)) return false;
  return /\b(initiativ)?bewerbung(en|sunterlagen|sschreiben)?\b|\bbewerbe mich\b|\blebenslauf\b|\bcurriculum vitae\b|\bjob application\b|\bapplication for the (position|role)\b|\bapplying for\b/i.test(head);
}

/** Beteiligte aus den Kopfzeilen der weitergeleiteten Mail („Von: Name <adresse>“) – für die Kundenerkennung über Domänen. */
export function forwardedParticipants(body: string): { name: string; email?: string }[] {
  const out = new Map<string, { name: string; email?: string }>();
  for (const line of body.split("\n")) {
    const m = /^\s*>?\s*(Von|From|An|To|Cc)\s*:\s*(.+)$/i.exec(line);
    if (!m) continue;
    for (const part of m[2]!.split(/[;,](?![^<]*>)/)) {
      const e = /<?([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})>?/.exec(part);
      if (!e) continue;
      const name = part.replace(/<.*?>/g, "").replace(/["']/g, "").replace(e[1]!, "").trim();
      out.set(e[1]!.toLowerCase(), { name: name || e[1]!, email: e[1]!.toLowerCase() });
    }
  }
  return [...out.values()].slice(0, 20);
}

export type MailInboxResult = { gesehen: number; ausgewertet: number; abgelehnt: number; fehler: number; karten: number };

/** Ein Abruf: neue Nachrichten seit dem letzten Stand verarbeiten. Idempotent über die Nachrichten-ID. */
export async function runMailInbox(deps: { client?: InboxClient; provider?: AIProvider; cfg?: AppConfig; limit?: number } = {}): Promise<MailInboxResult> {
  const cfg = deps.cfg ?? getConfig();
  const res: MailInboxResult = { gesehen: 0, ausgewertet: 0, abgelehnt: 0, fehler: 0, karten: 0 };
  if (cfg.MAIL_INBOX_MODE === "off") return res;
  const client = deps.client ?? (mailInboxEnabled(cfg) ? new GraphInboxClient(cfg) : null);
  if (!client) return res;
  const [last] = await db.select({ at: schema.mailInboxItems.receivedAt }).from(schema.mailInboxItems).orderBy(desc(schema.mailInboxItems.receivedAt)).limit(1);
  // Beim ersten Lauf nur die letzten 24 Stunden – kein Aufarbeiten des ganzen Postfachs
  const since = new Date((last?.at.getTime() ?? Date.now() - 24 * 3600_000) - 15 * 60_000).toISOString();
  const metas = await client.list(since);
  if (!metas.length) return res;
  const known = new Set((await db.query.mailInboxItems.findMany({ where: inArray(schema.mailInboxItems.messageId, metas.map((m) => m.messageId)), columns: { messageId: true } })).map((x) => x.messageId));
  const fresh = metas.filter((m) => !known.has(m.messageId)).slice(0, deps.limit ?? 20);
  for (const m of fresh) {
    res.gesehen++;
    const base = { messageId: m.messageId, receivedAt: new Date(m.receivedAt) };
    const user = m.fromEmail ? await db.query.users.findFirst({ where: sql`lower(${schema.users.email}) = ${m.fromEmail} and ${schema.users.status} = 'ACTIVE'` }) : null;
    if (!user) {
      await db.insert(schema.mailInboxItems).values({ ...base, status: "ABGELEHNT", reason: "Absender ist kein Accountmeister-Nutzer" }).onConflictDoNothing();
      res.abgelehnt++;
      continue;
    }
    if (cfg.MAIL_INBOX_REQUIRE_INTERNAL === "true" && m.internal !== true) {
      await db.insert(schema.mailInboxItems).values({ ...base, workspaceId: user.workspaceId, status: "ABGELEHNT", reason: "Absender nicht als intern bestätigt (möglicherweise gefälscht)" }).onConflictDoNothing();
      res.abgelehnt++;
      continue;
    }
    await processForUser(user, { key: m.messageId, subject: m.subject, receivedAt: m.receivedAt, exclude: m.fromEmail }, () => client.body(m.id), { what: "Weitergeleitete Mail", header: `Weitergeleitet von: ${user.displayName}`, origin: `Weiterleitung an ${cfg.MAIL_INBOX ?? "das Accountmeister-Postfach"} durch ${user.displayName}`, provider: deps.provider }, res);
  }
  return res;
}

type UserRow = typeof schema.users.$inferSelect;

/** Eine Nachricht für eine Person auswerten: Bewerbungsfilter, Quelle anlegen, Kärtchen erzeugen, Hinweis schicken. */
async function processForUser(
  user: UserRow,
  m: { key: string; subject: string; receivedAt: string; exclude?: string },
  getBody: () => Promise<string>,
  o: { what: string; header: string; origin: string; participants?: { name: string; email?: string }[]; provider?: AIProvider },
  res: MailInboxResult,
) {
  const title = cleanSubject(m.subject);
  const record = async (status: string, reason: string | null, extra: { sourceId?: string; cardCount?: number } = {}) => {
    await db.insert(schema.mailInboxItems).values({ messageId: m.key, receivedAt: new Date(m.receivedAt), workspaceId: user.workspaceId, userId: user.id, subject: title.slice(0, 300), status, reason, sourceId: extra.sourceId ?? null, cardCount: extra.cardCount ?? 0 }).onConflictDoNothing();
  };
  let sourceId: string | undefined;
  try {
    const actor = await loadActor(user.id);
    if (!actor) throw new Error("Zugang nicht aktiv");
    const rawBody = await getBody();
    // Adressen in spitzen Klammern („Name <a@b.de>“) vor dem Bereinigen sichern – sie tragen die Kundenerkennung
    const text = sanitizeToText(rawBody.replace(/<([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})>/g, "($1)")).trim().slice(0, 60000);
    if (looksLikeApplication(m.subject, text)) {
      await record("ABGELEHNT", "sieht nach einer Bewerbung aus");
      await notify(db, { workspaceId: user.workspaceId, userIds: [user.id], kind: "ABGELEHNT", title: `${o.what} „${title.slice(0, 80)}“ nicht ausgewertet: sieht nach einer Bewerbung aus`, link: "/eingang", dedupeKey: `mailin:${m.key}` });
      res.abgelehnt++;
      return;
    }
    if (text.length < 12) {
      await record("ABGELEHNT", "kein Text");
      res.abgelehnt++;
      return;
    }
    const { eingangFromSource, routeText } = await import("@/modules/eingang/service");
    const seen = new Set<string>();
    const participants = [...(o.participants ?? []), ...forwardedParticipants(rawBody)].filter((p) => p.email !== m.exclude && p.email !== user.email.toLowerCase() && !seen.has(p.email ?? p.name) && !!seen.add(p.email ?? p.name));
    const body = `${o.header}\nDatum: ${new Date(m.receivedAt).toLocaleString("de-DE", { timeZone: "Europe/Berlin" })}\nBetreff: ${title}\n\n${text}`;
    const route = await routeText(actor, body, participants);
    const editable = !!route.ctx && canEditSetup(actor, route.ctx);
    const hash = createHash("sha256").update(body).digest("hex");
    const [src] = await db
      .insert(schema.sources)
      .values({ workspaceId: user.workspaceId, setupId: editable ? route.ctx!.setup.id : null, type: "EMAIL", title: title.slice(0, 200), body, origin: o.origin, externalKey: `MAILIN:${m.key}`, sourceTime: new Date(m.receivedAt), ownerUserId: user.id, accessClass: editable ? "SETUP" : "PERSOENLICH" })
      .returning();
    sourceId = src!.id;
    await db.insert(schema.sourceVersions).values({ sourceId, versionNo: 1, body, contentHash: hash });
    const r = await eingangFromSource(actor, sourceId, { participants, sourceLabel: `E-Mail „${title}“ vom ${new Date(m.receivedAt).toLocaleDateString("de-DE")}`, autoRoute: true }, { provider: o.provider });
    await record("AUSGEWERTET", r.created ? null : r.noSuggestionReason || "keine Vorschläge", { sourceId, cardCount: r.created });
    await notify(db, { workspaceId: user.workspaceId, userIds: [user.id], kind: "ZUR_PRUEFUNG", title: r.created ? `${o.what} „${title.slice(0, 80)}“: ${r.created} Vorschlag/Vorschläge zur Bestätigung${r.accountName ? ` (${r.accountName})` : ""}` : `${o.what} „${title.slice(0, 80)}“: nichts abzuleiten${r.noSuggestionReason ? ` – ${r.noSuggestionReason.slice(0, 120)}` : ""}`, link: "/start", dedupeKey: `mailin:${m.key}` });
    res.ausgewertet++;
    res.karten += r.created;
  } catch (e) {
    const msg = (e instanceof Error ? e.message : "Fehler").slice(0, 300);
    await record("FEHLER", msg, { sourceId });
    await notify(db, { workspaceId: user.workspaceId, userIds: [user.id], kind: "ABGELEHNT", title: `${o.what} „${title.slice(0, 80)}“ konnte nicht ausgewertet werden: ${msg.slice(0, 140)}`, link: "/eingang", dedupeKey: `mailin:${m.key}` }).catch(() => 0);
    res.fehler++;
  }
}

// ---------------------------------------------------------------------------
// Ordner „Accountmeister“ im eigenen Postfach (Etappe 50)
// ---------------------------------------------------------------------------

/**
 * Variante ohne zentrales Postfach: Wer sein Postfach verbunden hat, legt in Outlook einen Ordner „Accountmeister“ an,
 * schaltet die Auswertung in den Einstellungen ein und verschiebt oder kopiert Mails hinein. Gelesen wird mit der
 * bestehenden persönlichen Verbindung (Mail.Read) ausschließlich dieser eine Ordner; nichts wird verändert.
 */
export const WATCH_FOLDER_NAME = "Accountmeister";

export type FolderMeta = { id: string; messageId: string; subject: string; receivedAt: string; from: { name: string; email?: string } | null; to: { name: string; email?: string }[] };
export interface FolderClient {
  /** ID des Ordners „Accountmeister“ (oberste Ebene oder unter dem Posteingang), sonst null */
  findFolder(): Promise<string | null>;
  list(folderId: string): Promise<FolderMeta[]>;
  body(id: string): Promise<string>;
}

type GraphFolder = { id: string; displayName: string };
type GraphFolderMessage = GraphMessage & { toRecipients?: { emailAddress?: { address?: string; name?: string } }[]; ccRecipients?: { emailAddress?: { address?: string; name?: string } }[] };

export class GraphFolderClient implements FolderClient {
  constructor(private readonly token: string) {}
  async findFolder(): Promise<string | null> {
    const f = encodeURIComponent(`displayName eq '${WATCH_FOLDER_NAME}'`);
    for (const path of [`/me/mailFolders?$filter=${f}&$select=id,displayName`, `/me/mailFolders/inbox/childFolders?$filter=${f}&$select=id,displayName`]) {
      const r = (await graphGet(path, this.token)) as { value?: GraphFolder[] };
      if (r.value?.[0]) return r.value[0].id;
    }
    return null;
  }
  async list(folderId: string): Promise<FolderMeta[]> {
    const q = `$orderby=${encodeURIComponent("receivedDateTime desc")}&$top=50&$select=id,internetMessageId,subject,from,toRecipients,ccRecipients,receivedDateTime`;
    const r = (await graphGet(`/me/mailFolders/${encodeURIComponent(folderId)}/messages?${q}`, this.token)) as { value?: GraphFolderMessage[] };
    const addr = (x?: { emailAddress?: { address?: string; name?: string } }) => (x?.emailAddress?.address ? { name: x.emailAddress.name || x.emailAddress.address, email: x.emailAddress.address.toLowerCase() } : null);
    return (r.value ?? []).map((m) => ({ id: m.id, messageId: m.internetMessageId ?? m.id, subject: m.subject ?? "(ohne Betreff)", receivedAt: m.receivedDateTime, from: addr(m.from), to: [...(m.toRecipients ?? []), ...(m.ccRecipients ?? [])].map(addr).filter((x): x is { name: string; email: string } => !!x) }));
  }
  async body(id: string): Promise<string> {
    const m = (await graphGet(`/me/messages/${encodeURIComponent(id)}?$select=body`, this.token)) as GraphMessage;
    return m.body?.content ?? "";
  }
}

/** Ordner-Auswertung ein-/ausschalten (eigene Verbindung). Beim Einschalten wird geprüft, ob der Ordner existiert. */
export async function setWatchFolder(userId: string, on: boolean, deps: { clientFor?: (conn: typeof schema.integrationConnections.$inferSelect) => Promise<FolderClient> } = {}): Promise<{ on: boolean; folderFound: boolean }> {
  const conn = await db.query.integrationConnections.findFirst({ where: sql`${schema.integrationConnections.userId} = ${userId} and ${schema.integrationConnections.provider} = 'MICROSOFT_GRAPH'` });
  if (!conn || conn.status === "WIDERRUFEN" || !conn.tokenRef) throw new ValidationError("Kein verbundenes Postfach. Bitte zuerst das Postfach verbinden.");
  if (!on) {
    await db.update(schema.integrationConnections).set({ watchFolder: false, updatedAt: new Date() }).where(eq(schema.integrationConnections.id, conn.id));
    return { on: false, folderFound: false };
  }
  if (conn.fixtureMode && !deps.clientFor) throw new ValidationError("Im Fixture-Modus gibt es kein echtes Postfach – bitte das echte Postfach verbinden.");
  const client = await (deps.clientFor ?? defaultFolderClient)(conn);
  const folderId = await client.findFolder();
  await db.update(schema.integrationConnections).set({ watchFolder: true, watchFolderId: folderId, watchFolderCheckedAt: new Date(), updatedAt: new Date() }).where(eq(schema.integrationConnections.id, conn.id));
  return { on: true, folderFound: !!folderId };
}

async function defaultFolderClient(conn: typeof schema.integrationConnections.$inferSelect): Promise<FolderClient> {
  const { resolveMailboxCallToken } = await import("@/modules/integrations/service");
  return new GraphFolderClient(await resolveMailboxCallToken(conn));
}

/** Ein Abruf über alle Personen, die die Ordner-Auswertung eingeschaltet haben. Je Person höchstens `perUser` Mails pro Lauf. */
export async function runFolderInbox(deps: { clientFor?: (conn: typeof schema.integrationConnections.$inferSelect) => Promise<FolderClient>; provider?: AIProvider; perUser?: number } = {}): Promise<MailInboxResult & { postfaecher: number }> {
  const res = { gesehen: 0, ausgewertet: 0, abgelehnt: 0, fehler: 0, karten: 0, postfaecher: 0 };
  const conns = await db.query.integrationConnections.findMany({ where: sql`${schema.integrationConnections.watchFolder} = true and ${schema.integrationConnections.provider} = 'MICROSOFT_GRAPH' and ${schema.integrationConnections.tokenRef} is not null and ${schema.integrationConnections.status} in ('VERBUNDEN', 'VERBUNDEN_FIXTURE')` });
  for (const conn of conns) {
    const user = await db.query.users.findFirst({ where: sql`${schema.users.id} = ${conn.userId} and ${schema.users.status} = 'ACTIVE'` });
    if (!user) continue;
    try {
      const client = await (deps.clientFor ?? defaultFolderClient)(conn);
      let folderId = conn.watchFolderId;
      // Ordner noch nicht gefunden: höchstens alle 10 Minuten erneut suchen
      if (!folderId) {
        if (conn.watchFolderCheckedAt && Date.now() - conn.watchFolderCheckedAt.getTime() < 10 * 60_000) continue;
        folderId = await client.findFolder();
        await db.update(schema.integrationConnections).set({ watchFolderId: folderId, watchFolderCheckedAt: new Date() }).where(eq(schema.integrationConnections.id, conn.id));
        if (!folderId) continue;
      }
      res.postfaecher++;
      let metas: FolderMeta[];
      try {
        metas = await client.list(folderId);
      } catch (e) {
        // Ordner gelöscht oder umbenannt → beim nächsten Mal neu suchen
        if (e instanceof Error && /nicht \(mehr\) zugänglich/.test(e.message)) await db.update(schema.integrationConnections).set({ watchFolderId: null, watchFolderCheckedAt: new Date() }).where(eq(schema.integrationConnections.id, conn.id));
        throw e;
      }
      if (!metas.length) continue;
      const keyOf = (m: FolderMeta) => `${user.id}:${m.messageId}`;
      const known = new Set((await db.query.mailInboxItems.findMany({ where: inArray(schema.mailInboxItems.messageId, metas.map(keyOf)), columns: { messageId: true } })).map((x) => x.messageId));
      // älteste zuerst, damit die Reihenfolge der Kärtchen dem Postfach folgt
      const fresh = metas.filter((m) => !known.has(keyOf(m))).reverse().slice(0, deps.perUser ?? 5);
      for (const m of fresh) {
        res.gesehen++;
        const header = `Von: ${m.from ? `${m.from.name}${m.from.email ? ` (${m.from.email})` : ""}` : "?"}${m.to.length ? `\nAn: ${m.to.map((t) => `${t.name}${t.email ? ` (${t.email})` : ""}`).join(", ")}` : ""}`;
        await processForUser(user, { key: keyOf(m), subject: m.subject, receivedAt: m.receivedAt }, () => client.body(m.id), { what: "Mail aus dem Ordner „Accountmeister“", header, origin: `Microsoft 365 · Ordner „${WATCH_FOLDER_NAME}“ von ${user.displayName}`, participants: [...(m.from ? [m.from] : []), ...m.to], provider: deps.provider }, res);
      }
      await db.update(schema.integrationConnections).set({ lastSuccessfulFetchAt: new Date(), lastError: null }).where(eq(schema.integrationConnections.id, conn.id));
    } catch (e) {
      const msg = (e instanceof Error ? e.message : "Abruf fehlgeschlagen").slice(0, 300);
      const auth = /abgelehnt|neu verbinden|erneut verbinden|verweigert/i.test(msg);
      await db.update(schema.integrationConnections).set({ lastError: msg, ...(auth ? { status: "ABGELAUFEN" as const } : {}), updatedAt: new Date() }).where(eq(schema.integrationConnections.id, conn.id));
      if (auth) await notify(db, { workspaceId: user.workspaceId, userIds: [user.id], kind: "ABGELEHNT", title: "Der Ordner „Accountmeister“ kann nicht mehr gelesen werden – bitte das Postfach unter Einstellungen neu verbinden", link: "/einstellungen", dedupeKey: `mailfolder-auth:${conn.id}:${new Date().toISOString().slice(0, 10)}` }).catch(() => 0);
      res.fehler++;
    }
  }
  return res;
}

/** Letzte Weiterleitungen der Person – für die Anzeige im Eingang. */
export async function myMailInbox(userId: string, limit = 8) {
  return db.query.mailInboxItems.findMany({ where: eq(schema.mailInboxItems.userId, userId), orderBy: desc(schema.mailInboxItems.receivedAt), limit });
}
