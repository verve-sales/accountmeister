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

export async function listRealSelectable(accessToken: string, kind: SelectableKind, query: string | undefined, limit: number, fetchImpl: typeof fetch = fetch): Promise<SelectableItem[]> {
  const top = Math.max(1, Math.min(limit, 50));
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
