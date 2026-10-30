import { and, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import { hasRole, type Actor } from "@/modules/identity/actor";
import { hasRoleForAccountWrite } from "@/modules/identity/authz";
import { computeHealthFor, type Level } from "@/modules/health/service";
import { headsAt } from "@/modules/principals/service";
import { plusDaysIso, todayIso } from "@/modules/work/calendar";

/**
 * Kundenrunde (Etappe 45): alle zwei Wochen schaut die Geschäftsführung mit den Kundenverantwortlichen (Account Leads,
 * Principals) auf die Bestandskunden – Sattelfestigkeit, Nachhaltigkeit der Assignments, Interessantes seit der letzten
 * Runde. Alles ist aus dem Tool vorbefüllt; die Verantwortlichen bestätigen je Kunde und schreiben bei Bedarf einen Satz.
 * Prospects und Ex-Kunden erscheinen nur „auf dem Radar“, Nebengeschäft gar nicht.
 */

export type AccountKind = "BESTAND" | "EX" | "PROSPECT";
export const accountKindLabel: Record<AccountKind, string> = { BESTAND: "Bestandskunde", EX: "Ex-Kunde", PROSPECT: "Prospect" };

const RUNNING = ["GEPLANT", "AKTIV", "PAUSIERT", "ENDET"];
const NOT_COUNTING = ["VORBEREITUNG", "ABGEBROCHEN"];

/** Kundenart aus den Einsätzen: laufender Einsatz → Bestandskunde; früher einer → Ex-Kunde; nie einer → Prospect. */
export async function accountKinds(accountIds: string[]): Promise<Map<string, AccountKind>> {
  const out = new Map<string, AccountKind>();
  if (!accountIds.length) return out;
  const engs = await db.query.engagements.findMany({ where: inArray(schema.engagements.accountId, accountIds), columns: { accountId: true, status: true } });
  for (const id of accountIds) {
    const mine = engs.filter((e) => e.accountId === id && !NOT_COUNTING.includes(e.status));
    out.set(id, mine.some((e) => RUNNING.includes(e.status)) ? "BESTAND" : mine.length ? "EX" : "PROSPECT");
  }
  return out;
}

/** Kundenverantwortung je Kunde: genau eine kundenbezogene Principal-Zuordnung (Stufe Account Lead oder Principal). */
export async function responsibles(workspaceId: string): Promise<Map<string, { userId: string; name: string; level: "PRINCIPAL" | "ACCOUNT_LEAD" }>> {
  const t = todayIso();
  const rows = (await db.query.roleAssignments.findMany({ where: and(eq(schema.roleAssignments.workspaceId, workspaceId), eq(schema.roleAssignments.role, "PRINCIPAL"), eq(schema.roleAssignments.scope, "ACCOUNT")) })).filter((r) => r.accountId && (!r.validTo || r.validTo >= t));
  const users = rows.length ? await db.query.users.findMany({ where: and(inArray(schema.users.id, [...new Set(rows.map((r) => r.userId))]), eq(schema.users.status, "ACTIVE")), columns: { id: true, displayName: true } }) : [];
  const out = new Map<string, { userId: string; name: string; level: "PRINCIPAL" | "ACCOUNT_LEAD" }>();
  for (const r of rows) {
    const u = users.find((x) => x.id === r.userId);
    if (u && !out.has(r.accountId!)) out.set(r.accountId!, { userId: u.id, name: u.displayName, level: r.level === "ACCOUNT_LEAD" ? "ACCOUNT_LEAD" : "PRINCIPAL" });
  }
  return out;
}

function isCircleMember(actor: Actor): boolean {
  return actor.roles.has("PRINCIPAL") || [...actor.accountRoles.values()].some((r) => r.has("PRINCIPAL"));
}

export function canSeeRound(actor: Actor): boolean {
  return hasRole(actor, "CEO") || isCircleMember(actor);
}

export type Ampel = "ROT" | "GELB" | "GRUEN";
export const ampelLabel: Record<Ampel, string> = { ROT: "rot", GELB: "gelb", GRUEN: "grün" };

export type RoundAccount = {
  accountId: string;
  name: string;
  ampel: Ampel;
  reasons: string[];
  health: { score: number | null; level: Level; coverage: number } | null;
  headsNow: number;
  headsBefore: number;
  ending: { engagementId: string; person: string; plannedEnd: string; daysToEnd: number; renewal: string }[];
  interesting: { newChances: { id: string; title: string }[]; openCards: number; newPersons: string[] };
  prep: { note: string | null; authorName: string; at: Date } | null;
  mayPrepare: boolean;
  /** Kundenverantwortliche Person (userId) – null: noch niemand */
  group: string | null;
};

export type RoundGroup = { userId: string | null; name: string; level: "PRINCIPAL" | "ACCOUNT_LEAD" | null; accounts: RoundAccount[] };
export type RadarLine = { accountId: string; name: string; kind: AccountKind; responsibleName: string | null; openChances: number; prep: { note: string | null; authorName: string; at: Date } | null; mayPrepare: boolean };

const renewalText: Record<string, string> = { ZU_KLAEREN: "Verlängerung zu klären", IN_ABSTIMMUNG: "Verlängerung in Abstimmung", ANGEBOTEN: "Verlängerung angeboten", BESTAETIGT: "verlängert", ABGELEHNT: "endet (keine Verlängerung)", ERLEDIGT: "erledigt" };

export async function buildRound(actor: Actor, today = todayIso()) {
  if (!canSeeRound(actor)) throw new ForbiddenError("Die Kundenrunde sehen die Geschäftsführung und die Kundenverantwortlichen.");
  const isGf = hasRole(actor, "CEO");
  const [accounts, resp, lastRound] = await Promise.all([
    db.query.accounts.findMany({ where: and(eq(schema.accounts.workspaceId, actor.workspaceId), inArray(schema.accounts.status, ["ACTIVE", "DORMANT"])) }),
    responsibles(actor.workspaceId),
    db.query.customerRounds.findFirst({ where: eq(schema.customerRounds.workspaceId, actor.workspaceId), orderBy: desc(schema.customerRounds.heldOn) }),
  ]);
  const since = lastRound?.heldOn ?? plusDaysIso(today, -14);
  const kinds = await accountKinds(accounts.map((a) => a.id));
  // GF sieht alle; Kundenverantwortliche nur ihre eigenen Kunden
  const visible = accounts.filter((a) => isGf || resp.get(a.id)?.userId === actor.userId);
  const inRound = visible.filter((a) => kinds.get(a.id) === "BESTAND" && !a.sideBusiness);
  const radar = visible.filter((a) => a.onRadar && !a.sideBusiness && kinds.get(a.id) !== "BESTAND");
  const ids = inRound.map((a) => a.id);
  const allIds = [...ids, ...radar.map((a) => a.id)];
  const sinceDate = new Date(`${since}T00:00:00Z`);
  const [health, engs, opps, cards, persons, notes, users] = await Promise.all([
    computeHealthFor(inRound.map((a) => ({ id: a.id, name: a.name }))).catch(() => []),
    ids.length ? db.query.engagements.findMany({ where: inArray(schema.engagements.accountId, ids) }) : Promise.resolve([]),
    allIds.length ? db.query.opportunities.findMany({ where: inArray(schema.opportunities.accountId, allIds), columns: { id: true, accountId: true, title: true, status: true, createdAt: true } }) : Promise.resolve([]),
    ids.length ? db.query.suggestions.findMany({ where: and(inArray(schema.suggestions.accountId, ids), inArray(schema.suggestions.status, ["NEU", "GEPRUEFT"])), columns: { accountId: true } }) : Promise.resolve([]),
    ids.length ? db.query.persons.findMany({ where: and(inArray(schema.persons.accountId, ids), gte(schema.persons.createdAt, sinceDate)), columns: { accountId: true, displayName: true } }) : Promise.resolve([]),
    allIds.length ? db.query.roundNotes.findMany({ where: and(inArray(schema.roundNotes.accountId, allIds), isNull(schema.roundNotes.roundId)), orderBy: desc(schema.roundNotes.createdAt) }) : Promise.resolve([]),
    db.query.users.findMany({ where: eq(schema.users.workspaceId, actor.workspaceId), columns: { id: true, displayName: true } }),
  ]);
  const un = new Map(users.map((u) => [u.id, u.displayName]));
  const running = engs.filter((e) => RUNNING.includes(e.status));
  const decisions = running.length ? await db.query.renewalDecisions.findMany({ where: inArray(schema.renewalDecisions.engagementId, running.map((e) => e.id)), orderBy: desc(schema.renewalDecisions.createdAt) }) : [];
  const fls = running.some((e) => e.freelancerId) ? await db.query.freelancers.findMany({ where: inArray(schema.freelancers.id, running.map((e) => e.freelancerId).filter((x): x is string => !!x)), columns: { id: true, displayName: true } }) : [];
  const prepOf = (accountId: string) => {
    const n = notes.find((x) => x.accountId === accountId);
    return n ? { note: n.note, authorName: un.get(n.authorUserId) ?? "?", at: n.createdAt } : null;
  };
  const mayPrep = (accountId: string) => isGf || resp.get(accountId)?.userId === actor.userId;
  const day = (a: string, b: string) => Math.round((new Date(a).getTime() - new Date(b).getTime()) / 86400000);

  const rows: RoundAccount[] = inRound.map((a) => {
    const h = health.find((x) => x.accountId === a.id) ?? null;
    const mine = engs.filter((e) => e.accountId === a.id);
    const headsNow = headsAt(mine, today);
    const headsBefore = headsAt(mine, since);
    const ending = running
      .filter((e) => e.accountId === a.id && e.plannedEnd && e.plannedEnd >= today && e.plannedEnd <= plusDaysIso(today, 90))
      .map((e) => {
        const d = decisions.find((x) => x.engagementId === e.id);
        const person = e.freelancerId ? fls.find((f) => f.id === e.freelancerId)?.displayName ?? "?" : e.internalUserId ? un.get(e.internalUserId) ?? "?" : e.title;
        return { engagementId: e.id, person, plannedEnd: e.plannedEnd!, daysToEnd: day(e.plannedEnd!, today), renewal: d ? renewalText[d.status] ?? d.status : "Verlängerung noch nicht angestoßen", decided: d?.status === "BESTAETIGT" || d?.status === "ABGELEHNT" || d?.status === "ERLEDIGT", inProgress: d?.status === "IN_ABSTIMMUNG" || d?.status === "ANGEBOTEN" };
      })
      .sort((x, y) => x.daysToEnd - y.daysToEnd);
    const reasons: string[] = [];
    let ampel: Ampel = "GRUEN";
    const red = (r: string) => { reasons.push(r); ampel = "ROT"; };
    const yellow = (r: string) => { reasons.push(r); if (ampel === "GRUEN") ampel = "GELB"; };
    if (h?.level === "GEFAEHRDET") red(`Health-Check gefährdet (${h.score ?? "–"})`);
    for (const e of ending) {
      if (e.decided) continue;
      if (e.daysToEnd <= 28 && !e.inProgress) red(`${e.person}: Einsatz endet in ${e.daysToEnd} Tagen, ${e.renewal.toLowerCase()}`);
      else yellow(`${e.person}: endet in ${e.daysToEnd} Tagen – ${e.renewal}`);
    }
    if (h?.level === "WACKELIG") yellow(`Health-Check wackelig (${h.score ?? "–"})`);
    if (h?.level === "UNKLAR") yellow("Health-Check: zu wenig Daten");
    if (headsNow < headsBefore) yellow(`Köpfe gesunken: ${headsBefore} → ${headsNow}`);
    const newChances = opps.filter((o) => o.accountId === a.id && o.createdAt >= sinceDate).map((o) => ({ id: o.id, title: o.title }));
    return {
      group: resp.get(a.id)?.userId ?? null,
      accountId: a.id,
      name: a.name,
      ampel,
      reasons,
      health: h ? { score: h.score, level: h.level, coverage: h.coverage } : null,
      headsNow,
      headsBefore,
      ending: ending.map(({ engagementId, person, plannedEnd, daysToEnd, renewal }) => ({ engagementId, person, plannedEnd, daysToEnd, renewal })),
      interesting: { newChances, openCards: cards.filter((c) => c.accountId === a.id).length, newPersons: persons.filter((p) => p.accountId === a.id).map((p) => p.displayName) },
      prep: prepOf(a.id),
      mayPrepare: mayPrep(a.id),
    };
  });
  const order: Record<Ampel, number> = { ROT: 0, GELB: 1, GRUEN: 2 };
  const groupIds = [...new Set(rows.map((r) => r.group))];
  const groups: RoundGroup[] = groupIds
    .map((g) => {
      const r = g ? [...resp.values()].find((x) => x.userId === g)! : null;
      return {
        userId: g,
        name: r?.name ?? "Ohne Kundenverantwortung",
        level: r?.level ?? null,
        accounts: rows.filter((x) => x.group === g).sort((x, y) => order[x.ampel] - order[y.ampel] || x.name.localeCompare(y.name, "de")),
      };
    })
    .sort((x, y) => (x.userId === null ? 1 : y.userId === null ? -1 : x.name.localeCompare(y.name, "de")));
  const radarLines: RadarLine[] = radar
    .map((a) => ({ accountId: a.id, name: a.name, kind: kinds.get(a.id)!, responsibleName: resp.get(a.id)?.name ?? (a.responsibleBdUserId ? un.get(a.responsibleBdUserId) ?? null : null), openChances: opps.filter((o) => o.accountId === a.id && !["BEENDET", "BEAUFTRAGT", "ZURUECKGESTELLT"].includes(o.status)).length, prep: prepOf(a.id), mayPrepare: mayPrep(a.id) }))
    .sort((x, y) => x.name.localeCompare(y.name, "de"));
  const all = groups.flatMap((g) => g.accounts);
  return {
    isGf,
    since,
    lastRound: lastRound ? { heldOn: lastRound.heldOn, note: lastRound.note } : null,
    groups,
    radar: radarLines,
    stats: { accounts: all.length, red: all.filter((a) => a.ampel === "ROT").length, yellow: all.filter((a) => a.ampel === "GELB").length, prepared: all.filter((a) => a.prep).length },
  };
}

/** Vorbereitung je Kunde: bestätigen, optional mit einem Satz. Ersetzt die eigene offene Vorbereitung. */
export async function prepareRoundNote(actor: Actor, accountId: string, note: string) {
  const account = await db.query.accounts.findFirst({ where: and(eq(schema.accounts.id, accountId), eq(schema.accounts.workspaceId, actor.workspaceId)) });
  if (!account) throw new NotFoundError("Kunde");
  const resp = (await responsibles(actor.workspaceId)).get(account.id);
  if (!hasRole(actor, "CEO") && resp?.userId !== actor.userId) throw new ForbiddenError("Vorbereiten darf die Kundenverantwortung dieses Kunden (oder die Geschäftsführung).");
  const text = note.trim().slice(0, 600) || null;
  await db.transaction(async (tx) => {
    await tx.delete(schema.roundNotes).where(and(eq(schema.roundNotes.accountId, account.id), isNull(schema.roundNotes.roundId), eq(schema.roundNotes.authorUserId, actor.userId)));
    await tx.insert(schema.roundNotes).values({ workspaceId: actor.workspaceId, accountId: account.id, authorUserId: actor.userId, note: text });
  });
  return { name: account.name };
}

/** Runde abschließen (Geschäftsführung): Vorbereitungen werden festgeschrieben, „seit der letzten Runde“ beginnt neu. */
export async function closeRound(actor: Actor, raw: { heldOn?: string; note?: string }) {
  if (!hasRole(actor, "CEO")) throw new ForbiddenError("Die Runde schließt die Geschäftsführung ab.");
  const heldOn = raw.heldOn && /^\d{4}-\d{2}-\d{2}$/.test(raw.heldOn) ? raw.heldOn : todayIso();
  if (heldOn > todayIso()) throw new ValidationError("Eine Runde kann nicht in der Zukunft abgeschlossen werden.");
  return db.transaction(async (tx) => {
    const [r] = await tx.insert(schema.customerRounds).values({ workspaceId: actor.workspaceId, heldOn, note: raw.note?.trim().slice(0, 2000) || null, createdBy: actor.userId }).returning();
    await tx.update(schema.roundNotes).set({ roundId: r!.id }).where(and(eq(schema.roundNotes.workspaceId, actor.workspaceId), isNull(schema.roundNotes.roundId)));
    await recordAudit(tx, actor, "round.closed", "WORKSPACE", actor.workspaceId, { am: heldOn });
    return r!;
  });
}

/** Kundenart pflegen: Nebengeschäft (nicht in der Runde, Köpfe zählen nicht) und „auf dem Radar“ (Prospects, Ex-Kunden). */
export async function setAccountFlags(actor: Actor, accountId: string, raw: { sideBusiness?: boolean; onRadar?: boolean }) {
  const account = await db.query.accounts.findFirst({ where: and(eq(schema.accounts.id, accountId), eq(schema.accounts.workspaceId, actor.workspaceId)) });
  if (!account) throw new NotFoundError("Kunde");
  const resp = (await responsibles(actor.workspaceId)).get(account.id);
  if (!hasRole(actor, "CEO") && resp?.userId !== actor.userId && !hasRoleForAccountWrite(actor, account)) throw new ForbiddenError("Die Kundenart pflegen Kundenverantwortung, BD oder Geschäftsführung.");
  const set: Partial<typeof schema.accounts.$inferInsert> = { updatedAt: new Date() };
  if (raw.sideBusiness !== undefined) set.sideBusiness = raw.sideBusiness;
  if (raw.onRadar !== undefined) set.onRadar = raw.onRadar;
  await db.update(schema.accounts).set(set).where(eq(schema.accounts.id, account.id));
  await recordAudit(db, actor, "account.kind", "ACCOUNT", account.id, { nebengeschaeft: raw.sideBusiness ?? null, radar: raw.onRadar ?? null });
}

/** Für die Startseite: wie viel ist für die nächste Runde noch vorzubereiten? */
export async function roundTeaser(actor: Actor) {
  if (!canSeeRound(actor)) return null;
  const r = await buildRound(actor);
  return { ...r.stats, radar: r.radar.length, since: r.since, lastRound: r.lastRound };
}
