import { and, eq, inArray, isNull, notInArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db/client";
import { getConfig } from "@/lib/config";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import { hasRole, type Actor } from "@/modules/identity/actor";
import { plusDaysIso, todayIso } from "@/modules/work/calendar";
import { getMocoClient, isFreelancerMocoUser, isIgnoredMocoUser, mocoProjectUrl, type MocoClient, type MocoCompany, type MocoProject, type MocoProjectGroup, type MocoUser } from "./client";

/**
 * Moco-Startimport mit Prüfliste (Etappe 31).
 *
 * Grundsatz: Moco führt Stammdaten (Kunde, Projektgruppe = Setup, Projekt, Contract, Personen/Teams); der
 * Accountmeister führt Vertrieb, Besetzung und Betreuung. Der Import erzeugt nichts stillschweigend – jede Zeile
 * trägt einen Vorschlag (verknüpfen / neu / überspringen), den die prüfende Person bestätigt oder ändert.
 * Sales-Rollen (BD, Principal) kommen nie aus Moco; sie werden je Setup in der Prüfliste gesetzt.
 */

export type ImportAction = "LINK" | "NEW" | "SKIP";
export type ImportItem =
  | { key: string; type: "PERSON"; mocoId: number; name: string; email: string | null; personKind: "NUTZER" | "FREELANCER"; teamlead: boolean; unit: string | null; proposal: ImportAction; targetId: string | null; targetLabel: string | null; candidates: { id: string; label: string }[]; note: string }
  | { key: string; type: "TEAM"; mocoId: number; name: string; memberMocoIds: number[]; leadMocoIds: number[]; proposal: ImportAction; targetId: string | null; targetLabel: string | null; candidates: { id: string; label: string }[]; note: string }
  | { key: string; type: "KUNDE"; mocoId: number; name: string; proposal: ImportAction; targetId: string | null; targetLabel: string | null; candidates: { id: string; label: string }[]; note: string }
  | { key: string; type: "SETUP"; mocoId: number | null; companyMocoId: number; name: string; principalMocoId: number | null; proposal: ImportAction; targetId: string | null; targetLabel: string | null; candidates: { id: string; label: string }[]; note: string }
  | {
      key: string;
      type: "EINSATZ";
      mocoProjectId: number;
      mocoContractId: number;
      projectName: string;
      companyMocoId: number;
      setupKey: string;
      personMocoId: number;
      personName: string;
      personKind: "NUTZER" | "FREELANCER";
      start: string | null;
      end: string | null;
      hourlyRate: number | null;
      proposal: ImportAction;
      targetId: string | null;
      targetLabel: string | null;
      candidates: { id: string; label: string }[];
      note: string;
    };

export type ImportDecision = { action?: ImportAction; targetId?: string; bdUserId?: string; principalUserId?: string; personKind?: "NUTZER" | "FREELANCER" };
export type ImportDecisions = Record<string, ImportDecision>;

export function canRunMocoImport(actor: Actor): boolean {
  return hasRole(actor, "CEO") || actor.roles.has("PRINCIPAL");
}

function requireImporter(actor: Actor) {
  if (!canRunMocoImport(actor)) throw new ForbiddenError("Den Moco-Import führen CEO oder Principal durch.");
}

// ---------------------------------------------------------------------------
// Namensabgleich
// ---------------------------------------------------------------------------

const LEGAL = /\b(gmbh|ag|se|kg|ohg|gbr|ug|e\.?\s?v\.?|inc|ltd|llc|co|&|und|group|holding|fiktiv)\b/g;
export function normName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.,;:()\-–_/]/g, " ")
    .replace(LEGAL, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function tokens(s: string): Set<string> {
  return new Set(normName(s).split(" ").filter((t) => t.length >= 3));
}
/** Ähnlichkeit 0..1 über gemeinsame Namensbestandteile (Jaccard), exakter Normalname = 1. */
export function nameSimilarity(a: string, b: string): number {
  const na = normName(a);
  const nb = normName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.85;
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  return common / (ta.size + tb.size - common);
}
function best<T>(items: T[], score: (t: T) => number, min = 0.6): { item: T; score: number } | null {
  let top: { item: T; score: number } | null = null;
  for (const it of items) {
    const sc = score(it);
    if (sc >= min && (!top || sc > top.score)) top = { item: it, score: sc };
  }
  return top;
}

const fullName = (u: { firstname: string; lastname: string }) => `${u.firstname} ${u.lastname}`.trim();

// ---------------------------------------------------------------------------
// Vorschau: Moco lesen, gegen den Bestand abgleichen, Prüfliste speichern
// ---------------------------------------------------------------------------

export async function buildImportPreview(actor: Actor, client: MocoClient = getMocoClient()) {
  requireImporter(actor);
  const cfg = getConfig();
  const ws = actor.workspaceId;
  const [mUsers, mCompanies, mGroups, mProjects] = await Promise.all([client.users(), client.companies({ type: "customer" }), client.projectGroups(), client.projects({ includeArchived: false })]);
  const [users, freelancers, accounts, setups, teams, engagements] = await Promise.all([
    db.query.users.findMany({ where: eq(schema.users.workspaceId, ws) }),
    db.query.freelancers.findMany({ where: and(eq(schema.freelancers.workspaceId, ws), isNull(schema.freelancers.mergedIntoId)) }),
    db.query.accounts.findMany({ where: eq(schema.accounts.workspaceId, ws) }),
    db.query.projectSetups.findMany({ where: eq(schema.projectSetups.workspaceId, ws) }),
    db.query.teams.findMany({ where: eq(schema.teams.workspaceId, ws) }),
    db.query.engagements.findMany({ where: and(eq(schema.engagements.workspaceId, ws), notInArray(schema.engagements.status, ["ABGESCHLOSSEN", "ABGEBROCHEN"])) }),
  ]);
  const items: ImportItem[] = [];
  const isFreelancerUnit = (u: MocoUser) => isFreelancerMocoUser(u);
  const isTeamlead = (u: MocoUser) => (u.role?.name ?? "").trim().toLowerCase() === cfg.MOCO_TEAMLEAD_ROLE.trim().toLowerCase();

  // Personen
  const personKind = new Map<number, "NUTZER" | "FREELANCER">();
  for (const u of mUsers.filter((x) => x.active && !isIgnoredMocoUser(x))) {
    const kind: "NUTZER" | "FREELANCER" = isFreelancerUnit(u) ? "FREELANCER" : "NUTZER";
    personKind.set(u.id, kind);
    const name = fullName(u);
    if (kind === "FREELANCER") {
      const byId = freelancers.find((f) => f.mocoUserId === u.id);
      const byMail = !byId && u.email ? freelancers.find((f) => (f.email ?? "").toLowerCase() === u.email) : null;
      const byName = !byId && !byMail ? best(freelancers, (f) => nameSimilarity(f.displayName, name), 0.8) : null;
      const hit = byId ?? byMail ?? byName?.item ?? null;
      items.push({ key: `person:${u.id}`, type: "PERSON", mocoId: u.id, name, email: u.email, personKind: kind, teamlead: false, unit: u.unit?.name ?? null, proposal: hit ? "LINK" : "NEW", targetId: hit?.id ?? null, targetLabel: hit?.displayName ?? null, candidates: freelancers.map((f) => ({ id: f.id, label: f.displayName })), note: byId ? "bereits verknüpft" : hit ? (byMail ? "Treffer über E-Mail" : "Namenstreffer – bitte prüfen") : "neu im Freelancer-Pool" });
    } else {
      const byId = users.find((x) => x.mocoUserId === u.id);
      const byMail = !byId && u.email ? users.find((x) => x.email.toLowerCase() === u.email) : null;
      const byName = !byId && !byMail ? best(users, (x) => nameSimilarity(x.displayName, name), 0.8) : null;
      const hit = byId ?? byMail ?? byName?.item ?? null;
      const note = byId ? "bereits verknüpft" : hit ? (byMail ? "Treffer über E-Mail" : "Namenstreffer – bitte prüfen") : u.email ? "neuer Zugang (Rolle Anker)" : "ohne E-Mail – kein Zugang möglich";
      items.push({ key: `person:${u.id}`, type: "PERSON", mocoId: u.id, name, email: u.email, personKind: kind, teamlead: isTeamlead(u), unit: u.unit?.name ?? null, proposal: hit ? "LINK" : u.email ? "NEW" : "SKIP", targetId: hit?.id ?? null, targetLabel: hit?.displayName ?? null, candidates: users.map((x) => ({ id: x.id, label: x.displayName })), note });
    }
  }

  // Teams (Moco-Units außer Freelancer-Team)
  const units = new Map<number, { name: string; members: number[]; leads: number[] }>();
  for (const u of mUsers.filter((x) => x.active && x.unit && !isFreelancerUnit(x) && !isIgnoredMocoUser(x))) {
    const e = units.get(u.unit!.id) ?? { name: u.unit!.name, members: [], leads: [] };
    e.members.push(u.id);
    if (isTeamlead(u)) e.leads.push(u.id);
    units.set(u.unit!.id, e);
  }
  for (const [unitId, u] of units) {
    const hit = teams.find((t) => t.mocoUnitId === unitId) ?? best(teams.filter((t) => t.key !== "SALES_OPS"), (t) => nameSimilarity(t.name, u.name), 0.8)?.item ?? null;
    items.push({ key: `team:${unitId}`, type: "TEAM", mocoId: unitId, name: u.name, memberMocoIds: u.members, leadMocoIds: u.leads, proposal: hit ? "LINK" : "NEW", targetId: hit?.id ?? null, targetLabel: hit?.name ?? null, candidates: teams.map((t) => ({ id: t.id, label: t.name })), note: `${u.members.length} Mitglieder${u.leads.length ? `, Leitung: ${u.leads.map((id) => fullName(mUsers.find((x) => x.id === id)!)).join(", ")}` : ", keine Leitung in Moco"}` });
  }

  // Kunden: nur Companies mit aktiven Projekten (plus solche, die schon verknüpft sind)
  const activeProjects = mProjects.filter((p) => p.active && p.customer);
  const companyIds = new Set(activeProjects.map((p) => p.customer!.id));
  const companies: MocoCompany[] = mCompanies.filter((c) => companyIds.has(c.id) || accounts.some((a) => a.mocoCompanyId === c.id));
  for (const c of companies) {
    const byId = accounts.find((a) => a.mocoCompanyId === c.id);
    const byName = !byId ? best(accounts, (a) => nameSimilarity(a.name, c.name), 0.6) : null;
    const hit = byId ?? byName?.item ?? null;
    items.push({ key: `kunde:${c.id}`, type: "KUNDE", mocoId: c.id, name: c.name, proposal: hit ? "LINK" : "NEW", targetId: hit?.id ?? null, targetLabel: hit?.name ?? null, candidates: accounts.map((a) => ({ id: a.id, label: a.name })), note: byId ? "bereits verknüpft" : hit ? `Namensähnlichkeit ${Math.round((byName?.score ?? 0) * 100)} % – Name wird aus Moco übernommen` : "neuer Kunde" });
  }

  // Setups: je Projektgruppe eines Kunden; Projekte ohne Gruppe → „Ohne Bereich“ je Kunde
  const setupKeyOf = (p: MocoProject) => (p.project_group ? `setup:${p.project_group.id}` : `setup:none:${p.customer!.id}`);
  const groupsNeeded = new Map<string, { group: MocoProjectGroup | null; companyId: number; name: string }>();
  for (const p of activeProjects) {
    const k = setupKeyOf(p);
    if (groupsNeeded.has(k)) continue;
    const g = p.project_group ? (mGroups.find((x) => x.id === p.project_group!.id) ?? { id: p.project_group.id, name: p.project_group.name, company: p.customer, user: null }) : null;
    groupsNeeded.set(k, { group: g, companyId: p.customer!.id, name: g ? g.name : "Ohne Bereich" });
  }
  // Heuristik „Person steht schon im Setup“: Engagements je Setup mit Personen
  const engPersons = new Map<string, Set<string>>(); // setupId → person keys (user:<id> | fl:<id>)
  for (const e of engagements) {
    const set = engPersons.get(e.setupId) ?? new Set<string>();
    if (e.internalUserId) set.add(`user:${e.internalUserId}`);
    if (e.freelancerId) set.add(`fl:${e.freelancerId}`);
    engPersons.set(e.setupId, set);
  }
  const personTarget = (mocoUserId: number) => {
    const it = items.find((x) => x.type === "PERSON" && x.mocoId === mocoUserId) as Extract<ImportItem, { type: "PERSON" }> | undefined;
    if (!it?.targetId) return null;
    return it.personKind === "FREELANCER" ? `fl:${it.targetId}` : `user:${it.targetId}`;
  };
  for (const [key, g] of groupsNeeded) {
    const accountItem = items.find((x) => x.type === "KUNDE" && x.mocoId === g.companyId);
    const accountId = accountItem?.targetId ?? null;
    const inAccount = accountId ? setups.filter((s) => s.accountId === accountId) : [];
    const byId = g.group ? inAccount.find((s) => s.mocoProjectGroupId === g.group!.id) : null;
    let hit = byId ?? null;
    let note = byId ? "bereits verknüpft" : "";
    if (!hit && inAccount.length) {
      const byName = best(inAccount, (s) => nameSimilarity(s.name, g.name), 0.6);
      if (byName) {
        hit = byName.item;
        note = `Namensähnlichkeit ${Math.round(byName.score * 100)} %`;
      } else {
        // Personen-Heuristik: ein Setup, in dem eine Person aus diesen Projekten schon im Einsatz ist
        const personsHere = new Set(activeProjects.filter((p) => setupKeyOf(p) === key).flatMap((p) => p.contracts.filter((c) => c.active).map((c) => personTarget(c.user_id))).filter((x): x is string => !!x));
        const cand = inAccount.find((s) => [...(engPersons.get(s.id) ?? [])].some((pk) => personsHere.has(pk)));
        if (cand) {
          hit = cand;
          note = "Vorschlag: hier läuft bereits ein Einsatz derselben Person";
        } else if (inAccount.length === 1 && !g.group) {
          hit = inAccount[0]!;
          note = "einziges Setup des Kunden";
        }
      }
    }
    if (!hit && !note) note = accountId ? "neues Setup im Kunden" : "neues Setup (Kunde wird mit angelegt)";
    items.push({ key, type: "SETUP", mocoId: g.group?.id ?? null, companyMocoId: g.companyId, name: g.name, principalMocoId: g.group?.user?.id ?? null, proposal: hit ? "LINK" : "NEW", targetId: hit?.id ?? null, targetLabel: hit?.name ?? null, candidates: inAccount.map((s) => ({ id: s.id, label: s.name })), note });
  }

  // Einsätze: je aktiver Contract eines aktiven Projekts
  for (const p of activeProjects) {
    for (const c of p.contracts.filter((x) => x.active)) {
      const kind = personKind.get(c.user_id) ?? "NUTZER";
      const pt = personTarget(c.user_id);
      const byContract = engagements.find((e) => e.mocoContractId === c.id);
      const samePerson = !byContract && pt ? engagements.filter((e) => (pt.startsWith("fl:") ? e.freelancerId === pt.slice(3) : e.internalUserId === pt.slice(5))) : [];
      const accountItem = items.find((x) => x.type === "KUNDE" && x.mocoId === p.customer!.id);
      const sameAccount = samePerson.filter((e) => e.accountId === accountItem?.targetId);
      const hit = byContract ?? (sameAccount.length === 1 ? sameAccount[0]! : null);
      const note = byContract ? "bereits verknüpft" : hit ? "Vorschlag: bestehender Einsatz derselben Person beim Kunden → verknüpfen" : !personKind.has(c.user_id) ? "Person in Moco inaktiv – prüfen" : "neuer Einsatz (aktiv)";
      items.push({
        key: `einsatz:${c.id}`,
        type: "EINSATZ",
        mocoProjectId: p.id,
        mocoContractId: c.id,
        projectName: p.name,
        companyMocoId: p.customer!.id,
        setupKey: setupKeyOf(p),
        personMocoId: c.user_id,
        personName: fullName(c),
        personKind: kind,
        start: p.start_date,
        end: p.finish_date,
        hourlyRate: c.hourly_rate ?? p.hourly_rate,
        proposal: hit ? "LINK" : "NEW",
        targetId: hit?.id ?? null,
        targetLabel: hit?.title ?? null,
        candidates: samePerson.map((e) => ({ id: e.id, label: e.title })),
        note,
      });
    }
  }

  const counts = { personen: items.filter((i) => i.type === "PERSON").length, teams: items.filter((i) => i.type === "TEAM").length, kunden: items.filter((i) => i.type === "KUNDE").length, setups: items.filter((i) => i.type === "SETUP").length, einsaetze: items.filter((i) => i.type === "EINSATZ").length };
  const [row] = await db
    .insert(schema.mocoImports)
    .values({ workspaceId: ws, items, createdBy: actor.userId, summary: `Vorschau ${todayIso()}: ${counts.personen} Personen, ${counts.teams} Teams, ${counts.kunden} Kunden, ${counts.setups} Setups, ${counts.einsaetze} Einsätze (Quelle: ${client.kind})` })
    .returning();
  await recordAudit(db, actor, "moco.preview", "MOCO_IMPORT", row!.id, counts);
  return row!;
}

export async function getImport(actor: Actor, id: string) {
  requireImporter(actor);
  const row = await db.query.mocoImports.findFirst({ where: and(eq(schema.mocoImports.id, id), eq(schema.mocoImports.workspaceId, actor.workspaceId)) });
  if (!row) throw new NotFoundError("Moco-Import");
  return { ...row, items: row.items as ImportItem[], decisions: row.decisions as ImportDecisions };
}

export async function listImports(actor: Actor) {
  requireImporter(actor);
  return db.query.mocoImports.findMany({ where: eq(schema.mocoImports.workspaceId, actor.workspaceId), orderBy: (t, { desc }) => [desc(t.createdAt)], limit: 10 });
}

const decisionsInput = z.record(z.string(), z.object({ action: z.enum(["LINK", "NEW", "SKIP"]).optional(), targetId: z.string().optional(), bdUserId: z.string().optional(), principalUserId: z.string().optional(), personKind: z.enum(["NUTZER", "FREELANCER"]).optional() }));

/** Entscheidungen aus dem Formular: Felder `d.<key>.action|targetId|bdUserId|principalUserId`. */
export function decisionsFromForm(raw: Record<string, string | undefined>): ImportDecisions {
  const out: Record<string, ImportDecision> = {};
  for (const [k, v] of Object.entries(raw)) {
    const m = k.match(/^d\.(.+)\.(action|targetId|bdUserId|principalUserId|personKind)$/);
    if (!m || v === undefined) continue;
    const key = m[1]!;
    out[key] = { ...(out[key] ?? {}), [m[2]!]: v };
  }
  const parsed = decisionsInput.safeParse(out);
  if (!parsed.success) throw new ValidationError("Entscheidungen unvollständig oder ungültig.");
  return parsed.data;
}

export async function saveDecisions(actor: Actor, id: string, decisions: ImportDecisions) {
  const imp = await getImport(actor, id);
  if (imp.status !== "ENTWURF") throw new ValidationError("Dieser Import ist bereits abgeschlossen.");
  await db.update(schema.mocoImports).set({ decisions: { ...imp.decisions, ...decisions } }).where(eq(schema.mocoImports.id, id));
}

export async function discardImport(actor: Actor, id: string) {
  const imp = await getImport(actor, id);
  if (imp.status !== "ENTWURF") throw new ValidationError("Dieser Import ist bereits abgeschlossen.");
  await db.update(schema.mocoImports).set({ status: "VERWORFEN" }).where(eq(schema.mocoImports.id, id));
}

// ---------------------------------------------------------------------------
// Übernahme
// ---------------------------------------------------------------------------

export type ApplyResult = { ok: string[]; skipped: string[]; errors: { key: string; message: string }[]; created: { nutzer: number; freelancer: number; teams: number; kunden: number; setups: number; einsaetze: number; verknuepft: number } };

const CATCHUP_DAYS = 42;

export async function applyImport(actor: Actor, id: string, decisionsOverride?: ImportDecisions): Promise<ApplyResult> {
  const imp = await getImport(actor, id);
  if (imp.status !== "ENTWURF") throw new ValidationError("Dieser Import ist bereits abgeschlossen.");
  const decisions: ImportDecisions = { ...imp.decisions, ...(decisionsOverride ?? {}) };
  const ws = actor.workspaceId;
  const res: ApplyResult = { ok: [], skipped: [], errors: [], created: { nutzer: 0, freelancer: 0, teams: 0, kunden: 0, setups: 0, einsaetze: 0, verknuepft: 0 } };
  const d = (key: string) => decisions[key] ?? {};
  const actionOf = (it: ImportItem) => d(it.key).action ?? it.proposal;
  const targetOf = (it: ImportItem) => d(it.key).targetId || it.targetId;
  const items = imp.items;
  // Personenart kann in der Prüfliste überstimmt werden (z. B. Freelancer, der in Moco nicht im Freelancer-Team steht)
  const kindOf = (mocoId: number, fallback: "NUTZER" | "FREELANCER") => d(`person:${mocoId}`).personKind ?? fallback;
  // Auflösung Moco-ID → AM-ID im Laufe der Übernahme
  const userByMoco = new Map<number, string>();
  const freelancerByMoco = new Map<number, string>();
  const accountByMoco = new Map<number, string>();
  const setupByKey = new Map<string, string>();
  const { ensureDefaultTeams } = await import("@/modules/work/teams");
  await ensureDefaultTeams(ws);

  // 1) Personen
  for (const it0 of items.filter((x): x is Extract<ImportItem, { type: "PERSON" }> => x.type === "PERSON")) {
    const it = { ...it0, personKind: kindOf(it0.mocoId, it0.personKind) };
    const action = it.personKind !== it0.personKind && actionOf(it0) === "LINK" ? "NEW" : actionOf(it0); // Art geändert → Verknüpfung passt nicht mehr
    try {
      if (action === "SKIP") {
        res.skipped.push(it.key);
        continue;
      }
      if (it.personKind === "FREELANCER") {
        let fid = action === "LINK" ? targetOf(it) : null;
        if (!fid) {
          const [f] = await db.insert(schema.freelancers).values({ workspaceId: ws, displayName: it.name, email: it.email, mocoUserId: it.mocoId, createdBy: actor.userId, availabilitySource: "Moco" }).returning({ id: schema.freelancers.id });
          fid = f!.id;
          res.created.freelancer++;
          await recordAudit(db, actor, "freelancer.created", "FREELANCER", fid, { name: it.name, quelle: "Moco" });
        } else {
          await db.update(schema.freelancers).set({ mocoUserId: it.mocoId, updatedAt: new Date() }).where(eq(schema.freelancers.id, fid));
          res.created.verknuepft++;
        }
        freelancerByMoco.set(it.mocoId, fid);
      } else {
        let uid = action === "LINK" ? targetOf(it) : null;
        if (!uid) {
          if (!it.email) throw new ValidationError("ohne E-Mail kein Zugang");
          const existing = await db.query.users.findFirst({ where: and(eq(schema.users.workspaceId, ws), eq(schema.users.email, it.email)) });
          if (existing) uid = existing.id;
          else {
            const [u] = await db.insert(schema.users).values({ workspaceId: ws, email: it.email, displayName: it.name, mocoUserId: it.mocoId }).returning({ id: schema.users.id });
            uid = u!.id;
            res.created.nutzer++;
            await recordAudit(db, actor, "user.created", "USER", uid, { name: it.name, quelle: "Moco" });
          }
        } else {
          res.created.verknuepft++;
        }
        await db.update(schema.users).set({ mocoUserId: it.mocoId, updatedAt: new Date() }).where(eq(schema.users.id, uid));
        // Rolle Anker, wenn noch keine fachliche Rolle vorhanden
        const roles = await db.query.roleAssignments.findMany({ where: and(eq(schema.roleAssignments.userId, uid), isNull(schema.roleAssignments.validTo)) });
        if (!roles.some((r) => ["ANKER", "BD", "PRINCIPAL", "CEO", "SALES_OPS"].includes(r.role))) {
          await db.insert(schema.roleAssignments).values({ workspaceId: ws, userId: uid, role: "ANKER", scope: "WORKSPACE" });
          await recordAudit(db, actor, "role.assigned", "USER", uid, { rolle: "ANKER", quelle: "Moco-Import" });
        }
        userByMoco.set(it.mocoId, uid);
      }
      res.ok.push(it.key);
    } catch (e) {
      res.errors.push({ key: it.key, message: (e as Error).message });
    }
  }

  // 2) Teams
  for (const it of items.filter((x): x is Extract<ImportItem, { type: "TEAM" }> => x.type === "TEAM")) {
    const action = actionOf(it);
    try {
      if (action === "SKIP") {
        res.skipped.push(it.key);
        continue;
      }
      let tid = action === "LINK" ? targetOf(it) : null;
      if (!tid) {
        const [t] = await db.insert(schema.teams).values({ workspaceId: ws, key: `moco:${it.mocoId}`, name: it.name, description: "Aus Moco übernommenes Team (Linienorganisation).", mocoUnitId: it.mocoId }).onConflictDoNothing().returning({ id: schema.teams.id });
        tid = t?.id ?? (await db.query.teams.findFirst({ where: and(eq(schema.teams.workspaceId, ws), eq(schema.teams.key, `moco:${it.mocoId}`)) }))!.id;
        res.created.teams++;
      } else {
        await db.update(schema.teams).set({ mocoUnitId: it.mocoId, name: it.name, updatedAt: new Date() }).where(eq(schema.teams.id, tid));
      }
      for (const m of it.memberMocoIds) {
        const uid = userByMoco.get(m);
        if (!uid || kindOf(m, "NUTZER") === "FREELANCER") continue;
        const role = it.leadMocoIds.includes(m) ? "LEITUNG" : "MITGLIED";
        await db.insert(schema.teamMembers).values({ teamId: tid, userId: uid, role }).onConflictDoUpdate({ target: [schema.teamMembers.teamId, schema.teamMembers.userId], set: { role } });
      }
      res.ok.push(it.key);
    } catch (e) {
      res.errors.push({ key: it.key, message: (e as Error).message });
    }
  }

  // 3) Kunden
  for (const it of items.filter((x): x is Extract<ImportItem, { type: "KUNDE" }> => x.type === "KUNDE")) {
    const action = actionOf(it);
    try {
      if (action === "SKIP") {
        res.skipped.push(it.key);
        continue;
      }
      let aid = action === "LINK" ? targetOf(it) : null;
      if (!aid) {
        const [a] = await db.insert(schema.accounts).values({ workspaceId: ws, name: it.name, orgType: "SONSTIGE", mocoCompanyId: it.mocoId, createdBy: actor.userId }).returning({ id: schema.accounts.id });
        aid = a!.id;
        res.created.kunden++;
        await recordAudit(db, actor, "account.created", "ACCOUNT", aid, { name: it.name, quelle: "Moco" });
      } else {
        const a = await db.query.accounts.findFirst({ where: eq(schema.accounts.id, aid) });
        await db.update(schema.accounts).set({ mocoCompanyId: it.mocoId, name: it.name, updatedAt: new Date() }).where(eq(schema.accounts.id, aid));
        if (a && a.name !== it.name) await recordAudit(db, actor, "account.renamed", "ACCOUNT", aid, { von: a.name, nach: it.name, quelle: "Moco" });
        res.created.verknuepft++;
      }
      accountByMoco.set(it.mocoId, aid);
      res.ok.push(it.key);
    } catch (e) {
      res.errors.push({ key: it.key, message: (e as Error).message });
    }
  }

  // 4) Setups
  for (const it of items.filter((x): x is Extract<ImportItem, { type: "SETUP" }> => x.type === "SETUP")) {
    const action = actionOf(it);
    try {
      if (action === "SKIP") {
        res.skipped.push(it.key);
        continue;
      }
      const accountId = accountByMoco.get(it.companyMocoId);
      if (!accountId) throw new ValidationError("Kunde wurde nicht übernommen");
      const bdUserId = d(it.key).bdUserId || null;
      // Principal nur aus Moco übernehmen, wenn die Person im AM Principal/CEO ist – der Gruppenverantwortliche ist sonst kein Sales-Begriff
      let principalUserId = d(it.key).principalUserId || null;
      if (!principalUserId && it.principalMocoId && userByMoco.has(it.principalMocoId)) {
        const cand = userByMoco.get(it.principalMocoId)!;
        const r = await db.query.roleAssignments.findMany({ where: and(eq(schema.roleAssignments.userId, cand), isNull(schema.roleAssignments.validTo)) });
        if (r.some((x) => x.role === "PRINCIPAL" || x.role === "CEO")) principalUserId = cand;
      }
      let sid = action === "LINK" ? targetOf(it) : null;
      if (!sid) {
        const [s] = await db.insert(schema.projectSetups).values({ workspaceId: ws, accountId, name: it.name, bdUserId, mocoProjectGroupId: it.mocoId, createdBy: actor.userId, visibility: "MITGLIEDER" }).returning({ id: schema.projectSetups.id });
        sid = s!.id;
        res.created.setups++;
        await recordAudit(db, actor, "setup.created", "SETUP", sid, { name: it.name, quelle: "Moco" });
      } else {
        const s = await db.query.projectSetups.findFirst({ where: eq(schema.projectSetups.id, sid) });
        if (!s) throw new NotFoundError("Setup");
        await db.update(schema.projectSetups).set({ mocoProjectGroupId: it.mocoId, name: it.mocoId ? it.name : s.name, bdUserId: bdUserId ?? s.bdUserId, updatedAt: new Date() }).where(eq(schema.projectSetups.id, sid));
        if (it.mocoId && s.name !== it.name) await recordAudit(db, actor, "setup.renamed", "SETUP", sid, { von: s.name, nach: it.name, quelle: "Moco" });
        res.created.verknuepft++;
      }
      if (bdUserId) await db.insert(schema.setupMemberships).values({ setupId: sid, userId: bdUserId, contribution: "BD_ZUSTAENDIG", canEdit: true }).onConflictDoUpdate({ target: [schema.setupMemberships.setupId, schema.setupMemberships.userId], set: { contribution: "BD_ZUSTAENDIG", canEdit: true } });
      if (principalUserId) await db.insert(schema.setupMemberships).values({ setupId: sid, userId: principalUserId, contribution: "PRINCIPAL_ZUSTAENDIG", canEdit: true }).onConflictDoUpdate({ target: [schema.setupMemberships.setupId, schema.setupMemberships.userId], set: { contribution: "PRINCIPAL_ZUSTAENDIG", canEdit: true } });
      setupByKey.set(it.key, sid);
      res.ok.push(it.key);
    } catch (e) {
      res.errors.push({ key: it.key, message: (e as Error).message });
    }
  }

  // 5) Einsätze
  const { quickFill } = await import("@/modules/staffing/service");
  let stagger = 0;
  for (const it0 of items.filter((x): x is Extract<ImportItem, { type: "EINSATZ" }> => x.type === "EINSATZ")) {
    const it = { ...it0, personKind: kindOf(it0.personMocoId, it0.personKind) };
    const action = actionOf(it0);
    try {
      if (action === "SKIP") {
        res.skipped.push(it.key);
        continue;
      }
      const personId = it.personKind === "FREELANCER" ? freelancerByMoco.get(it.personMocoId) : userByMoco.get(it.personMocoId);
      if (!personId) throw new ValidationError("Person wurde nicht übernommen");
      const start = it.start && it.start <= todayIso() ? it.start : todayIso();
      const rate = it.hourlyRate != null && it.hourlyRate > 0 ? String(it.hourlyRate) : "";
      let engagementId = action === "LINK" ? targetOf(it) : null;
      if (engagementId) {
        const e = await db.query.engagements.findFirst({ where: eq(schema.engagements.id, engagementId) });
        if (!e) throw new NotFoundError("Einsatz");
        const patch: Partial<typeof schema.engagements.$inferInsert> = { mocoProjectId: it.mocoProjectId, mocoContractId: it.mocoContractId, externalRef: e.externalRef ?? mocoProjectUrl(it.mocoProjectId), updatedAt: new Date() };
        if (["VORBEREITUNG", "GEPLANT"].includes(e.status)) Object.assign(patch, { status: "AKTIV", actualStart: e.actualStart ?? start });
        if (it.end && !e.plannedEnd) patch.plannedEnd = it.end;
        await db.update(schema.engagements).set(patch).where(eq(schema.engagements.id, engagementId));
        await db.update(schema.opportunities).set({ mocoProjectId: it.mocoProjectId }).where(eq(schema.opportunities.id, e.opportunityId));
        await recordAudit(db, actor, "engagement.moco_linked", "ENGAGEMENT", engagementId, { projekt: it.mocoProjectId, contract: it.mocoContractId });
        res.created.verknuepft++;
      } else {
        const setupId = setupByKey.get(it.setupKey);
        if (!setupId) throw new ValidationError("Setup wurde nicht übernommen");
        const setup = (await db.query.projectSetups.findFirst({ where: eq(schema.projectSetups.id, setupId) }))!;
        const account = (await db.query.accounts.findFirst({ where: eq(schema.accounts.id, setup.accountId) }))!;
        const owner = setup.bdUserId ?? account.responsibleBdUserId ?? actor.userId;
        const [opp] = await db
          .insert(schema.opportunities)
          .values({ workspaceId: ws, accountId: account.id, setupId, title: it.projectName.slice(0, 200), needDescription: `Laufendes Moco-Projekt „${it.projectName}“ (Startimport).`, status: "BEAUFTRAGT", kind: it.personKind === "FREELANCER" ? "FREELANCER_EXPERTE" : "VERVE_EXPERTE", headcount: 1, ownerUserId: owner, confirmedAt: new Date(), mocoProjectId: it.mocoProjectId, createdBy: actor.userId })
          .returning();
        const [order] = await db
          .insert(schema.orders)
          .values({ workspaceId: ws, opportunityId: opp!.id, evidenceNote: `Moco-Projekt ${it.mocoProjectId}`, plannedStart: it.start, plannedEnd: it.end, status: "BEAUFTRAGUNG_BESTAETIGT", confirmedAt: new Date(), confirmedBy: actor.userId, engagementStatus: "GESTARTET", startedAt: new Date(start), consultantUserId: it.personKind === "NUTZER" ? personId : null, consultantName: it.personKind === "FREELANCER" ? it.personName : null, contractLink: mocoProjectUrl(it.mocoProjectId), createdBy: actor.userId })
          .returning();
        const r = await quickFill(actor, opp!.id, {
          title: it.projectName.slice(0, 200),
          resourceKind: it.personKind === "FREELANCER" ? "FREELANCER" : "INTERN",
          ...(it.personKind === "FREELANCER" ? { freelancerId: personId, ekRate: "0" } : { internalUserId: personId }),
          desiredStart: it.start ?? "",
          plannedEnd: it.end ?? "",
          endOpen: it.end ? "false" : "on",
          vkRate: rate,
          rateUnit: "STUNDE",
          bdUserId: owner,
          reason: "Startimport aus Moco (laufender Einsatz).",
        });
        engagementId = r.engagement.id;
        // EK „0“ war nur Platzhalter für die Pflichtprüfung – Konditionen pflegt der AM; Plan-Periode korrigieren
        if (it.personKind === "FREELANCER") {
          await db.update(schema.candidacies).set({ ekRate: null, ekAsOf: null }).where(eq(schema.candidacies.id, r.candidacy.id));
          await db.update(schema.engagementPeriods).set({ ek: null, source: "Moco (Stundensatz = VK)" }).where(eq(schema.engagementPeriods.engagementId, engagementId));
        }
        await db
          .update(schema.engagements)
          .set({ status: "AKTIV", actualStart: start, orderId: order!.id, mocoProjectId: it.mocoProjectId, mocoContractId: it.mocoContractId, externalRef: mocoProjectUrl(it.mocoProjectId), updatedAt: new Date() })
          .where(eq(schema.engagements.id, engagementId));
        await recordAudit(db, actor, "engagement.moco_imported", "ENGAGEMENT", engagementId, { projekt: it.mocoProjectId, contract: it.mocoContractId });
        res.created.einsaetze++;
        // Check-ins nur für Freelancer: Kunde + Freelancer alle 6 Wochen, erste Termine gestaffelt
        if (it.personKind === "FREELANCER") {
          const due = plusDaysIso(todayIso(), 7 + (stagger++ % (CATCHUP_DAYS - 7)));
          for (const side of ["KUNDE", "FREELANCER"] as const) {
            await db.insert(schema.checkins).values({ workspaceId: ws, engagementId, side, ownerUserId: owner, dueDate: due, ruleKey: `catchup:${engagementId}:${side}:${due}`, note: "Startimport aus Moco – erster Check-in", createdBy: actor.userId }).onConflictDoNothing();
          }
        }
      }
      res.ok.push(it.key);
    } catch (e) {
      res.errors.push({ key: it.key, message: (e as Error).message });
    }
  }

  await db.update(schema.mocoImports).set({ status: "UEBERNOMMEN", decisions, result: res as unknown as Record<string, unknown>, appliedAt: new Date() }).where(eq(schema.mocoImports.id, id));
  await recordAudit(db, actor, "moco.import_applied", "MOCO_IMPORT", id, { ...res.created, fehler: res.errors.length, uebersprungen: res.skipped.length });
  return res;
}

/** Hilfsfunktion für die Prüfliste: aktive Nutzer mit fachlicher Rolle für BD-/Principal-Auswahl. */
export async function importerChoices(actor: Actor) {
  const users = await db.query.users.findMany({ where: and(eq(schema.users.workspaceId, actor.workspaceId), eq(schema.users.status, "ACTIVE")), orderBy: (u, { asc }) => [asc(u.displayName)] });
  const roles = await db.query.roleAssignments.findMany({ where: and(inArray(schema.roleAssignments.userId, users.map((u) => u.id).concat("-")), isNull(schema.roleAssignments.validTo)) });
  const withRole = (r: string[]) => users.filter((u) => roles.some((x) => x.userId === u.id && r.includes(x.role))).map((u) => ({ id: u.id, name: u.displayName }));
  return { bds: withRole(["BD", "PRINCIPAL", "CEO"]), principals: withRole(["PRINCIPAL", "CEO"]) };
}


// ---------------------------------------------------------------------------
// Korrektur: als interne Zugänge angelegte Freelancer in den Pool überführen
// ---------------------------------------------------------------------------

export type FreelancerRepairCandidate = { userId: string; name: string; email: string; mocoUserId: number | null; unit: string | null; engagements: number };

/** Zugänge, die laut Moco (Team/extern-Kennzeichen) Freelancer sind, aber als Nutzer angelegt wurden. */
export async function findMisclassifiedFreelancers(actor: Actor, client: MocoClient = getMocoClient()): Promise<FreelancerRepairCandidate[]> {
  requireImporter(actor);
  const mUsers = (await client.users({ includeArchived: true })).filter((u) => isFreelancerMocoUser(u) && !isIgnoredMocoUser(u));
  const users = await db.query.users.findMany({ where: eq(schema.users.workspaceId, actor.workspaceId) });
  const out: FreelancerRepairCandidate[] = [];
  for (const u of mUsers) {
    const hit = users.find((x) => x.mocoUserId === u.id) ?? (u.email ? users.find((x) => x.email.toLowerCase() === u.email) : undefined);
    if (!hit || hit.status !== "ACTIVE") continue;
    const n = await db.query.engagements.findMany({ where: eq(schema.engagements.internalUserId, hit.id), columns: { id: true } });
    out.push({ userId: hit.id, name: hit.displayName, email: hit.email, mocoUserId: u.id, unit: u.unit?.name ?? null, engagements: n.length });
  }
  return out;
}

/**
 * Überführt die genannten Zugänge in den Freelancer-Pool: Freelancer anlegen (oder per Moco-ID/E-Mail finden), Einsätze,
 * Kandidaturen, Positionen und Aufträge umhängen (intern → Freelancer, EK leer), Check-ins Kunde + Freelancer anlegen,
 * Rollen beenden, Zugang deaktivieren. Alles mit Protokoll.
 */
export async function repairFreelancers(actor: Actor, userIds: string[], client: MocoClient = getMocoClient()) {
  const candidates = (await findMisclassifiedFreelancers(actor, client)).filter((c) => userIds.includes(c.userId));
  let converted = 0;
  let movedEngagements = 0;
  for (const c of candidates) {
    const u = (await db.query.users.findFirst({ where: eq(schema.users.id, c.userId) }))!;
    const existing = (c.mocoUserId ? await db.query.freelancers.findFirst({ where: and(eq(schema.freelancers.workspaceId, actor.workspaceId), eq(schema.freelancers.mocoUserId, c.mocoUserId)) }) : null) ?? (await db.query.freelancers.findFirst({ where: and(eq(schema.freelancers.workspaceId, actor.workspaceId), eq(schema.freelancers.email, u.email)) })) ?? null;
    let fl: { id: string; displayName: string };
    if (!existing) {
      const [created] = await db.insert(schema.freelancers).values({ workspaceId: actor.workspaceId, displayName: u.displayName, email: u.email, mocoUserId: c.mocoUserId, createdBy: actor.userId, availabilitySource: "Moco (Korrektur)" }).returning();
      fl = created!;
      await recordAudit(db, actor, "freelancer.created", "FREELANCER", fl.id, { name: u.displayName, quelle: "Moco-Korrektur" });
    } else {
      fl = existing;
      if (!existing.mocoUserId && c.mocoUserId) await db.update(schema.freelancers).set({ mocoUserId: c.mocoUserId }).where(eq(schema.freelancers.id, existing.id));
    }
    const engs = await db.query.engagements.findMany({ where: eq(schema.engagements.internalUserId, u.id) });
    let stagger = 0;
    for (const e of engs) {
      await db.update(schema.engagements).set({ freelancerId: fl.id, internalUserId: null, title: e.title.replace(u.displayName, fl.displayName), updatedAt: new Date() }).where(eq(schema.engagements.id, e.id));
      await db.update(schema.candidacies).set({ freelancerId: fl.id, internalUserId: null, updatedAt: new Date() }).where(eq(schema.candidacies.id, e.candidacyId));
      await db.update(schema.staffingPositions).set({ resourceKind: "FREELANCER", updatedAt: new Date() }).where(eq(schema.staffingPositions.id, e.positionId));
      await db.update(schema.opportunities).set({ kind: "FREELANCER_EXPERTE", updatedAt: new Date() }).where(eq(schema.opportunities.id, e.opportunityId));
      if (e.orderId) await db.update(schema.orders).set({ consultantUserId: null, consultantName: fl.displayName, updatedAt: new Date() }).where(eq(schema.orders.id, e.orderId));
      if (e.status === "AKTIV") {
        const due = plusDaysIso(todayIso(), 7 + (stagger++ % (CATCHUP_DAYS - 7)));
        for (const side of ["KUNDE", "FREELANCER"] as const) {
          await db.insert(schema.checkins).values({ workspaceId: actor.workspaceId, engagementId: e.id, side, ownerUserId: e.bdUserId, dueDate: due, ruleKey: `catchup:${e.id}:${side}:${due}`, note: "Korrektur intern → Freelancer – erster Check-in", createdBy: actor.userId }).onConflictDoNothing();
        }
      }
      await recordAudit(db, actor, "engagement.person_corrected", "ENGAGEMENT", e.id, { von: `intern:${u.id}`, nach: `freelancer:${fl.id}` });
      movedEngagements++;
    }
    // Team-Mitgliedschaften und Rollen beenden, Zugang deaktivieren (bleibt für das Protokoll erhalten)
    await db.delete(schema.teamMembers).where(eq(schema.teamMembers.userId, u.id));
    await db.update(schema.roleAssignments).set({ validTo: todayIso() }).where(and(eq(schema.roleAssignments.userId, u.id), isNull(schema.roleAssignments.validTo)));
    await db.update(schema.users).set({ status: "INACTIVE", mocoUserId: null, updatedAt: new Date() }).where(eq(schema.users.id, u.id));
    await recordAudit(db, actor, "user.converted_to_freelancer", "USER", u.id, { freelancer: fl.id, einsaetze: engs.length });
    converted++;
  }
  return { converted, movedEngagements };
}
