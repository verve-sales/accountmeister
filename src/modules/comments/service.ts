import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db/client";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import { loadActor, type Actor } from "@/modules/identity/actor";
import { notify } from "@/modules/notifications/service";
import { canSeeSubject, resolveSubject } from "@/modules/work/subjects";
import { canViewWorkItem } from "@/modules/work/service";

/**
 * Kommentare am Objekt (Etappe 27): Vorgang, Kunde, Setup, Chance, SOS. Lesen und schreiben darf, wer das Objekt sieht.
 * @-Erwähnungen („@Vorname Nachname“) benachrichtigen die erwähnte Person – aber nur, wenn sie das Objekt auch sehen
 * darf; sonst wird die Erwähnung nicht gesetzt und die Schreiberin erfährt es.
 */
export const commentSubjectValues = ["VORGANG", "KUNDE", "SETUP", "CHANCE", "SOS"] as const;
export type CommentSubject = (typeof commentSubjectValues)[number];

type Target = { label: string; link: string; accountId: string | null; participants: (string | null)[] };

async function resolveTarget(actor: Actor, type: CommentSubject, id: string): Promise<Target> {
  if (type === "VORGANG") {
    const w = await db.query.workItems.findFirst({ where: and(eq(schema.workItems.id, id), eq(schema.workItems.workspaceId, actor.workspaceId)) });
    if (!w || !(await canViewWorkItem(actor, w))) throw new NotFoundError("Vorgang");
    const watchers = await db.query.workWatchers.findMany({ where: eq(schema.workWatchers.workItemId, id) });
    return { label: w.title, link: `/vorgaenge/${id}`, accountId: w.accountId, participants: [w.requesterUserId, w.assigneeUserId, ...watchers.map((x) => x.userId)] };
  }
  const s = await resolveSubject(actor, type, id);
  const participants: (string | null)[] = [];
  if (type === "KUNDE") participants.push((await db.query.accounts.findFirst({ where: eq(schema.accounts.id, id) }))?.responsibleBdUserId ?? null);
  if (type === "SETUP") participants.push((await db.query.projectSetups.findFirst({ where: eq(schema.projectSetups.id, id) }))?.bdUserId ?? null);
  if (type === "CHANCE") participants.push((await db.query.opportunities.findFirst({ where: eq(schema.opportunities.id, id) }))?.ownerUserId ?? null);
  if (type === "SOS") {
    const r = await db.query.sosReports.findFirst({ where: eq(schema.sosReports.id, id) });
    participants.push(r?.ownerUserId ?? null, r?.createdBy ?? null);
  }
  return { label: s.label, link: s.link ?? "/start", accountId: s.accountId, participants };
}

async function canUserSee(userId: string, type: CommentSubject, id: string): Promise<boolean> {
  const other = await loadActor(userId);
  if (!other) return false;
  if (type === "VORGANG") {
    const w = await db.query.workItems.findFirst({ where: eq(schema.workItems.id, id) });
    return !!w && (await canViewWorkItem(other, w));
  }
  return canSeeSubject(other, type, id);
}

const norm = (s: string) => s.toLocaleLowerCase("de-DE").normalize("NFC");

/** Findet „@Name“ im Text – voller Anzeigename oder ohne Klammerzusatz („David Demo (BD)“ → „@David Demo“). */
export function findMentions(body: string, users: { id: string; displayName: string }[]): string[] {
  const text = norm(body);
  const hits = new Set<string>();
  for (const u of users) {
    const names = [u.displayName, u.displayName.replace(/\s*\(.*\)\s*$/, "")].map((n) => norm(n.trim())).filter((n) => n.length >= 3);
    for (const n of names) {
      const at = text.indexOf(`@${n}`);
      if (at >= 0) {
        const after = text.charAt(at + n.length + 1);
        if (!after || !/[\p{L}\p{N}]/u.test(after)) hits.add(u.id);
      }
    }
  }
  return [...hits];
}

export const addCommentInput = z.object({
  subjectType: z.enum(commentSubjectValues),
  subjectId: z.string().min(1),
  body: z.string().trim().min(1, "Der Kommentar ist leer.").max(4000),
});

export async function addComment(actor: Actor, raw: unknown) {
  const p = addCommentInput.safeParse(raw);
  if (!p.success) throw new ValidationError(p.error.issues.map((i) => i.message).join("; "));
  const { subjectType, subjectId, body } = p.data;
  const target = await resolveTarget(actor, subjectType, subjectId);
  const users = await db.query.users.findMany({ where: and(eq(schema.users.workspaceId, actor.workspaceId), eq(schema.users.status, "ACTIVE")), columns: { id: true, displayName: true } });
  const candidates = findMentions(body, users).filter((u) => u !== actor.userId);
  const mentions: string[] = [];
  const skipped: string[] = [];
  for (const u of candidates) {
    if (await canUserSee(u, subjectType, subjectId)) mentions.push(u);
    else skipped.push(users.find((x) => x.id === u)?.displayName ?? "?");
  }
  const previous = await db.query.comments.findMany({ where: and(eq(schema.comments.subjectType, subjectType), eq(schema.comments.subjectId, subjectId)), columns: { authorUserId: true } });
  const participants = [...new Set([...target.participants, ...previous.map((c) => c.authorUserId)])].filter((u): u is string => !!u && !mentions.includes(u));
  const visibleParticipants: string[] = [];
  for (const u of participants) if (u !== actor.userId && (await canUserSee(u, subjectType, subjectId))) visibleParticipants.push(u);

  const comment = await db.transaction(async (tx) => {
    const [c] = await tx.insert(schema.comments).values({ workspaceId: actor.workspaceId, subjectType, subjectId, accountId: target.accountId, authorUserId: actor.userId, body, mentions }).returning();
    await recordAudit(tx, actor, "comment.created", subjectType === "VORGANG" ? "WORK_ITEM" : subjectType, subjectId, { kommentar: c!.id, erwaehnt: mentions.length });
    const anchor = `${target.link}${target.link.includes("#") ? "" : "#kommentare"}`;
    const snippet = body.replace(/\s+/g, " ").slice(0, 90);
    if (mentions.length) await notify(tx, { workspaceId: actor.workspaceId, userIds: mentions, kind: "ERWAEHNT", title: `${actor.displayName} hat dich erwähnt (${target.label}): ${snippet}`, link: anchor, actorUserId: actor.userId });
    if (visibleParticipants.length) await notify(tx, { workspaceId: actor.workspaceId, userIds: visibleParticipants, kind: "KOMMENTAR", title: `${actor.displayName} (${target.label}): ${snippet}`, link: anchor, actorUserId: actor.userId });
    return c!;
  });
  return { comment, skipped };
}

export async function listComments(actor: Actor, subjectType: CommentSubject, subjectId: string) {
  await resolveTarget(actor, subjectType, subjectId);
  const rows = await db.query.comments.findMany({ where: and(eq(schema.comments.subjectType, subjectType), eq(schema.comments.subjectId, subjectId), eq(schema.comments.workspaceId, actor.workspaceId)), orderBy: asc(schema.comments.createdAt) });
  const users = await db.query.users.findMany({ where: eq(schema.users.workspaceId, actor.workspaceId), columns: { id: true, displayName: true } });
  const un = new Map(users.map((u) => [u.id, u.displayName]));
  return rows.map((c) => ({ ...c, authorName: un.get(c.authorUserId) ?? "?", mentionNames: (c.mentions as string[]).map((m) => un.get(m) ?? "?"), own: c.authorUserId === actor.userId }));
}

export const editCommentInput = z.object({ body: z.string().trim().min(1, "Der Kommentar ist leer.").max(4000) });

export async function editComment(actor: Actor, commentId: string, raw: unknown) {
  const p = editCommentInput.safeParse(raw);
  if (!p.success) throw new ValidationError(p.error.issues.map((i) => i.message).join("; "));
  const c = await db.query.comments.findFirst({ where: and(eq(schema.comments.id, commentId), eq(schema.comments.workspaceId, actor.workspaceId)) });
  if (!c || c.deletedAt) throw new NotFoundError("Kommentar");
  if (c.authorUserId !== actor.userId) throw new ForbiddenError("Nur eigene Kommentare lassen sich bearbeiten.");
  await db.transaction(async (tx) => {
    await tx.update(schema.comments).set({ body: p.data.body, editedAt: new Date() }).where(eq(schema.comments.id, commentId));
    await recordAudit(tx, actor, "comment.edited", c.subjectType === "VORGANG" ? "WORK_ITEM" : c.subjectType, c.subjectId, { kommentar: commentId });
  });
}

export async function deleteComment(actor: Actor, commentId: string) {
  const c = await db.query.comments.findFirst({ where: and(eq(schema.comments.id, commentId), eq(schema.comments.workspaceId, actor.workspaceId)) });
  if (!c || c.deletedAt) throw new NotFoundError("Kommentar");
  if (c.authorUserId !== actor.userId) throw new ForbiddenError("Nur eigene Kommentare lassen sich löschen.");
  await db.transaction(async (tx) => {
    await tx.update(schema.comments).set({ body: "", deletedAt: new Date(), mentions: [] }).where(eq(schema.comments.id, commentId));
    await recordAudit(tx, actor, "comment.deleted", c.subjectType === "VORGANG" ? "WORK_ITEM" : c.subjectType, c.subjectId, { kommentar: commentId });
  });
}

