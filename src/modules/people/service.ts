import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db/client";
import type { RelationshipState } from "@/db/schema";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/identity/actor";
import { canEditSetup, canViewSetup, hasRoleForAccountWrite, loadSetupContext } from "@/modules/identity/authz";
import { getAccount } from "@/modules/accounts/service";

/**
 * Personen (Briefing 8.1): nur berufliche Angaben. Keine Felder für private Lebensumstände,
 * Gesundheit, politische Ansichten, Charakter- oder psychologische Profile – bewusst nicht vorgesehen.
 */
export const createPersonInput = z.object({
  accountId: z.string().min(1),
  displayName: z.string().trim().min(2, "Name fehlt").max(200),
  email: z.string().trim().email("E-Mail ungültig").max(200).optional().or(z.literal("")),
  phone: z.string().trim().max(50).optional().or(z.literal("")),
  functionTitle: z.string().trim().max(200).optional().or(z.literal("")),
  orgUnitId: z.string().optional().or(z.literal("")),
  knownResponsibility: z.string().trim().max(500).optional().or(z.literal("")),
  accessClass: z.enum(schema.accessClassEnum.enumValues).default("ACCOUNT_TEAM"),
  setupId: z.string().optional().or(z.literal("")), // optional: sofort eine Beziehung „Name/Funktion bekannt“ im Setup anlegen
});

export async function createPerson(actor: Actor, raw: unknown) {
  const parsed = createPersonInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  const account = await getAccount(actor, input.accountId);
  if (!hasRoleForAccountWrite(actor, account)) {
    // Setup-Bearbeitende dürfen Personen für „ihren“ Kunden anlegen
    if (!input.setupId) throw new ForbiddenError("Für diesen Kunden dürfen Sie keine Personen anlegen.");
    const ctx = await loadSetupContext(actor, input.setupId);
    if (!ctx || ctx.account.id !== account.id || !canEditSetup(actor, ctx)) throw new ForbiddenError("Für diesen Kunden dürfen Sie keine Personen anlegen.");
  }
  return db.transaction(async (tx) => {
    const [person] = await tx
      .insert(schema.persons)
      .values({
        workspaceId: actor.workspaceId,
        accountId: account.id,
        displayName: input.displayName,
        email: input.email || null,
        phone: input.phone || null,
        accessClass: input.accessClass,
        createdBy: actor.userId,
      })
      .returning();
    if (!person) throw new Error("Person konnte nicht angelegt werden");
    if (input.functionTitle) {
      await tx.insert(schema.personFunctions).values({
        personId: person.id,
        orgUnitId: input.orgUnitId || null,
        functionTitle: input.functionTitle,
        knownResponsibility: input.knownResponsibility || null,
      });
    }
    if (input.setupId) {
      await tx.insert(schema.relationships).values({
        personId: person.id,
        holderUserId: actor.userId,
        setupId: input.setupId,
        state: "NAME_FUNKTION_BEKANNT",
        contextNote: "Angelegt aus dem Setup; noch kein persönlicher Kontakt dokumentiert.",
        createdBy: actor.userId,
      });
    }
    await recordAudit(tx, actor, "person.created", "PERSON", person.id, { accountId: account.id });
    return person;
  });
}

export const setFunctionInput = z.object({
  personId: z.string().min(1),
  functionTitle: z.string().trim().min(2, "Funktion fehlt").max(200),
  orgUnitId: z.string().optional().or(z.literal("")),
  knownResponsibility: z.string().trim().max(500).optional().or(z.literal("")),
  validFrom: z.string().optional().or(z.literal("")),
});

/** Neue Funktion setzen: bisherige offene Funktionen werden mit gültig-bis abgeschlossen (zeitliche Gültigkeit, 5.1). */
export async function setPersonFunction(actor: Actor, raw: unknown) {
  const parsed = setFunctionInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  const person = await requirePerson(actor, input.personId, "write");
  return db.transaction(async (tx) => {
    const today = new Date().toISOString().slice(0, 10);
    await tx
      .update(schema.personFunctions)
      .set({ validTo: today })
      .where(and(eq(schema.personFunctions.personId, person.id), isNull(schema.personFunctions.validTo)));
    await tx.insert(schema.personFunctions).values({
      personId: person.id,
      orgUnitId: input.orgUnitId || null,
      functionTitle: input.functionTitle,
      knownResponsibility: input.knownResponsibility || null,
      validFrom: input.validFrom || today,
    });
    await recordAudit(tx, actor, "person.function_set", "PERSON", person.id);
  });
}

/**
 * Beziehungsstand (Briefing 8.2): jeder Stand braucht Kontext und einen nachvollziehbaren Beleg.
 * Ab „Vorgestellt“ ist ein Beleg (vorhandene Quelle oder Belegnotiz) Pflicht.
 * Eine bekannte Person ist nicht automatisch Sponsor – dafür gibt es hier kein Feld.
 */
export const setRelationshipInput = z.object({
  personId: z.string().min(1),
  setupId: z.string().min(1),
  holderUserId: z.string().min(1, "Beziehungshalter fehlt"),
  state: z.enum(schema.relationshipStateEnum.enumValues),
  contextNote: z.string().trim().min(5, "Bitte den Kontext des Beziehungsstands beschreiben.").max(2000),
  evidenceSourceId: z.string().optional().or(z.literal("")),
  evidenceNote: z.string().trim().max(2000).optional().or(z.literal("")),
  version: z.coerce.number().int().positive().optional(),
});

const statesRequiringEvidence: RelationshipState[] = ["VORGESTELLT", "IM_AUSTAUSCH", "KONKRETE_ZUSAMMENARBEIT"];

export async function setRelationship(actor: Actor, raw: unknown) {
  const parsed = setRelationshipInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  const ctx = await loadSetupContext(actor, input.setupId);
  if (!ctx || !canViewSetup(actor, ctx)) throw new NotFoundError("Setup");
  if (!canEditSetup(actor, ctx)) throw new ForbiddenError("Sie dürfen Beziehungen in diesem Setup nicht pflegen.");
  const person = await requirePerson(actor, input.personId, "read");
  if (person.accountId && person.accountId !== ctx.account.id) throw new ValidationError("Die Person gehört zu einem anderen Kunden.");
  if (statesRequiringEvidence.includes(input.state) && !input.evidenceSourceId && !input.evidenceNote) {
    throw new ValidationError("Für diesen Beziehungsstand ist ein Beleg nötig (vorhandene Quelle wählen oder Belegnotiz erfassen).");
  }
  const holder = await db.query.users.findFirst({ where: and(eq(schema.users.id, input.holderUserId), eq(schema.users.workspaceId, actor.workspaceId)) });
  if (!holder) throw new ValidationError("Beziehungshalter nicht gefunden.");

  return db.transaction(async (tx) => {
    let evidenceSourceId: string | null = input.evidenceSourceId || null;
    if (evidenceSourceId) {
      const src = await tx.query.sources.findFirst({ where: and(eq(schema.sources.id, evidenceSourceId), eq(schema.sources.workspaceId, actor.workspaceId)) });
      if (!src) throw new ValidationError("Belegquelle nicht gefunden.");
    } else if (input.evidenceNote) {
      const [src] = await tx
        .insert(schema.sources)
        .values({
          workspaceId: actor.workspaceId,
          setupId: input.setupId,
          type: "NOTIZ",
          title: `Beleg Beziehungsstand ${person.displayName}`,
          body: input.evidenceNote,
          origin: "manuell",
          sourceTime: new Date(),
          ownerUserId: actor.userId,
          accessClass: "SETUP",
        })
        .returning();
      evidenceSourceId = src?.id ?? null;
    }
    const existing = await tx.query.relationships.findFirst({
      where: and(eq(schema.relationships.personId, person.id), eq(schema.relationships.holderUserId, input.holderUserId), eq(schema.relationships.setupId, input.setupId)),
    });
    let row;
    if (existing) {
      const expected = input.version ?? existing.version;
      const [updated] = await tx
        .update(schema.relationships)
        .set({ state: input.state, contextNote: input.contextNote, evidenceSourceId: evidenceSourceId ?? existing.evidenceSourceId, version: expected + 1, updatedAt: new Date() })
        .where(and(eq(schema.relationships.id, existing.id), eq(schema.relationships.version, expected)))
        .returning();
      if (!updated) throw new ConflictError();
      row = updated;
      await recordAudit(tx, actor, "relationship.state_changed", "RELATIONSHIP", existing.id, { von: existing.state, nach: input.state });
    } else {
      const [created] = await tx
        .insert(schema.relationships)
        .values({ personId: person.id, holderUserId: input.holderUserId, setupId: input.setupId, state: input.state, contextNote: input.contextNote, evidenceSourceId, createdBy: actor.userId })
        .returning();
      row = created;
      if (created) await recordAudit(tx, actor, "relationship.created", "RELATIONSHIP", created.id, { state: input.state });
    }
    return row;
  });
}

export async function requirePerson(actor: Actor, personId: string, mode: "read" | "write") {
  const person = await db.query.persons.findFirst({ where: and(eq(schema.persons.id, personId), eq(schema.persons.workspaceId, actor.workspaceId)) });
  if (!person || !person.accountId) throw new NotFoundError("Person");
  let account;
  try {
    account = await getAccount(actor, person.accountId);
  } catch {
    throw new NotFoundError("Person");
  }
  if (mode === "write" && !hasRoleForAccountWrite(actor, account)) {
    // Bearbeitende eines Setups dieses Kunden dürfen ebenfalls pflegen
    const setups = await db.query.projectSetups.findMany({ where: eq(schema.projectSetups.accountId, account.id) });
    let allowed = false;
    for (const s of setups) {
      const ctx = await loadSetupContext(actor, s.id);
      if (ctx && canEditSetup(actor, ctx)) {
        allowed = true;
        break;
      }
    }
    if (!allowed) throw new ForbiddenError("Sie dürfen diese Person nicht bearbeiten.");
  }
  return person;
}

/** Personen & Zugang für einen Kunden: Personen, aktuelle Funktion, Beziehungen (mit Halter, Stand, Beleg). */
export async function listPeopleForAccount(actor: Actor, accountId: string, setupId?: string) {
  await getAccount(actor, accountId);
  const people = await db.query.persons.findMany({ where: eq(schema.persons.accountId, accountId), orderBy: (p, { asc }) => [asc(p.displayName)] });
  const ids = people.map((p) => p.id);
  if (ids.length === 0) return [];
  const [functions, rels, units] = await Promise.all([
    db.query.personFunctions.findMany({ where: inArray(schema.personFunctions.personId, ids), orderBy: desc(schema.personFunctions.createdAt) }),
    db.query.relationships.findMany({ where: inArray(schema.relationships.personId, ids), orderBy: desc(schema.relationships.updatedAt) }),
    db.query.orgUnits.findMany({ where: eq(schema.orgUnits.accountId, accountId) }),
  ]);
  const holderIds = [...new Set(rels.map((r) => r.holderUserId))];
  const holders = holderIds.length ? await db.query.users.findMany({ where: inArray(schema.users.id, holderIds) }) : [];
  const holderName = new Map(holders.map((u) => [u.id, u.displayName]));
  const unitName = new Map(units.map((u) => [u.id, u.name]));
  return people.map((p) => {
    const currentFn = functions.find((f) => f.personId === p.id && !f.validTo) ?? functions.find((f) => f.personId === p.id) ?? null;
    const myRels = rels.filter((r) => r.personId === p.id && (!setupId || r.setupId === setupId || r.setupId === null));
    return {
      person: p,
      currentFunction: currentFn ? { ...currentFn, orgUnitName: currentFn.orgUnitId ? unitName.get(currentFn.orgUnitId) ?? null : null } : null,
      relationships: myRels.map((r) => ({ ...r, holderName: holderName.get(r.holderUserId) ?? "?" })),
    };
  });
}

export async function listOrgUnits(accountId: string) {
  return db.query.orgUnits.findMany({ where: eq(schema.orgUnits.accountId, accountId), orderBy: (u, { asc }) => [asc(u.name)] });
}
