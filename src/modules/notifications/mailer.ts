import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, asc, eq, inArray, lt } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { getConfig, type AppConfig } from "@/lib/config";
import { notificationKindLabel, type NotificationKind } from "./service";

/**
 * E-Mail-Versand der Benachrichtigungen (Etappe 27). Transport per MAIL_TRANSPORT:
 * - off: nichts wird versendet (Standard),
 * - file: .eml-Dateien in MAIL_FILE_DIR (Entwicklung, Prüfung ohne Postfach),
 * - graph: Microsoft Graph `sendMail` mit der vorhandenen Entra-App (Anwendungsberechtigung Mail.Send, Absender MAIL_SENDER).
 * E-Mails enthalten nur Titel und Link – nie Inhalte aus Quellen.
 */

export type Mail = { to: string; subject: string; text: string; html: string };

export function baseUrl(cfg: AppConfig = getConfig()): string {
  if (cfg.APP_BASE_URL) return cfg.APP_BASE_URL.replace(/\/$/, "");
  if (cfg.OIDC_REDIRECT_URI) return new URL(cfg.OIDC_REDIRECT_URI).origin;
  return "http://localhost:3000";
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function renderSingle(n: { kind: string; title: string; link: string }, base: string): Omit<Mail, "to"> {
  const url = `${base}${n.link}`;
  const label = notificationKindLabel[n.kind as NotificationKind] ?? "Hinweis";
  return {
    subject: `Accountmeister – ${label}: ${n.title}`.slice(0, 200),
    text: `${label}\n\n${n.title}\n\nÖffnen: ${url}\n\nDiese Nachricht kommt aus dem Accountmeister. Benachrichtigungen stellst du unter Einstellungen ein.`,
    html: `<p style="font-family:sans-serif;color:#555">${esc(label)}</p><p style="font-family:sans-serif;font-size:16px"><strong>${esc(n.title)}</strong></p><p style="font-family:sans-serif"><a href="${esc(url)}">Im Accountmeister öffnen</a></p><p style="font-family:sans-serif;color:#888;font-size:12px">Benachrichtigungen stellst du im Accountmeister unter Einstellungen ein.</p>`,
  };
}

export function renderDigest(items: { kind: string; title: string; link: string }[], base: string): Omit<Mail, "to"> {
  const lines = items.map((n) => `• ${notificationKindLabel[n.kind as NotificationKind] ?? ""}: ${n.title}\n  ${base}${n.link}`);
  return {
    subject: `Accountmeister – Tagesüberblick (${items.length} ${items.length === 1 ? "Hinweis" : "Hinweise"})`,
    text: `Dein Tagesüberblick:\n\n${lines.join("\n")}\n\nAlle Hinweise: ${base}/benachrichtigungen`,
    html: `<p style="font-family:sans-serif">Dein Tagesüberblick:</p><ul style="font-family:sans-serif">${items.map((n) => `<li><span style="color:#777">${esc(notificationKindLabel[n.kind as NotificationKind] ?? "")}:</span> <a href="${esc(base + n.link)}">${esc(n.title)}</a></li>`).join("")}</ul><p style="font-family:sans-serif"><a href="${esc(base)}/benachrichtigungen">Alle Hinweise</a></p>`,
  };
}

// --- Transporte ---------------------------------------------------------------

let tokenCache: { token: string; until: number } | null = null;

async function graphToken(cfg: AppConfig): Promise<string> {
  if (tokenCache && tokenCache.until > Date.now() + 60_000) return tokenCache.token;
  const tenant = cfg.MAIL_GRAPH_TENANT_ID ?? cfg.OIDC_ISSUER?.match(/microsoftonline\.com\/([^/]+)/)?.[1];
  if (!tenant || !cfg.OIDC_CLIENT_ID || !cfg.OIDC_CLIENT_SECRET) throw new Error("Graph-Versand: Mandant, OIDC_CLIENT_ID oder OIDC_CLIENT_SECRET fehlt.");
  const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: cfg.OIDC_CLIENT_ID, client_secret: cfg.OIDC_CLIENT_SECRET, grant_type: "client_credentials", scope: "https://graph.microsoft.com/.default" }),
  });
  if (!res.ok) throw new Error(`Graph-Token: HTTP ${res.status}`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache = { token: j.access_token, until: Date.now() + j.expires_in * 1000 };
  return j.access_token;
}

export async function sendMail(mail: Mail, cfg: AppConfig = getConfig()): Promise<void> {
  if (cfg.MAIL_TRANSPORT === "off") return;
  if (cfg.MAIL_TRANSPORT === "file") {
    await mkdir(cfg.MAIL_FILE_DIR, { recursive: true });
    const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}.eml`;
    const eml = `To: ${mail.to}\r\nSubject: ${mail.subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${mail.text}\r\n`;
    await writeFile(path.join(cfg.MAIL_FILE_DIR, name), eml, "utf8");
    return;
  }
  if (!cfg.MAIL_SENDER) throw new Error("Graph-Versand: MAIL_SENDER fehlt.");
  const token = await graphToken(cfg);
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(cfg.MAIL_SENDER)}/sendMail`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ message: { subject: mail.subject, body: { contentType: "HTML", content: mail.html }, toRecipients: [{ emailAddress: { address: mail.to } }] }, saveToSentItems: false }),
  });
  if (!res.ok) throw new Error(`Graph-Versand: HTTP ${res.status}`);
}

// --- Abarbeitung ----------------------------------------------------------------

const MAX_ATTEMPTS = 5;

/** Sofort-Mails versenden (PENDING). Gibt die Zahl versendeter Mails zurück. */
export async function dispatchPendingEmails(cfg: AppConfig = getConfig(), limit = 50): Promise<number> {
  if (cfg.MAIL_TRANSPORT === "off") return 0;
  const rows = await db.query.notifications.findMany({ where: and(eq(schema.notifications.emailState, "PENDING"), lt(schema.notifications.emailAttempts, MAX_ATTEMPTS)), orderBy: asc(schema.notifications.createdAt), limit });
  if (!rows.length) return 0;
  const users = await db.query.users.findMany({ where: inArray(schema.users.id, [...new Set(rows.map((r) => r.userId))]), columns: { id: true, email: true, status: true } });
  const um = new Map(users.map((u) => [u.id, u]));
  const base = baseUrl(cfg);
  let sent = 0;
  for (const n of rows) {
    const u = um.get(n.userId);
    if (!u || u.status !== "ACTIVE") {
      await db.update(schema.notifications).set({ emailState: "NONE" }).where(eq(schema.notifications.id, n.id));
      continue;
    }
    try {
      await sendMail({ to: u.email, ...renderSingle(n, base) }, cfg);
      await db.update(schema.notifications).set({ emailState: "SENT", emailedAt: new Date(), emailAttempts: n.emailAttempts + 1 }).where(eq(schema.notifications.id, n.id));
      sent++;
    } catch (e) {
      const attempts = n.emailAttempts + 1;
      await db.update(schema.notifications).set({ emailAttempts: attempts, emailState: attempts >= MAX_ATTEMPTS ? "FAILED" : "PENDING" }).where(eq(schema.notifications.id, n.id));
      console.error("E-Mail-Versand fehlgeschlagen", (e as Error).message);
    }
  }
  return sent;
}

/** Tagesdigest: alle DIGEST-Einträge je Person in einer Mail. */
export async function dispatchDigests(cfg: AppConfig = getConfig()): Promise<number> {
  if (cfg.MAIL_TRANSPORT === "off") return 0;
  const rows = await db.query.notifications.findMany({ where: eq(schema.notifications.emailState, "DIGEST"), orderBy: asc(schema.notifications.createdAt), limit: 2000 });
  const byUser = new Map<string, typeof rows>();
  for (const r of rows) byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), r]);
  const base = baseUrl(cfg);
  let sent = 0;
  for (const [userId, items] of byUser) {
    const u = await db.query.users.findFirst({ where: eq(schema.users.id, userId), columns: { email: true, status: true } });
    const ids = items.map((i) => i.id);
    if (!u || u.status !== "ACTIVE") {
      await db.update(schema.notifications).set({ emailState: "NONE" }).where(inArray(schema.notifications.id, ids));
      continue;
    }
    const unread = items.filter((i) => !i.readAt);
    if (!unread.length) {
      await db.update(schema.notifications).set({ emailState: "NONE" }).where(inArray(schema.notifications.id, ids));
      continue;
    }
    try {
      await sendMail({ to: u.email, ...renderDigest(unread, base) }, cfg);
      await db.update(schema.notifications).set({ emailState: "SENT", emailedAt: new Date() }).where(inArray(schema.notifications.id, ids));
      sent++;
    } catch (e) {
      console.error("Digest-Versand fehlgeschlagen", (e as Error).message);
    }
  }
  return sent;
}
