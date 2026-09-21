import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db/client";
import type { ChanceKind, RoleFamily } from "@/db/schema";
import type { Actor } from "@/modules/identity/actor";
import { canViewSetup, loadSetupContext } from "@/modules/identity/authz";
import { listVisibleAccounts } from "@/modules/accounts/service";
import { listRoles, roleFamilyLabel, roleFamilyValues } from "@/modules/roles/catalog";
import { chanceKindLabel } from "@/modules/ai/schemas";

/**
 * Zielbild (Etappe 10, E-045): Wohin läuft das Portfolio? Zählung der aktiven Chancen je Art, Rollenfamilie und
 * Reifegrad – über alle Kunden, die der Akteur sehen darf. Zählungen dokumentierter Objekte, keine Beträge.
 */

export const MATURITY = ["ANTIZIPIERT", "IN_KLAERUNG", "BESTAETIGT", "IM_ANGEBOT", "BEAUFTRAGT"] as const;
export type Maturity = (typeof MATURITY)[number];
export const maturityLabel: Record<Maturity, string> = { ANTIZIPIERT: "antizipiert", IN_KLAERUNG: "in Klärung", BESTAETIGT: "bestätigt", IM_ANGEBOT: "im Angebot / Auswahl", BEAUFTRAGT: "beauftragt" };

export function maturityOf(status: string): Maturity | null {
  if (status === "ANTIZIPIERT") return "ANTIZIPIERT";
  if (status === "IN_KLAERUNG") return "IN_KLAERUNG";
  if (status === "BESTAETIGT") return "BESTAETIGT";
  if (status === "PROFIL_ANGEBOT_VORGESTELLT" || status === "AUSWAHL_BESTELLUNG") return "IM_ANGEBOT";
  if (status === "BEAUFTRAGT") return "BEAUFTRAGT";
  return null; // zurückgestellt/beendet zählen nicht
}

export type ChanceRow = { id: string; title: string; accountId: string; accountName: string; setupId: string; setupName: string; kind: ChanceKind; kindLabel: string; roleName: string | null; family: RoleFamily | null; familyLabel: string; headcount: number; horizon: string | null; maturity: Maturity; status: string };

export async function buildChanceOverview(actor: Actor) {
  const accounts = (await listVisibleAccounts(actor)).filter((a) => a.status !== "ARCHIVED");
  const accountName = new Map(accounts.map((a) => [a.id, a.name]));
  const opps = accounts.length ? await db.query.opportunities.findMany({ where: and(inArray(schema.opportunities.accountId, accounts.map((a) => a.id)), eq(schema.opportunities.workspaceId, actor.workspaceId)) }) : [];
  const roles = await listRoles(actor.workspaceId, { includeInactive: true });
  const setupCache = new Map<string, { ok: boolean; name: string }>();
  const rows: ChanceRow[] = [];
  for (const o of opps) {
    const m = maturityOf(o.status);
    if (!m) continue;
    let sc = setupCache.get(o.setupId);
    if (!sc) {
      const ctx = await loadSetupContext(actor, o.setupId);
      sc = { ok: !!ctx && canViewSetup(actor, ctx), name: ctx?.setup.name ?? "" };
      setupCache.set(o.setupId, sc);
    }
    if (!sc.ok) continue;
    const role = o.roleId ? roles.find((r) => r.id === o.roleId) ?? null : null;
    const family = (role?.family ?? o.roleFamily ?? null) as RoleFamily | null;
    rows.push({ id: o.id, title: o.title, accountId: o.accountId, accountName: accountName.get(o.accountId) ?? "?", setupId: o.setupId, setupName: sc.name, kind: o.kind, kindLabel: chanceKindLabel[o.kind], roleName: role?.name ?? null, family, familyLabel: family ? roleFamilyLabel[family] : "ohne Rollenfamilie", headcount: o.headcount ?? 1, horizon: o.horizon, maturity: m, status: o.status });
  }
  // Matrix Rollenfamilie × Reifegrad (Anzahl Positionen = Summe headcount)
  const families: (RoleFamily | "OHNE")[] = [...roleFamilyValues, "OHNE"];
  const matrix = families.map((f) => {
    const list = rows.filter((r) => (f === "OHNE" ? !r.family : r.family === f));
    const cells = Object.fromEntries(MATURITY.map((m) => [m, list.filter((r) => r.maturity === m).reduce((n, r) => n + r.headcount, 0)])) as Record<Maturity, number>;
    return { family: f, label: f === "OHNE" ? "Rollenfamilie offen" : roleFamilyLabel[f], cells, total: list.reduce((n, r) => n + r.headcount, 0) };
  }).filter((r) => r.total > 0);
  const byKind = (["VERVE_EXPERTE", "FREELANCER_EXPERTE", "AUSSCHREIBUNG"] as ChanceKind[]).map((k) => ({ kind: k, label: chanceKindLabel[k], positions: rows.filter((r) => r.kind === k).reduce((n, r) => n + r.headcount, 0), chances: rows.filter((r) => r.kind === k).length }));
  return { rows, matrix, byKind, note: "Positionen = Summe der Anzahl je Chance (ohne Angabe: 1). Zurückgestellte und beendete Chancen zählen nicht. Keine Beträge, keine Wahrscheinlichkeiten." };
}

/**
 * Aktuell dokumentierte Positionen eines Kunden, optional auf eine Rollenfamilie eingeschränkt (Etappe 11:
 * Ausgangslage für Accountziele – gezählt aus Chancen, nie geschätzt). Aktive Reifegrade wie im Zielbild.
 */
export async function sumActiveHeadcount(actor: Actor, accountId: string, roleFamily: RoleFamily | null): Promise<number> {
  const opps = await db.query.opportunities.findMany({ where: and(eq(schema.opportunities.accountId, accountId), eq(schema.opportunities.workspaceId, actor.workspaceId)) });
  const roles = await listRoles(actor.workspaceId, { includeInactive: true });
  return opps
    .filter((o) => maturityOf(o.status))
    .filter((o) => {
      if (!roleFamily) return true;
      const role = o.roleId ? roles.find((r) => r.id === o.roleId) ?? null : null;
      const family = (role?.family ?? o.roleFamily ?? null) as RoleFamily | null;
      return family === roleFamily;
    })
    .reduce((n, o) => n + (o.headcount ?? 1), 0);
}
