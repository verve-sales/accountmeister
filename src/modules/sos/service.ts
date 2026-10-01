import { and, desc, eq, inArray, ne, or } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db/client";
import { ConflictError, ForbiddenError, NotFoundError, TransitionError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import { notify } from "@/modules/notifications/service";
import type { Actor } from "@/modules/identity/actor";
import { getAccount, listVisibleAccounts } from "@/modules/accounts/service";
import { canMaintainAgenda } from "@/modules/agenda/service";

/**
 * SOS-Protokolle (Etappe 26): Wenn es eng wird – ein Einsatz läuft ohne Anschluss aus, der Anker kommt beim Kunden
 * nicht mehr weiter, Budget/Zufriedenheit/Konflikt spitzen sich zu. Jeder aus dem Kundenteam (auch der Anker) kann ein
 * SOS auslösen; es landet unübersehbar bei BD und Principal, zählt im Health-Check als Risiko und bleibt offen, bis
 * jemand die Lösung dokumentiert.
 */

export const sosKindValues = ["EINSATZ_LAEUFT_AUS", "ANKER_BLOCKIERT", "LAGE_ENG", "SONSTIGES"] as const;
export type SosKind = (typeof sosKindValues)[number];
export const sosKindLabel: Record<SosKind, string> = {
  EINSATZ_LAEUFT_AUS: "Einsatz läuft aus – kein Anschluss in Sicht",
  ANKER_BLOCKIERT: "Anker kommt nicht weiter",
  LAGE_ENG: "Lage wird eng (Budget, Zufriedenheit, Konflikt)",
  SONSTIGES: "Sonstiges",
};
export const sosStatusValues = ["OFFEN", "IN_BEARBEITUNG", "GELOEST"] as const;
export const sosStatusLabel: Record<string, string> = { OFFEN: "offen", IN_BEARBEITUNG: "in Bearbeitung", GELOEST: "gelöst" };

export const createSosInput = z.object({
  accountId: z.string().min(1),
  setupId: z.string().optional().or(z.literal("")),
  orderId: z.string().optional().or(z.literal("")),
  kind: z.enum(sosKindValues),
  title: z.string().trim().min(3, "Bitte kurz benennen, worum es geht").max(200),
  situation: z.string().trim().min(10, "Bitte die Lage in ein, zwei Sätzen beschreiben").max(4000),
  need: z.string().trim().max(2000).optional().or(z.literal("")),
  urgency: z.enum(["HOCH", "MITTEL"]).default("HOCH"),
});

export async function createSos(actor: Actor, raw: unknown) {
  const parsed = createSosInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const i = parsed.data;
  const account = await getAccount(actor, i.accountId); // Kundenteam inkl. Anker über ihre Setup-Beteiligung
  if (i.setupId) {
    const s = await db.query.projectSetups.findFirst({ where: eq(schema.projectSetups.id, i.setupId) });
    if (!s || s.accountId !== account.id) throw new ValidationError("Das Setup gehört nicht zu diesem Kunden.");
  }
  if (i.orderId) {
    const o = await db.query.orders.findFirst({ where: eq(schema.orders.id, i.orderId) });
    const opp = o && (await db.query.opportunities.findFirst({ where: eq(schema.opportunities.id, o.opportunityId) }));
    if (!opp || opp.accountId !== account.id) throw new ValidationError("Der Einsatz gehört nicht zu diesem Kunden.");
  }
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(schema.sosReports)
      .values({ workspaceId: actor.workspaceId, accountId: account.id, setupId: i.setupId || null, orderId: i.orderId || null, kind: i.kind, title: i.title, situation: i.situation, need: i.need || null, urgency: i.urgency, ownerUserId: account.responsibleBdUserId ?? null, createdBy: actor.userId })
      .returning();
    await recordAudit(tx, actor, "sos.created", "ACCOUNT", account.id, { art: i.kind, titel: i.title });
    // BD und kundenbezogene Principals sofort benachrichtigen
    const principals = await tx
      .select({ userId: schema.roleAssignments.userId })
      .from(schema.roleAssignments)
      .where(and(eq(schema.roleAssignments.accountId, account.id), eq(schema.roleAssignments.role, "PRINCIPAL")));
    await notify(tx, { workspaceId: actor.workspaceId, userIds: [account.responsibleBdUserId, ...principals.map((p) => p.userId)], kind: "SOS", title: `SOS bei ${account.name}: ${i.title}`, link: `/kunden/${account.id}#sos`, actorUserId: actor.userId });
    return row!;
  });
}

export const sosStatusInput = z.object({ version: z.coerce.number().int().positive(), status: z.enum(sosStatusValues), resolution: z.string().trim().max(4000).optional().or(z.literal("")) });

export async function changeSosStatus(actor: Actor, sosId: string, raw: unknown) {
  const parsed = sosStatusInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError("Ungültige Angabe.");
  const sos = await db.query.sosReports.findFirst({ where: and(eq(schema.sosReports.id, sosId), eq(schema.sosReports.workspaceId, actor.workspaceId)) });
  if (!sos) throw new NotFoundError("SOS");
  const account = await getAccount(actor, sos.accountId);
  if (!(canMaintainAgenda(actor, account) || sos.createdBy === actor.userId || sos.ownerUserId === actor.userId)) throw new ForbiddenError("Ein SOS bearbeiten BD, Principal, Sales Operations oder wer es ausgelöst hat.");
  const i = parsed.data;
  if (sos.status === "GELOEST" && i.status !== "OFFEN") throw new TransitionError("Dieses SOS ist bereits gelöst.");
  if (i.status === "GELOEST" && (!i.resolution || i.resolution.length < 5)) throw new ValidationError("Bitte kurz festhalten, wie es gelöst wurde.");
  const [u] = await db
    .update(schema.sosReports)
    .set({ status: i.status, resolution: i.status === "GELOEST" ? i.resolution! : sos.resolution, ownerUserId: sos.ownerUserId ?? actor.userId, resolvedAt: i.status === "GELOEST" ? new Date() : null, updatedAt: new Date(), version: sos.version + 1 })
    .where(and(eq(schema.sosReports.id, sosId), eq(schema.sosReports.version, i.version)))
    .returning();
  if (!u) throw new ConflictError();
  await recordAudit(db, actor, "sos.status", "ACCOUNT", sos.accountId, { status: i.status });
  return u;
}

export async function listSosForAccount(actor: Actor, accountId: string) {
  const account = await getAccount(actor, accountId);
  return db.query.sosReports.findMany({ where: eq(schema.sosReports.accountId, account.id), orderBy: [desc(schema.sosReports.createdAt)] });
}

/** Offene SOS im Sichtbereich (Startseite): Kunden der Person plus selbst ausgelöste. */
export async function listOpenSosForActor(actor: Actor) {
  const accounts = (await listVisibleAccounts(actor)).filter((a) => a.status !== "ARCHIVED");
  const ids = accounts.map((a) => a.id);
  const rows = await db.query.sosReports.findMany({
    where: and(eq(schema.sosReports.workspaceId, actor.workspaceId), ne(schema.sosReports.status, "GELOEST"), ids.length ? or(inArray(schema.sosReports.accountId, ids), eq(schema.sosReports.createdBy, actor.userId)) : eq(schema.sosReports.createdBy, actor.userId)),
    orderBy: [desc(schema.sosReports.createdAt)],
    limit: 20,
  });
  const names = new Map(accounts.map((a) => [a.id, a.name]));
  const missing = rows.filter((r) => !names.has(r.accountId)).map((r) => r.accountId);
  if (missing.length) for (const a of await db.query.accounts.findMany({ where: inArray(schema.accounts.id, missing) })) names.set(a.id, a.name);
  return rows.map((r) => ({ ...r, accountName: names.get(r.accountId) ?? "?" }));
}

/** Offene SOS je Kunde (für den Health-Check). */
export async function openSosByAccount(accountIds: string[]): Promise<Map<string, { title: string; kind: string }[]>> {
  const out = new Map<string, { title: string; kind: string }[]>();
  if (!accountIds.length) return out;
  const rows = await db.query.sosReports.findMany({ where: and(inArray(schema.sosReports.accountId, accountIds), ne(schema.sosReports.status, "GELOEST")), columns: { accountId: true, title: true, kind: true } });
  for (const r of rows) out.set(r.accountId, [...(out.get(r.accountId) ?? []), { title: r.title, kind: r.kind }]);
  return out;
}
