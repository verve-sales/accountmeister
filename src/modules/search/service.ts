import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db/client";
import type { Actor } from "@/modules/identity/actor";
import { listVisibleAccounts } from "@/modules/accounts/service";
import { listEngagements } from "@/modules/engagements/service";
import { canBrowseFreelancerPool } from "@/modules/staffing/authz";
import { getConfig } from "@/lib/config";

/**
 * Suche in der Kopfzeile (Etappe 33, Zielbild Bedienung): Kunden, Personen (Freelancer, Zugänge), Einsätze und Chancen –
 * jeweils nur, was die Person ohnehin sehen darf. Einfache Teilstring-Suche, bewusst ohne Index: der Bestand ist klein.
 */

export type SearchHit = { kind: "KUNDE" | "FREELANCER" | "PERSON" | "EINSATZ" | "CHANCE" | "SETUP"; id: string; title: string; subtitle: string; href: string };

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");

export async function searchAll(actor: Actor, q: string, limit = 8): Promise<{ q: string; groups: { kind: SearchHit["kind"]; label: string; hits: SearchHit[] }[] }> {
  const needle = norm(q.trim());
  const groups: { kind: SearchHit["kind"]; label: string; hits: SearchHit[] }[] = [];
  if (needle.length < 2) return { q, groups };
  const has = (s: string | null | undefined) => !!s && norm(s).includes(needle);

  const accounts = await listVisibleAccounts(actor);
  const accIds = new Set(accounts.map((a) => a.id));
  const an = new Map(accounts.map((a) => [a.id, a.name]));

  const kunden = accounts.filter((a) => has(a.name)).slice(0, limit).map<SearchHit>((a) => ({ kind: "KUNDE", id: a.id, title: a.name, subtitle: "Kunde", href: `/kunden/${a.id}` }));
  if (kunden.length) groups.push({ kind: "KUNDE", label: "Kunden", hits: kunden });

  if (getConfig().FEATURE_BESETZUNG === "true") {
    const { items } = await listEngagements(actor, "alle", q);
    const eins = items.slice(0, limit).map<SearchHit>((e) => ({ kind: "EINSATZ", id: e.id, title: `${e.personName} bei ${e.accountName}`, subtitle: `${e.title}${e.plannedEnd ? ` · Ende ${e.plannedEnd}` : ""} · ${e.status}`, href: `/einsaetze/${e.id}` }));
    if (eins.length) groups.push({ kind: "EINSATZ", label: "Einsätze", hits: eins });

    if (canBrowseFreelancerPool(actor)) {
      const fls = await db.query.freelancers.findMany({ where: eq(schema.freelancers.workspaceId, actor.workspaceId), columns: { id: true, displayName: true, email: true } });
      const hits = fls.filter((f) => has(f.displayName) || has(f.email)).slice(0, limit).map<SearchHit>((f) => ({ kind: "FREELANCER", id: f.id, title: f.displayName, subtitle: "Freelancer", href: `/besetzung/freelancer/${f.id}` }));
      if (hits.length) groups.push({ kind: "FREELANCER", label: "Freelancer", hits });
    }
  }

  if (accIds.size) {
    const [opps, setups] = await Promise.all([
      db.query.opportunities.findMany({ where: and(eq(schema.opportunities.workspaceId, actor.workspaceId), inArray(schema.opportunities.accountId, [...accIds])), columns: { id: true, title: true, accountId: true, status: true } }),
      db.query.projectSetups.findMany({ where: and(eq(schema.projectSetups.workspaceId, actor.workspaceId), inArray(schema.projectSetups.accountId, [...accIds])), columns: { id: true, name: true, accountId: true } }),
    ]);
    const ch = opps.filter((o) => has(o.title)).slice(0, limit).map<SearchHit>((o) => ({ kind: "CHANCE", id: o.id, title: o.title, subtitle: `Chance · ${an.get(o.accountId) ?? ""} · ${o.status.toLowerCase().replace(/_/g, " ")}`, href: `/bedarfe/${o.id}` }));
    if (ch.length) groups.push({ kind: "CHANCE", label: "Chancen", hits: ch });
    const st = setups.filter((s) => has(s.name)).slice(0, limit).map<SearchHit>((s) => ({ kind: "SETUP", id: s.id, title: s.name, subtitle: `Setup · ${an.get(s.accountId) ?? ""}`, href: `/setups/${s.id}` }));
    if (st.length) groups.push({ kind: "SETUP", label: "Setups", hits: st });
  }

  const users = await db.query.users.findMany({ where: and(eq(schema.users.workspaceId, actor.workspaceId), eq(schema.users.status, "ACTIVE")), columns: { id: true, displayName: true, email: true } });
  const pers = users.filter((u) => has(u.displayName) || has(u.email)).slice(0, limit).map<SearchHit>((u) => ({ kind: "PERSON", id: u.id, title: u.displayName, subtitle: u.email, href: `/einsaetze?q=${encodeURIComponent(u.displayName)}` }));
  if (pers.length) groups.push({ kind: "PERSON", label: "Kolleginnen und Kollegen", hits: pers });

  return { q, groups };
}
