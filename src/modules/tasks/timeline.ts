import { and, eq, inArray, isNotNull, notInArray } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { hasRole, type Actor } from "@/modules/identity/actor";
import type { TimelineTask } from "@/components/TaskTimeline";

/**
 * Aufgaben je Rolle (e50): Die Startseite organisiert die Arbeit nach Hut. Persönlich sieht jede Person ihre eigenen
 * Aufgaben; Principal und Geschäftsführung schalten zusätzlich auf „Team“ – offene Aufgaben und Vorgänge aller
 * Personen an ihren Kunden (Principal) bzw. im ganzen Haus (GF), mit Namen.
 */
export type TimelineScope = "mine" | "team";

export function canSeeTeamTimeline(actor: Actor, hat: string | null): boolean {
  return (hat === "CEO" && hasRole(actor, "CEO")) || (hat === "PRINCIPAL" && (actor.roles.has("PRINCIPAL") || [...actor.accountRoles.values()].some((r) => r.has("PRINCIPAL"))));
}

export async function teamTimeline(actor: Actor, hat: string | null): Promise<TimelineTask[]> {
  if (!canSeeTeamTimeline(actor, hat)) return [];
  const ws = actor.workspaceId;
  let accountIds: string[] | null = null;
  if (hat !== "CEO") {
    const { responsibles } = await import("@/modules/rounds/service");
    const resp = await responsibles(ws);
    accountIds = [...resp.entries()].filter(([, r]) => r.userId === actor.userId).map(([id]) => id);
    for (const [acc, set] of actor.accountRoles) if (set.has("PRINCIPAL") && !accountIds.includes(acc)) accountIds.push(acc);
    if (!accountIds.length) return [];
  }
  const setups = await db.query.projectSetups.findMany({ where: accountIds ? inArray(schema.projectSetups.accountId, accountIds) : eq(schema.projectSetups.workspaceId, ws), columns: { id: true, name: true, accountId: true } });
  const setupIds = setups.map((s) => s.id);
  const [acts, works, users, accounts] = await Promise.all([
    setupIds.length ? db.query.actions.findMany({ where: and(inArray(schema.actions.setupId, setupIds), notInArray(schema.actions.status, ["ERLEDIGT", "VERWORFEN", "VORGESCHLAGEN"])) }) : Promise.resolve([]),
    db.query.workItems.findMany({ where: and(eq(schema.workItems.workspaceId, ws), notInArray(schema.workItems.status, ["ERLEDIGT", "ABGELEHNT", "VERWORFEN"]), isNotNull(schema.workItems.assigneeUserId), ...(accountIds ? [inArray(schema.workItems.accountId, accountIds)] : [])) }),
    db.query.users.findMany({ where: eq(schema.users.workspaceId, ws), columns: { id: true, displayName: true } }),
    db.query.accounts.findMany({ where: eq(schema.accounts.workspaceId, ws), columns: { id: true, name: true } }),
  ]);
  const un = new Map(users.map((u) => [u.id, u.displayName.replace(/\s*\(.*?\)\s*/g, " ").trim()]));
  const an = new Map(accounts.map((a) => [a.id, a.name]));
  const sn = new Map(setups.map((s) => [s.id, s]));
  return [
    ...acts.map((a) => {
      const st = a.setupId ? sn.get(a.setupId) : null;
      return { key: `a-${a.id}`, kind: "AUFGABE" as const, title: a.title, context: `${un.get(a.ownerUserId) ?? "?"} · ${st ? an.get(st.accountId) ?? st.name : ""}`, due: a.dueDate, priority: (["HOCH", "NIEDRIG"].includes(a.priority) ? a.priority : "NORMAL") as TimelineTask["priority"], href: a.setupId ? `/setups/${a.setupId}#aktionen` : "/start" };
    }),
    ...works.map((w) => ({ key: `w-${w.id}`, kind: "VORGANG" as const, title: w.title, context: `${un.get(w.assigneeUserId!) ?? "?"}${w.accountId ? ` · ${an.get(w.accountId) ?? ""}` : ""}`, due: w.dueDate, priority: (w.priority === "HOCH" ? "HOCH" : "NORMAL") as TimelineTask["priority"], href: `/vorgaenge/${w.id}` })),
  ];
}
