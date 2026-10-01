import { and, count, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { db, schema, type Db, type Tx } from "@/db/client";
import { getConfig } from "@/lib/config";
import { ValidationError } from "@/lib/errors";
import type { Actor } from "@/modules/identity/actor";
import { deputyOf } from "@/modules/work/teams";

/**
 * Benachrichtigungen (Etappe 27). Jede Benachrichtigung entsteht in derselben Transaktion wie die fachliche Änderung
 * (Outbox): Postfach im Tool sofort, E-Mail je nach Einstellung sofort (PENDING) oder im Tagesdigest (DIGEST).
 * Ist der E-Mail-Versand ausgeschaltet (MAIL_TRANSPORT=off), entstehen nur Einträge im Postfach.
 */

export const notificationKinds = ["ZUGEWIESEN", "TEAM_EINGANG", "ANGENOMMEN", "ABGELEHNT", "ZUR_PRUEFUNG", "ZURUECKGEGEBEN", "ERLEDIGT", "KOMMENTAR", "ERWAEHNT", "UEBERFAELLIG", "SOS"] as const;
export type NotificationKind = (typeof notificationKinds)[number];

export const notificationKindLabel: Record<NotificationKind, string> = {
  ZUGEWIESEN: "Mir zugewiesen",
  TEAM_EINGANG: "Neu im Team-Eingang",
  ANGENOMMEN: "Meine Anfrage wurde angenommen",
  ABGELEHNT: "Meine Anfrage wurde abgelehnt",
  ZUR_PRUEFUNG: "Ergebnis zur Prüfung",
  ZURUECKGEGEBEN: "Zur Nacharbeit zurückgegeben",
  ERLEDIGT: "Vorgang erledigt",
  KOMMENTAR: "Neuer Kommentar",
  ERWAEHNT: "Ich wurde erwähnt",
  UEBERFAELLIG: "Überfällig",
  SOS: "SOS ausgelöst",
};

/** Sofort per E-Mail (Standard); alle anderen gehen in den Tagesdigest. */
export const IMMEDIATE_DEFAULT: Record<NotificationKind, boolean> = {
  ZUGEWIESEN: true,
  TEAM_EINGANG: true,
  ANGENOMMEN: false,
  ABGELEHNT: true,
  ZUR_PRUEFUNG: true,
  ZURUECKGEGEBEN: true,
  ERLEDIGT: false,
  KOMMENTAR: false,
  ERWAEHNT: true,
  UEBERFAELLIG: true,
  SOS: true,
};

export type Prefs = { email: Partial<Record<NotificationKind, boolean>>; digest: boolean };

export function effectivePrefs(raw: unknown): { email: Record<NotificationKind, boolean>; digest: boolean } {
  const p = (raw ?? {}) as Partial<Prefs>;
  const email = { ...IMMEDIATE_DEFAULT };
  for (const k of notificationKinds) if (typeof p.email?.[k] === "boolean") email[k] = p.email[k]!;
  return { email, digest: p.digest ?? true };
}

export type NotifyInput = {
  workspaceId: string;
  userIds: (string | null | undefined)[];
  kind: NotificationKind;
  title: string;
  link: string;
  actorUserId?: string | null;
  dedupeKey?: string | null;
};

/**
 * Benachrichtigt Personen (ohne die auslösende Person selbst). Abwesende mit Vertretung: Eintrag ohne E-Mail für die
 * abwesende Person, zusätzlich vollwertig an die Vertretung.
 */
export async function notify(tx: Tx | Db, n: NotifyInput): Promise<number> {
  const targets = [...new Set(n.userIds.filter((u): u is string => !!u && u !== n.actorUserId))];
  if (!targets.length) return 0;
  const transportOn = getConfig().MAIL_TRANSPORT !== "off";
  const prefsRows = await tx.query.notificationPrefs.findMany({ where: inArray(schema.notificationPrefs.userId, targets) });
  const prefsOf = new Map(prefsRows.map((r) => [r.userId, effectivePrefs(r.prefs)]));
  const values: (typeof schema.notifications.$inferInsert)[] = [];
  const deputies = new Map<string, string>();
  for (const userId of targets) {
    const deputy = await deputyOf(userId, undefined, tx);
    if (deputy && deputy !== n.actorUserId) deputies.set(userId, deputy);
  }
  const extra = [...new Set(deputies.values())].filter((d) => !targets.includes(d));
  if (extra.length) {
    const rows = await tx.query.notificationPrefs.findMany({ where: inArray(schema.notificationPrefs.userId, extra) });
    for (const r of rows) prefsOf.set(r.userId, effectivePrefs(r.prefs));
  }
  const stateFor = (userId: string) => {
    if (!transportOn) return "NONE";
    const p = prefsOf.get(userId) ?? effectivePrefs(null);
    if (p.email[n.kind]) return "PENDING";
    return p.digest ? "DIGEST" : "NONE";
  };
  for (const userId of targets) {
    const absentWithDeputy = deputies.has(userId);
    values.push({ workspaceId: n.workspaceId, userId, kind: n.kind, title: n.title, link: n.link, actorUserId: n.actorUserId ?? null, dedupeKey: n.dedupeKey ?? null, emailState: absentWithDeputy ? "NONE" : stateFor(userId) });
  }
  for (const [absent, deputy] of deputies) {
    const name = (await tx.query.users.findFirst({ where: eq(schema.users.id, absent), columns: { displayName: true } }))?.displayName ?? "Kolleg:in";
    values.push({ workspaceId: n.workspaceId, userId: deputy, kind: n.kind, title: `Vertretung für ${name}: ${n.title}`, link: n.link, actorUserId: n.actorUserId ?? null, dedupeKey: n.dedupeKey ? `${n.dedupeKey}:vertretung:${absent}` : null, emailState: stateFor(deputy) });
  }
  const inserted = await tx.insert(schema.notifications).values(values).onConflictDoNothing().returning({ id: schema.notifications.id });
  return inserted.length;
}

export async function listNotifications(actor: Actor, limit = 100) {
  const rows = await db.query.notifications.findMany({ where: eq(schema.notifications.userId, actor.userId), orderBy: desc(schema.notifications.createdAt), limit });
  const actorIds = [...new Set(rows.map((r) => r.actorUserId).filter((x): x is string => !!x))];
  const users = actorIds.length ? await db.query.users.findMany({ where: inArray(schema.users.id, actorIds), columns: { id: true, displayName: true } }) : [];
  const un = new Map(users.map((u) => [u.id, u.displayName]));
  return rows.map((r) => ({ ...r, actorName: r.actorUserId ? un.get(r.actorUserId) ?? null : null }));
}

export async function unreadCount(actor: Actor): Promise<number> {
  const [r] = await db.select({ n: count() }).from(schema.notifications).where(and(eq(schema.notifications.userId, actor.userId), isNull(schema.notifications.readAt)));
  return Number(r?.n ?? 0);
}

export async function markRead(actor: Actor, notificationId?: string | null) {
  const where = notificationId
    ? and(eq(schema.notifications.userId, actor.userId), eq(schema.notifications.id, notificationId), isNull(schema.notifications.readAt))
    : and(eq(schema.notifications.userId, actor.userId), isNull(schema.notifications.readAt));
  await db.update(schema.notifications).set({ readAt: new Date() }).where(where);
}

/** Öffnen einer Benachrichtigung: als gelesen markieren und Ziel zurückgeben (nur interne Pfade). */
export async function openNotification(actor: Actor, notificationId: string): Promise<string> {
  const n = await db.query.notifications.findFirst({ where: and(eq(schema.notifications.id, notificationId), eq(schema.notifications.userId, actor.userId)) });
  if (!n) return "/benachrichtigungen";
  if (!n.readAt) await db.update(schema.notifications).set({ readAt: new Date() }).where(eq(schema.notifications.id, n.id));
  return n.link.startsWith("/") && !n.link.startsWith("//") ? n.link : "/benachrichtigungen";
}

export async function getMyPrefs(actor: Actor) {
  const row = await db.query.notificationPrefs.findFirst({ where: eq(schema.notificationPrefs.userId, actor.userId) });
  return effectivePrefs(row?.prefs);
}

const truthy = (v: unknown) => v === true || v === "true" || v === "on";

/** Formular: je Ereignisart Feld `email_<KIND>` (Checkbox) und `digest`. */
export async function saveMyPrefs(actor: Actor, raw: Record<string, unknown>) {
  if (!raw || typeof raw !== "object") throw new ValidationError("Ungültige Angabe.");
  const email: Partial<Record<NotificationKind, boolean>> = {};
  for (const k of notificationKinds) email[k] = truthy(raw[`email_${k}`]);
  const prefs: Prefs = { email, digest: truthy(raw.digest) };
  z.object({ digest: z.boolean() }).parse({ digest: prefs.digest });
  await db.insert(schema.notificationPrefs).values({ userId: actor.userId, prefs }).onConflictDoUpdate({ target: schema.notificationPrefs.userId, set: { prefs, updatedAt: new Date() } });
}
