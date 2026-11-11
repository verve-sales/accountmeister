import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db/client";
import { ConflictError, ForbiddenError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import { hasRole, type Actor } from "@/modules/identity/actor";
import { requireFreelancer } from "@/modules/staffing/service";

/**
 * Freelancer-Profil (Etappe 51): Stammdaten, Fachliches, Verfügbarkeit, Projekte – und zwei geschützte Blöcke:
 *  - Konditionen (Einkaufssatz, Zahlungsziel): Geschäftsführung, Sales Operations, Backoffice und der BD eines Einsatzes
 *    dieses Freelancers. Jeder Aufruf wird protokolliert.
 *  - Vertragliches (Steuernummer, Rechnungsdaten): Geschäftsführung, Sales Operations, Backoffice.
 * Für interne Mitarbeitende gibt es kein Profil.
 */

export type FreelancerRow = typeof schema.freelancers.$inferSelect;

export const BACKOFFICE_TEAM_KEY = "BACKOFFICE";

/** Team „Backoffice“ anlegen, falls es fehlt (Mitglieder pflegt die Verwaltung unter Team). */
export async function ensureBackofficeTeam(workspaceId: string) {
  const [created] = await db.insert(schema.teams).values({ workspaceId, key: BACKOFFICE_TEAM_KEY, name: "Backoffice", description: "Legt Projekte in Moco an, rechnet ab und quittiert Übergaben aus dem Vertrieb." }).onConflictDoNothing().returning();
  return created ?? (await db.query.teams.findFirst({ where: and(eq(schema.teams.workspaceId, workspaceId), eq(schema.teams.key, BACKOFFICE_TEAM_KEY)) }))!;
}

export async function backofficeUserIds(workspaceId: string): Promise<string[]> {
  const team = await ensureBackofficeTeam(workspaceId);
  return (await db.query.teamMembers.findMany({ where: eq(schema.teamMembers.teamId, team.id), columns: { userId: true } })).map((m) => m.userId);
}

export async function isBackoffice(actor: Actor): Promise<boolean> {
  return (await backofficeUserIds(actor.workspaceId)).includes(actor.userId);
}

/** Darf der Akteur die Konditionen dieses Freelancers sehen? */
export async function canSeeConditions(actor: Actor, freelancerId: string): Promise<boolean> {
  if (hasRole(actor, "CEO") || actor.roles.has("SALES_OPS")) return true;
  if (await isBackoffice(actor)) return true;
  const eng = await db.query.engagements.findFirst({ where: and(eq(schema.engagements.freelancerId, freelancerId), eq(schema.engagements.bdUserId, actor.userId)), columns: { id: true } });
  return !!eng;
}

export async function canSeeContractual(actor: Actor): Promise<boolean> {
  return hasRole(actor, "CEO") || actor.roles.has("SALES_OPS") || (await isBackoffice(actor));
}

const HIDDEN_CONDITIONS = { ekRate: null, paymentTermDays: null } as const;
const HIDDEN_CONTRACTUAL = { taxNumber: null, invoiceNote: null } as const;

/** Zeile ohne geschützte Felder – für alle Stellen, die nur den Pool oder die Stammdaten brauchen. */
export function withoutProtected<T extends FreelancerRow>(f: T): T {
  return { ...f, ...HIDDEN_CONDITIONS, ...HIDDEN_CONTRACTUAL };
}

export type FreelancerProfile = {
  freelancer: FreelancerRow;
  showConditions: boolean;
  showContractual: boolean;
  projects: { engagementId: string; accountName: string; title: string; start: string | null; end: string | null; status: string }[];
  /** Verlauf des Einkaufssatzes je Einsatz – nur mit Konditionen-Recht */
  rateHistory: { engagementId: string; title: string; from: string | null; ek: string | null; unit: string }[];
};

export async function getFreelancerProfile(actor: Actor, freelancerId: string): Promise<FreelancerProfile> {
  const f = await requireFreelancer(actor, freelancerId, { raw: true });
  const [showConditions, showContractual] = await Promise.all([canSeeConditions(actor, f.id), canSeeContractual(actor)]);
  const engs = await db.query.engagements.findMany({ where: and(eq(schema.engagements.freelancerId, f.id), eq(schema.engagements.workspaceId, actor.workspaceId)), orderBy: desc(schema.engagements.plannedStart) });
  const accounts = engs.length ? await db.query.accounts.findMany({ where: inArray(schema.accounts.id, [...new Set(engs.map((e) => e.accountId))]), columns: { id: true, name: true } }) : [];
  const an = new Map(accounts.map((a) => [a.id, a.name]));
  let rateHistory: FreelancerProfile["rateHistory"] = [];
  if (showConditions) {
    const periods = engs.length ? await db.query.engagementPeriods.findMany({ where: inArray(schema.engagementPeriods.engagementId, engs.map((e) => e.id)), orderBy: desc(schema.engagementPeriods.validFrom) }) : [];
    rateHistory = periods.filter((p) => p.ek).map((p) => ({ engagementId: p.engagementId, title: engs.find((e) => e.id === p.engagementId)?.title ?? "?", from: p.validFrom, ek: p.ek, unit: p.rateUnit }));
    await recordAudit(db, actor, "freelancer.conditions_viewed", "FREELANCER", f.id, {});
  }
  let row = f;
  if (!showConditions) row = { ...row, ...HIDDEN_CONDITIONS };
  if (!showContractual) row = { ...row, ...HIDDEN_CONTRACTUAL };
  return {
    freelancer: row,
    showConditions,
    showContractual,
    projects: engs.map((e) => ({ engagementId: e.id, accountName: an.get(e.accountId) ?? "?", title: e.title, start: e.actualStart ?? e.plannedStart, end: e.actualEnd ?? e.plannedEnd, status: e.status })),
    rateHistory,
  };
}

const opt = (max: number) => z.string().trim().max(max).optional().default("");
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).or(z.literal("")).optional().default("");
export const profileInput = z.object({
  version: z.coerce.number().int().positive(),
  legalForm: z.enum(["PERSON", "GESELLSCHAFT"]).default("PERSON"),
  street: opt(200),
  postalCity: opt(200),
  residence: opt(200),
  representativeName: opt(200),
  representativeRole: opt(200),
  roles: opt(1000),
  industries: opt(1000),
  languages: opt(500),
  certificates: opt(1000),
  availableFrom: dateStr,
  capacityNote: opt(300),
  travelNote: opt(300),
  profileLink: opt(500),
  // geschützt – werden nur übernommen, wenn der Akteur den Block sehen darf
  ekRate: z.string().trim().regex(/^(\d+([.,]\d{1,2})?)?$/, "Einkaufssatz bitte als Zahl").optional().default(""),
  ekUnit: z.enum(["STUNDE", "TAG"]).optional().default("STUNDE"),
  paymentTermDays: z.string().trim().regex(/^\d{0,3}$/, "Zahlungsziel in Tagen").optional().default(""),
  taxNumber: opt(50),
  invoiceNote: opt(1000),
});

const nul = (v: string) => (v.trim() ? v.trim() : null);

/** Profil speichern. Geschützte Felder ändert nur, wer sie sehen darf – sonst bleiben sie unberührt. */
export async function saveFreelancerProfile(actor: Actor, freelancerId: string, raw: unknown) {
  const p = profileInput.safeParse(raw);
  if (!p.success) throw new ValidationError(p.error.issues.map((i) => i.message).join("; "));
  const f = await requireFreelancer(actor, freelancerId, { raw: true });
  const i = p.data;
  const [cond, contractual] = await Promise.all([canSeeConditions(actor, f.id), canSeeContractual(actor)]);
  const rawObj = (raw ?? {}) as Record<string, unknown>;
  if (!cond && ["ekRate", "paymentTermDays"].some((k) => typeof rawObj[k] === "string" && (rawObj[k] as string).trim())) throw new ForbiddenError("Konditionen pflegen Geschäftsführung, Sales Operations, Backoffice und der verantwortliche BD.");
  const patch: Partial<typeof schema.freelancers.$inferInsert> = {
    legalForm: i.legalForm,
    street: nul(i.street),
    postalCity: nul(i.postalCity),
    residence: nul(i.residence),
    representativeName: nul(i.representativeName),
    representativeRole: nul(i.representativeRole),
    roles: nul(i.roles),
    industries: nul(i.industries),
    languages: nul(i.languages),
    certificates: nul(i.certificates),
    availableFrom: nul(i.availableFrom),
    capacityNote: nul(i.capacityNote),
    travelNote: nul(i.travelNote),
    profileLink: nul(i.profileLink),
  };
  if (cond) Object.assign(patch, { ekRate: i.ekRate ? i.ekRate.replace(",", ".") : null, ekUnit: i.ekUnit, paymentTermDays: i.paymentTermDays ? Number(i.paymentTermDays) : null });
  if (contractual) Object.assign(patch, { taxNumber: nul(i.taxNumber), invoiceNote: nul(i.invoiceNote) });
  const [u] = await db.update(schema.freelancers).set({ ...patch, version: i.version + 1, updatedAt: new Date() }).where(and(eq(schema.freelancers.id, f.id), eq(schema.freelancers.version, i.version))).returning();
  if (!u) throw new ConflictError();
  await recordAudit(db, actor, "freelancer.profile_saved", "FREELANCER", f.id, { konditionen: cond, vertragliches: contractual });
  return u;
}
