import { createHash } from "node:crypto";
import { AdapterError, type FetchedSource, type SelectableItem, type SelectableKind } from "../adapter";

/**
 * Echte, nur lesende Aufrufe von Microsoft Graph (v1.0). Wird ausschließlich mit einem gültigen,
 * kurzlebigen Access-Token aufgerufen, das der Service-Layer je Aufruf frisch besorgt (siehe
 * `integrations/service.ts` – dort liegt auch die Verschlüsselung des Refresh-Tokens; dieser Client
 * kennt weder Datenbank noch Geheimnisse). Keine Schreibaufrufe: nur GET.
 */
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

async function graphGet(path: string, accessToken: string, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  const res = await fetchImpl(`${GRAPH_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}`, Prefer: 'outlook.body-content-type="text"' },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401) throw new AdapterError("AUTH", "Microsoft Graph hat den Zugriff abgelehnt (Token abgelaufen oder widerrufen).");
  if (res.status === 403) throw new AdapterError("AUTH", "Microsoft Graph verweigert den Zugriff (403) – vermutlich fehlt eine Berechtigung (z. B. Chat.Read für Teams-Chats). Bitte unter Einstellungen das Postfach neu verbinden.");
  if (res.status === 404) throw new AdapterError("NOT_FOUND", "Quelle nicht (mehr) zugänglich.");
  if (res.status === 429) throw new AdapterError("RATE_LIMIT", "Microsoft Graph hat vorübergehend gedrosselt. Bitte später erneut versuchen.");
  if (!res.ok) throw new AdapterError("TEMPORARY", `Microsoft Graph antwortete mit Fehler ${res.status}.`);
  return res.json();
}

type GraphPerson = { emailAddress?: { name?: string; address?: string } };
type GraphMessage = {
  id: string;
  subject?: string;
  from?: GraphPerson;
  toRecipients?: GraphPerson[];
  ccRecipients?: GraphPerson[];
  receivedDateTime?: string;
  bodyPreview?: string;
  body?: { content?: string; contentType?: string };
  hasAttachments?: boolean;
};
type GraphEvent = {
  id: string;
  subject?: string;
  organizer?: GraphPerson;
  attendees?: { emailAddress?: { name?: string; address?: string }; status?: { response?: string } }[];
  start?: { dateTime?: string };
  bodyPreview?: string;
  body?: { content?: string; contentType?: string };
  hasAttachments?: boolean;
  responseStatus?: { response?: string };
};

function person(p?: GraphPerson): { name: string; email?: string } | null {
  if (!p?.emailAddress) return null;
  return { name: p.emailAddress.name ?? p.emailAddress.address ?? "?", email: p.emailAddress.address };
}

function contentHash(subject: string, body: string, at: string): string {
  return createHash("sha256").update(`${subject}\n${body}\n${at}`).digest("hex");
}

function messageToSelectable(m: GraphMessage): SelectableItem {
  return {
    kind: "MAIL",
    externalId: m.id,
    subject: m.subject ?? "(ohne Betreff)",
    from: person(m.from),
    participants: (m.toRecipients ?? []).map(person).filter((p): p is { name: string; email?: string } => p !== null),
    at: m.receivedDateTime ?? new Date().toISOString(),
    preview: (m.bodyPreview ?? "").slice(0, 140),
    hasAttachments: Boolean(m.hasAttachments),
  };
}

function eventToSelectable(e: GraphEvent): SelectableItem {
  return {
    kind: "TERMIN",
    externalId: e.id,
    subject: e.subject ?? "(ohne Betreff)",
    from: person(e.organizer),
    participants: (e.attendees ?? []).map((a) => person({ emailAddress: a.emailAddress })).filter((p): p is { name: string; email?: string } => p !== null),
    at: e.start?.dateTime ?? new Date().toISOString(),
    preview: (e.bodyPreview ?? "").slice(0, 140),
    hasAttachments: Boolean(e.hasAttachments),
  };
}

// ---------------------------------------------------------------------------
// Teams-Chats (Etappe 37, Chat.Read): Liste der eigenen Chats, Verlauf eines Chats als Text
// ---------------------------------------------------------------------------

type GraphChatMember = { displayName?: string; email?: string; userId?: string };
type GraphChatMessage = { id: string; createdDateTime?: string; messageType?: string; deletedDateTime?: string | null; from?: { user?: { displayName?: string; id?: string } | null; application?: { displayName?: string } | null } | null; body?: { content?: string; contentType?: string } };
type GraphChat = { id: string; topic?: string | null; chatType?: string; members?: GraphChatMember[]; lastMessagePreview?: { createdDateTime?: string; body?: { content?: string }; from?: { user?: { displayName?: string } | null } | null } | null; lastUpdatedDateTime?: string };

const stripHtml = (h: string) => h.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<attachment[^>]*><\/attachment>/gi, "[Anhang]").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
const chatTitle = (c: GraphChat) => c.topic?.trim() || `Chat mit ${(c.members ?? []).map((m) => m.displayName).filter(Boolean).slice(0, 4).join(", ") || "?"}`;
const fmtBerlin = (iso?: string) => (iso ? new Date(iso).toLocaleString("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).replace(",", "") : "?");

function chatToSelectable(c: GraphChat): SelectableItem {
  const last = c.lastMessagePreview;
  return {
    kind: "CHAT",
    externalId: c.id,
    subject: chatTitle(c),
    from: last?.from?.user?.displayName ? { name: last.from.user.displayName } : null,
    participants: (c.members ?? []).map((m) => ({ name: m.displayName ?? "?", email: m.email || undefined })),
    at: last?.createdDateTime ?? c.lastUpdatedDateTime ?? new Date().toISOString(),
    preview: stripHtml(last?.body?.content ?? "").slice(0, 140),
    hasAttachments: false,
  };
}

async function listChats(accessToken: string, query: string | undefined, top: number, fetchImpl: typeof fetch): Promise<SelectableItem[]> {
  const json = (await graphGet(`/me/chats?$expand=members,lastMessagePreview&$orderby=lastMessagePreview/createdDateTime desc&$top=${Math.min(top, 50)}`, accessToken, fetchImpl)) as { value?: GraphChat[] };
  let items = (json.value ?? []).filter((c) => c.lastMessagePreview).map(chatToSelectable);
  if (query?.trim()) {
    const q = query.trim().toLowerCase();
    items = items.filter((i) => i.subject.toLowerCase().includes(q) || i.preview.toLowerCase().includes(q) || i.participants.some((p) => p.name.toLowerCase().includes(q)));
  }
  return items;
}

/** Verlauf eines Chats: die letzten bis zu 50 Nachrichten, älteste zuerst, je Zeile „[Zeit] Name: Text“. */
async function fetchChat(accessToken: string, chatId: string, fetchImpl: typeof fetch): Promise<FetchedSource> {
  const id = encodeURIComponent(chatId);
  const chat = (await graphGet(`/me/chats/${id}?$expand=members`, accessToken, fetchImpl)) as GraphChat;
  const msgs = (await graphGet(`/me/chats/${id}/messages?$top=50`, accessToken, fetchImpl)) as { value?: GraphChatMessage[] };
  const lines = (msgs.value ?? [])
    .filter((m) => m.messageType === "message" && !m.deletedDateTime)
    .sort((a, b) => (a.createdDateTime ?? "").localeCompare(b.createdDateTime ?? ""))
    .map((m) => `[${fmtBerlin(m.createdDateTime)}] ${m.from?.user?.displayName ?? m.from?.application?.displayName ?? "?"}: ${stripHtml(m.body?.content ?? "")}`);
  const bodyText = lines.join("\n");
  const last = (msgs.value ?? []).map((m) => m.createdDateTime ?? "").sort().at(-1) ?? new Date().toISOString();
  return {
    kind: "CHAT",
    externalId: chat.id,
    subject: chatTitle(chat),
    from: null,
    participants: (chat.members ?? []).map((m) => ({ name: m.displayName ?? "?", email: m.email || undefined })),
    at: last,
    bodyText,
    attachmentNames: [],
    contentHash: contentHash(chatTitle(chat), bodyText, last),
  };
}

export async function listRealSelectable(accessToken: string, kind: SelectableKind, query: string | undefined, limit: number, fetchImpl: typeof fetch = fetch): Promise<SelectableItem[]> {
  const top = Math.max(1, Math.min(limit, 50));
  if (kind === "CHAT") return listChats(accessToken, query, top, fetchImpl);
  if (kind === "MAIL") {
    const select = "id,subject,from,toRecipients,receivedDateTime,bodyPreview,hasAttachments";
    const path = query?.trim()
      ? `/me/messages?$search=${encodeURIComponent(`"${query.trim().replace(/"/g, "")}"`)}&$select=${select}&$top=${top}`
      : `/me/messages?$select=${select}&$orderby=receivedDateTime desc&$top=${top}`;
    const json = (await graphGet(path, accessToken, fetchImpl)) as { value?: GraphMessage[] };
    return (json.value ?? []).map(messageToSelectable);
  }
  const select = "id,subject,organizer,attendees,start,bodyPreview,hasAttachments";
  const path = `/me/events?$select=${select}&$orderby=start/dateTime desc&$top=${top}`;
  const json = (await graphGet(path, accessToken, fetchImpl)) as { value?: GraphEvent[] };
  let items = (json.value ?? []).map(eventToSelectable);
  if (query?.trim()) {
    const q = query.trim().toLowerCase();
    items = items.filter((i) => i.subject.toLowerCase().includes(q) || i.preview.toLowerCase().includes(q) || (i.from?.name.toLowerCase().includes(q) ?? false));
  }
  return items;
}

export async function fetchRealSource(accessToken: string, kind: SelectableKind, externalId: string, fetchImpl: typeof fetch = fetch): Promise<FetchedSource> {
  if (kind === "CHAT") return fetchChat(accessToken, externalId, fetchImpl);
  if (kind === "MAIL") {
    const select = "id,subject,from,toRecipients,receivedDateTime,body,hasAttachments";
    const m = (await graphGet(`/me/messages/${encodeURIComponent(externalId)}?$select=${select}`, accessToken, fetchImpl)) as GraphMessage;
    const bodyText = m.body?.content ?? m.bodyPreview ?? "";
    return {
      kind: "MAIL",
      externalId: m.id,
      subject: m.subject ?? "(ohne Betreff)",
      from: person(m.from),
      participants: (m.toRecipients ?? []).map(person).filter((p): p is { name: string; email?: string } => p !== null),
      at: m.receivedDateTime ?? new Date().toISOString(),
      bodyText,
      attachmentNames: [], // Anhänge werden nie übernommen (nur Namen zur Anzeige wären ein zweiter Aufruf; bewusst weggelassen)
      contentHash: contentHash(m.subject ?? "", bodyText, m.receivedDateTime ?? ""),
    };
  }
  const select = "id,subject,organizer,attendees,start,body,hasAttachments,responseStatus";
  const e = (await graphGet(`/me/events/${encodeURIComponent(externalId)}?$select=${select}`, accessToken, fetchImpl)) as GraphEvent;
  const bodyText = e.body?.content ?? e.bodyPreview ?? "";
  return {
    kind: "TERMIN",
    externalId: e.id,
    subject: e.subject ?? "(ohne Betreff)",
    from: person(e.organizer),
    participants: (e.attendees ?? []).map((a) => person({ emailAddress: a.emailAddress })).filter((p): p is { name: string; email?: string } => p !== null),
    at: e.start?.dateTime ?? new Date().toISOString(),
    bodyText,
    attachmentNames: [],
    meetingAcceptedByUser: (e.responseStatus?.response ?? "").toLowerCase() === "accepted",
    contentHash: contentHash(e.subject ?? "", bodyText, e.start?.dateTime ?? ""),
  };
}

export async function fetchGraphMe(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<{ displayName?: string; mail?: string; userPrincipalName?: string }> {
  return (await graphGet("/me?$select=displayName,mail,userPrincipalName", accessToken, fetchImpl)) as { displayName?: string; mail?: string; userPrincipalName?: string };
}
