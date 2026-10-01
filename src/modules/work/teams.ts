import { and, asc, eq, gte, lte } from "drizzle-orm";
import { z } from "zod";
import { db, schema, type Db, type Tx } from "@/db/client";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import { hasRole, type Actor } from "@/modules/identity/actor";
import type { Role } from "@/db/schema";
import { todayIso } from "./calendar";

/**
 * Teams, Leistungskatalog und Vertretung (Etappe 27).
 * Ein Team hat eine Warteschlange; Inhaber der Arbeitsraumrolle `implicitRole` (z. B. SALES_OPS) sind automatisch
 * Mitglieder, weitere Personen werden ausdrücklich aufgenommen. Leitung verteilt Vorgänge.
 */

export type TeamRow = typeof schema.teams.$inferSelect;
export type ServiceTypeRow = typeof schema.serviceTypes.$inferSelect;
export type ServiceField = { key: string; label: string; required: boolean };

export const DEFAULT_TEAMS: {
  key: string;
  name: string;
  description: string;
  implicitRole: Role;
  services: { key: string; name: string; description: string; defaultWorkdays: number; fields: ServiceField[]; checklist: string[]; reviewRequired: boolean }[];
}[] = [
  {
    key: "SALES_OPS",
    name: "Sales Operations",
    description: "Bereitet vor, pflegt und hält nach: Ausschreibungen, Profile, Unterlagen, Angebote.",
    implicitRole: "SALES_OPS",
    services: [
      {
        key: "AUSSCHREIBUNG",
        name: "Ausschreibung aufbereiten",
        description: "Unterlagen sichten, Anforderungen und Fristen herausziehen, Antwortstruktur vorbereiten.",
        defaultWorkdays: 5,
        fields: [
          { key: "link", label: "Link oder Fundort der Ausschreibung", required: true },
          { key: "abgabe", label: "Abgabefrist", required: true },
          { key: "hinweise", label: "Besonderheiten / Hinweise", required: false },
        ],
        checklist: ["Unterlagen vollständig gesichtet", "Muss-Kriterien und Fristen aufgelistet", "Antwortgerüst angelegt", "Offene Fragen an BD formuliert"],
        reviewRequired: true,
      },
      {
        key: "PROFIL",
        name: "Profil anpassen",
        description: "Beraterprofil auf eine Anfrage zuschneiden (Schwerpunkte, Referenzen, Format).",
        defaultWorkdays: 3,
        fields: [
          { key: "person", label: "Wessen Profil?", required: true },
          { key: "anforderung", label: "Anforderung / Schwerpunkte", required: true },
          { key: "format", label: "Gewünschtes Format (z. B. Kundenvorlage)", required: false },
        ],
        checklist: ["Schwerpunkte auf Anforderung abgestimmt", "Referenzen geprüft und freigegeben", "Format nach Vorgabe"],
        reviewRequired: true,
      },
      {
        key: "UNTERLAGEN",
        name: "Unterlagen zusammenstellen",
        description: "Nachweise, Zertifikate, Formulare oder Lieferantenunterlagen zusammentragen.",
        defaultWorkdays: 3,
        fields: [
          { key: "was", label: "Welche Unterlagen?", required: true },
          { key: "empfaenger", label: "Für wen / welches Portal?", required: false },
        ],
        checklist: ["Unterlagen vollständig", "Aktualität geprüft"],
        reviewRequired: false,
      },
      {
        key: "ANGEBOT",
        name: "Angebot formatieren",
        description: "Angebotsentwurf in die Verve- oder Kundenvorlage bringen, Konditionen gegenlesen.",
        defaultWorkdays: 2,
        fields: [
          { key: "entwurf", label: "Wo liegt der Entwurf?", required: true },
          { key: "frist", label: "Bis wann an den Kunden?", required: false },
        ],
        checklist: ["Vorlage angewendet", "Konditionen und Laufzeit gegengelesen", "Rechtschreibung geprüft"],
        reviewRequired: true,
      },
    ],
  },
];

/** Legt die Standardteams eines Arbeitsraums an (idempotent; ändert bestehende nicht). */
export async function ensureDefaultTeams(workspaceId: string, tx: Tx | Db = db): Promise<void> {
  for (const t of DEFAULT_TEAMS) {
    let team = await tx.query.teams.findFirst({ where: and(eq(schema.teams.workspaceId, workspaceId), eq(schema.teams.key, t.key)) });
    if (team) continue;
    [team] = await tx.insert(schema.teams).values({ workspaceId, key: t.key, name: t.name, description: t.description, implicitRole: t.implicitRole }).onConflictDoNothing().returning();
    if (!team) continue;
    for (const s of t.services) {
      await tx
        .insert(schema.serviceTypes)
        .values({ workspaceId, teamId: team.id, key: s.key, name: s.name, description: s.description, defaultWorkdays: s.defaultWorkdays, fields: s.fields, checklist: s.checklist, reviewRequired: s.reviewRequired })
        .onConflictDoNothing();
    }
  }
}

export function canManageTeams(actor: Actor): boolean {
  return actor.roles.has("ADMIN") || actor.roles.has("PRINCIPAL") || actor.roles.has("CEO");
}

export async function teamMemberIds(team: TeamRow, tx: Tx | Db = db): Promise<string[]> {
  const explicit = await tx.query.teamMembers.findMany({ where: eq(schema.teamMembers.teamId, team.id) });
  const ids = new Set(explicit.map((m) => m.userId));
  if (team.implicitRole) {
    const rows = await tx
      .select({ userId: schema.roleAssignments.userId })
      .from(schema.roleAssignments)
      .innerJoin(schema.users, eq(schema.users.id, schema.roleAssignments.userId))
      .where(and(eq(schema.users.workspaceId, team.workspaceId), eq(schema.users.status, "ACTIVE"), eq(schema.roleAssignments.scope, "WORKSPACE"), eq(schema.roleAssignments.role, team.implicitRole as Role)));
    for (const r of rows) ids.add(r.userId);
  }
  return [...ids];
}

export async function isTeamMember(actor: Actor, team: TeamRow, tx: Tx | Db = db): Promise<boolean> {
  if (team.workspaceId !== actor.workspaceId) return false;
  if (team.implicitRole && actor.roles.has(team.implicitRole as Role)) return true;
  const m = await tx.query.teamMembers.findFirst({ where: and(eq(schema.teamMembers.teamId, team.id), eq(schema.teamMembers.userId, actor.userId)) });
  return !!m;
}

/** Leitung: ausdrücklich als LEITUNG eingetragen, oder arbeitsraumweite Principals/CEO. */
export async function isTeamLead(actor: Actor, team: TeamRow, tx: Tx | Db = db): Promise<boolean> {
  if (team.workspaceId !== actor.workspaceId) return false;
  if (actor.roles.has("PRINCIPAL") || hasRole(actor, "CEO")) return true;
  const m = await tx.query.teamMembers.findFirst({ where: and(eq(schema.teamMembers.teamId, team.id), eq(schema.teamMembers.userId, actor.userId)) });
  return m?.role === "LEITUNG";
}

export async function listTeams(actor: Actor) {
  await ensureDefaultTeams(actor.workspaceId);
  const teams = await db.query.teams.findMany({ where: eq(schema.teams.workspaceId, actor.workspaceId), orderBy: asc(schema.teams.name) });
  const services = await db.query.serviceTypes.findMany({ where: eq(schema.serviceTypes.workspaceId, actor.workspaceId), orderBy: asc(schema.serviceTypes.name) });
  const out = [];
  for (const t of teams) {
    out.push({ ...t, services: services.filter((s) => s.teamId === t.id), member: await isTeamMember(actor, t), lead: await isTeamLead(actor, t) });
  }
  return out;
}

export async function getTeam(actor: Actor, teamId: string) {
  const team = await db.query.teams.findFirst({ where: and(eq(schema.teams.id, teamId), eq(schema.teams.workspaceId, actor.workspaceId)) });
  if (!team) throw new NotFoundError("Team");
  const memberIds = await teamMemberIds(team);
  const explicit = await db.query.teamMembers.findMany({ where: eq(schema.teamMembers.teamId, team.id) });
  const users = await db.query.users.findMany({ where: eq(schema.users.workspaceId, actor.workspaceId) });
  const services = await db.query.serviceTypes.findMany({ where: eq(schema.serviceTypes.teamId, team.id), orderBy: asc(schema.serviceTypes.name) });
  const un = new Map(users.map((u) => [u.id, u.displayName]));
  return {
    team,
    services,
    members: memberIds.map((id) => ({ userId: id, name: un.get(id) ?? "?", role: explicit.find((e) => e.userId === id)?.role ?? "MITGLIED", implicit: !explicit.some((e) => e.userId === id) })).sort((a, b) => a.name.localeCompare(b.name)),
    member: await isTeamMember(actor, team),
    lead: await isTeamLead(actor, team),
  };
}

const fieldsSchema = z.array(z.object({ key: z.string().trim().min(1).max(40), label: z.string().trim().min(1).max(200), required: z.boolean() })).max(12);

export const createTeamInput = z.object({
  name: z.string().trim().min(2, "Name fehlt").max(100),
  description: z.string().trim().max(500).optional().or(z.literal("")),
});

export async function createTeam(actor: Actor, raw: unknown) {
  if (!canManageTeams(actor)) throw new ForbiddenError("Teams pflegen Betriebsverwaltung, Principals und CEO.");
  const p = createTeamInput.safeParse(raw);
  if (!p.success) throw new ValidationError(p.error.issues.map((i) => i.message).join("; "));
  const key = p.data.name.toUpperCase().replace(/[ÄÖÜ]/g, (c) => ({ Ä: "AE", Ö: "OE", Ü: "UE" })[c]!).replace(/ß/g, "SS").replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "TEAM";
  return db.transaction(async (tx) => {
    const [t] = await tx.insert(schema.teams).values({ workspaceId: actor.workspaceId, key, name: p.data.name, description: p.data.description || null }).onConflictDoNothing().returning();
    if (!t) throw new ValidationError("Ein Team mit diesem Namen gibt es schon.");
    await recordAudit(tx, actor, "team.created", "TEAM", t.id, { name: t.name });
    return t;
  });
}

export const memberInput = z.object({ userId: z.string().min(1), role: z.enum(["LEITUNG", "MITGLIED"]).default("MITGLIED") });

export async function setTeamMember(actor: Actor, teamId: string, raw: unknown) {
  if (!canManageTeams(actor)) throw new ForbiddenError("Teams pflegen Betriebsverwaltung, Principals und CEO.");
  const p = memberInput.safeParse(raw);
  if (!p.success) throw new ValidationError("Bitte eine Person wählen.");
  const team = await db.query.teams.findFirst({ where: and(eq(schema.teams.id, teamId), eq(schema.teams.workspaceId, actor.workspaceId)) });
  if (!team) throw new NotFoundError("Team");
  const u = await db.query.users.findFirst({ where: and(eq(schema.users.id, p.data.userId), eq(schema.users.workspaceId, actor.workspaceId), eq(schema.users.status, "ACTIVE")) });
  if (!u) throw new ValidationError("Person nicht gefunden.");
  await db.transaction(async (tx) => {
    await tx.insert(schema.teamMembers).values({ teamId, userId: u.id, role: p.data.role }).onConflictDoUpdate({ target: [schema.teamMembers.teamId, schema.teamMembers.userId], set: { role: p.data.role } });
    await recordAudit(tx, actor, "team.member_set", "TEAM", teamId, { userId: u.id, role: p.data.role });
  });
}

export async function removeTeamMember(actor: Actor, teamId: string, userId: string) {
  if (!canManageTeams(actor)) throw new ForbiddenError("Teams pflegen Betriebsverwaltung, Principals und CEO.");
  const team = await db.query.teams.findFirst({ where: and(eq(schema.teams.id, teamId), eq(schema.teams.workspaceId, actor.workspaceId)) });
  if (!team) throw new NotFoundError("Team");
  await db.transaction(async (tx) => {
    await tx.delete(schema.teamMembers).where(and(eq(schema.teamMembers.teamId, teamId), eq(schema.teamMembers.userId, userId)));
    await recordAudit(tx, actor, "team.member_removed", "TEAM", teamId, { userId });
  });
}

export const serviceTypeInput = z.object({
  serviceTypeId: z.string().optional().or(z.literal("")),
  name: z.string().trim().min(2, "Name fehlt").max(120),
  description: z.string().trim().max(1000).optional().or(z.literal("")),
  defaultWorkdays: z.coerce.number().int().min(0).max(60),
  /** Zeilen „Bezeichnung“ oder „Bezeichnung*“ (Pflicht) */
  fieldsText: z.string().max(3000).optional().or(z.literal("")),
  checklistText: z.string().max(3000).optional().or(z.literal("")),
  reviewRequired: z.union([z.boolean(), z.enum(["true", "false", "on"])]).optional(),
  isActive: z.union([z.boolean(), z.enum(["true", "false", "on"])]).optional(),
});

const truthy = (v: unknown) => v === true || v === "true" || v === "on";

export function parseFieldsText(text: string): ServiceField[] {
  const out: ServiceField[] = [];
  const used = new Set<string>();
  for (const line of text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const required = line.endsWith("*");
    const label = line.replace(/\*$/, "").trim();
    let key = label.toLowerCase().replace(/[äöüß]/g, (c) => ({ ä: "ae", ö: "oe", ü: "ue", ß: "ss" })[c]!).replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 30) || "feld";
    while (used.has(key)) key += "_";
    used.add(key);
    out.push({ key, label, required });
  }
  return fieldsSchema.parse(out);
}

export async function saveServiceType(actor: Actor, teamId: string, raw: unknown) {
  if (!canManageTeams(actor)) throw new ForbiddenError("Den Leistungskatalog pflegen Betriebsverwaltung, Principals und CEO.");
  const p = serviceTypeInput.safeParse(raw);
  if (!p.success) throw new ValidationError(p.error.issues.map((i) => i.message).join("; "));
  const team = await db.query.teams.findFirst({ where: and(eq(schema.teams.id, teamId), eq(schema.teams.workspaceId, actor.workspaceId)) });
  if (!team) throw new NotFoundError("Team");
  const i = p.data;
  const values = {
    name: i.name,
    description: i.description || null,
    defaultWorkdays: i.defaultWorkdays,
    fields: parseFieldsText(i.fieldsText ?? ""),
    checklist: (i.checklistText ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 20),
    reviewRequired: truthy(i.reviewRequired),
    isActive: i.isActive === undefined ? true : truthy(i.isActive),
    updatedAt: new Date(),
  };
  return db.transaction(async (tx) => {
    if (i.serviceTypeId) {
      const [u] = await tx.update(schema.serviceTypes).set(values).where(and(eq(schema.serviceTypes.id, i.serviceTypeId), eq(schema.serviceTypes.teamId, teamId))).returning();
      if (!u) throw new NotFoundError("Anfrageart");
      await recordAudit(tx, actor, "service_type.updated", "TEAM", teamId, { name: u.name });
      return u;
    }
    const key = values.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").slice(0, 40) + "_" + Date.now().toString(36).toUpperCase();
    const [c] = await tx.insert(schema.serviceTypes).values({ workspaceId: actor.workspaceId, teamId, key, ...values }).returning();
    await recordAudit(tx, actor, "service_type.created", "TEAM", teamId, { name: c!.name });
    return c!;
  });
}

// --- Abwesenheit und Vertretung --------------------------------------------

export const absenceInput = z
  .object({
    fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Von-Datum fehlt"),
    toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Bis-Datum fehlt"),
    deputyUserId: z.string().optional().or(z.literal("")),
    note: z.string().trim().max(300).optional().or(z.literal("")),
  })
  .refine((v) => v.fromDate <= v.toDate, "Das Bis-Datum liegt vor dem Von-Datum.");

export async function addAbsence(actor: Actor, raw: unknown) {
  const p = absenceInput.safeParse(raw);
  if (!p.success) throw new ValidationError(p.error.issues.map((i) => i.message).join("; "));
  const i = p.data;
  if (i.deputyUserId) {
    if (i.deputyUserId === actor.userId) throw new ValidationError("Die Vertretung muss eine andere Person sein.");
    const d = await db.query.users.findFirst({ where: and(eq(schema.users.id, i.deputyUserId), eq(schema.users.workspaceId, actor.workspaceId), eq(schema.users.status, "ACTIVE")) });
    if (!d) throw new ValidationError("Vertretung nicht gefunden.");
  }
  return db.transaction(async (tx) => {
    const [a] = await tx.insert(schema.absences).values({ workspaceId: actor.workspaceId, userId: actor.userId, fromDate: i.fromDate, toDate: i.toDate, deputyUserId: i.deputyUserId || null, note: i.note || null }).returning();
    await recordAudit(tx, actor, "absence.created", "USER", actor.userId, { von: i.fromDate, bis: i.toDate, vertretung: i.deputyUserId || null });
    return a!;
  });
}

export async function removeAbsence(actor: Actor, absenceId: string) {
  await db.transaction(async (tx) => {
    const r = await tx.delete(schema.absences).where(and(eq(schema.absences.id, absenceId), eq(schema.absences.userId, actor.userId))).returning();
    if (!r.length) throw new NotFoundError("Abwesenheit");
    await recordAudit(tx, actor, "absence.removed", "USER", actor.userId, {});
  });
}

export async function listMyAbsences(actor: Actor) {
  return db.query.absences.findMany({ where: and(eq(schema.absences.userId, actor.userId), gte(schema.absences.toDate, todayIso())), orderBy: asc(schema.absences.fromDate) });
}

/** Vertretung, falls die Person am Stichtag abwesend ist (eine Ebene, keine Ketten). */
export async function deputyOf(userId: string, onIso = todayIso(), tx: Tx | Db = db): Promise<string | null> {
  const a = await tx.query.absences.findFirst({ where: and(eq(schema.absences.userId, userId), lte(schema.absences.fromDate, onIso), gte(schema.absences.toDate, onIso)) });
  return a?.deputyUserId ?? null;
}
