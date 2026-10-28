import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { db, schema, type Db, type Tx } from "@/db/client";
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
/** LinkedIn ist reine Referenz (Etappe 18): keine Anbindung, nur ein von Hand gepflegter Link zum Profil. */
export const linkedinUrlField = z
  .string()
  .trim()
  .max(500)
  .optional()
  .or(z.literal(""))
  .refine((v) => !v || /^https:\/\/([a-z0-9-]+\.)*linkedin\.com\//i.test(v), "Bitte einen linkedin.com-Profillink angeben.");

export const createPersonInput = z.object({
  accountId: z.string().min(1),
  displayName: z.string().trim().min(2, "Name fehlt").max(200),
  email: z.string().trim().email("E-Mail ungültig").max(200).optional().or(z.literal("")),
  phone: z.string().trim().max(50).optional().or(z.literal("")),
  linkedinUrl: linkedinUrlField,
  functionTitle: z.string().trim().max(200).optional().or(z.literal("")),
  orgUnitId: z.string().optional().or(z.literal("")),
  /** Neuer Bereich (Freitext) – wird am Kunden angelegt bzw. bei Namensgleichheit wiederverwendet */
  orgUnitName: z.string().trim().max(200).optional().or(z.literal("")),
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
  // Gibt es die Person beim Kunden schon (gleiche E-Mail oder gleicher Name), wird sie ergänzt statt doppelt angelegt
  const existing = await findExistingPerson(db, account.id, input.displayName, input.email);
  if (existing) return enrichExisting(actor, existing, input);
  return db.transaction(async (tx) => {
    const [person] = await tx
      .insert(schema.persons)
      .values({
        workspaceId: actor.workspaceId,
        accountId: account.id,
        displayName: input.displayName,
        email: input.email || null,
        phone: input.phone || null,
        linkedinUrl: input.linkedinUrl || null,
        accessClass: input.accessClass,
        createdBy: actor.userId,
      })
      .returning();
    if (!person) throw new Error("Person konnte nicht angelegt werden");
    if (input.functionTitle || input.orgUnitId || input.orgUnitName) {
      await tx.insert(schema.personFunctions).values({
        personId: person.id,
        orgUnitId: await resolveOrgUnit(tx, account.id, input.orgUnitId || undefined, input.orgUnitName || undefined),
        functionTitle: input.functionTitle || "Funktion noch unbekannt",
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

/** Bestehende Person ergänzen: fehlende Kontaktdaten, neue Funktion (nur wenn anders), Beziehung im Setup (nur wenn keine). */
async function enrichExisting(actor: Actor, person: typeof schema.persons.$inferSelect, input: z.infer<typeof createPersonInput>) {
  return db.transaction(async (tx) => {
    const fill: Partial<typeof schema.persons.$inferInsert> = {};
    if (!person.email && input.email) fill.email = input.email;
    if (!person.phone && input.phone) fill.phone = input.phone;
    if (!person.linkedinUrl && input.linkedinUrl) fill.linkedinUrl = input.linkedinUrl;
    if (Object.keys(fill).length) await tx.update(schema.persons).set({ ...fill, updatedAt: new Date(), version: person.version + 1 }).where(eq(schema.persons.id, person.id));
    if (input.functionTitle) {
      const fns = await tx.query.personFunctions.findMany({ where: and(eq(schema.personFunctions.personId, person.id), isNull(schema.personFunctions.validTo)) });
      const same = fns.find((f) => f.functionTitle.trim().toLowerCase() === input.functionTitle!.trim().toLowerCase());
      if (!same) {
        await tx.insert(schema.personFunctions).values({ personId: person.id, orgUnitId: await resolveOrgUnit(tx, person.accountId!, input.orgUnitId || undefined, input.orgUnitName || undefined), functionTitle: input.functionTitle, knownResponsibility: input.knownResponsibility || null });
      } else if (input.knownResponsibility && (same.knownResponsibility ?? "").length < input.knownResponsibility.length) {
        await tx.update(schema.personFunctions).set({ knownResponsibility: input.knownResponsibility }).where(eq(schema.personFunctions.id, same.id));
      }
    }
    if (input.setupId) {
      const rel = await tx.query.relationships.findFirst({ where: and(eq(schema.relationships.personId, person.id), eq(schema.relationships.setupId, input.setupId)) });
      if (!rel) await tx.insert(schema.relationships).values({ personId: person.id, holderUserId: actor.userId, setupId: input.setupId, state: "NAME_FUNKTION_BEKANNT", contextNote: "Angelegt aus dem Setup; noch kein persönlicher Kontakt dokumentiert.", createdBy: actor.userId });
    }
    await recordAudit(tx, actor, "person.enriched", "PERSON", person.id, { accountId: person.accountId });
    return { ...person, ...fill, reused: true as const };
  });
}

/** Bereich auflösen: gewählte ID, sonst Freitext (bei Namensgleichheit wiederverwenden, sonst anlegen). */
export async function resolveOrgUnit(tx: Tx | Db, accountId: string, orgUnitId: string | undefined, orgUnitName: string | undefined): Promise<string | null> {
  if (orgUnitId) return orgUnitId;
  const name = (orgUnitName ?? "").trim();
  if (!name) return null;
  const all = await tx.query.orgUnits.findMany({ where: eq(schema.orgUnits.accountId, accountId), columns: { id: true, name: true } });
  const hit = all.find((u) => u.name.trim().toLowerCase() === name.toLowerCase());
  if (hit) return hit.id;
  const [u] = await tx.insert(schema.orgUnits).values({ accountId, name }).returning();
  return u!.id;
}

export const setFunctionInput = z.object({
  personId: z.string().min(1),
  functionTitle: z.string().trim().min(2, "Funktion fehlt").max(200),
  orgUnitId: z.string().optional().or(z.literal("")),
  orgUnitName: z.string().trim().max(200).optional().or(z.literal("")),
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
      orgUnitId: person.accountId ? await resolveOrgUnit(tx, person.accountId, input.orgUnitId || undefined, input.orgUnitName || undefined) : input.orgUnitId || null,
      functionTitle: input.functionTitle,
      knownResponsibility: input.knownResponsibility || null,
      validFrom: input.validFrom || today,
    });
    await recordAudit(tx, actor, "person.function_set", "PERSON", person.id);
  });
}

export const setPersonLinkedInInput = z.object({ personId: z.string().min(1), linkedinUrl: linkedinUrlField });

/** LinkedIn-Profillink hinterlegen oder ändern (Etappe 18) – keine Anbindung, nur Referenz für einen Deep-Link. Leer = entfernen. */
export async function setPersonLinkedIn(actor: Actor, raw: unknown) {
  const parsed = setPersonLinkedInInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const person = await requirePerson(actor, parsed.data.personId, "write");
  await db.update(schema.persons).set({ linkedinUrl: parsed.data.linkedinUrl || null, updatedAt: new Date() }).where(eq(schema.persons.id, person.id));
  await recordAudit(db, actor, "person.linkedin_set", "PERSON", person.id, { set: !!parsed.data.linkedinUrl });
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

// ---------------------------------------------------------------------------
// Doppelte Personen (Etappe 40): erkennen, beim Anlegen wiederverwenden, zusammenführen, entfernen

/** Name vergleichbar machen: Anrede und Titel weg, Kleinschreibung, Leerraum zusammenfassen. */
export function personKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(frau|herr|dr\.?|prof\.?|dipl\.?-?\w*\.?)\s+/g, "")
    .replace(/[.,;:()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Gibt es diese Person beim Kunden schon? Gleiche E-Mail oder gleicher (bereinigter) Name. */
export async function findExistingPerson(tx: Tx | Db, accountId: string, displayName: string, email?: string | null) {
  const people = await tx.query.persons.findMany({ where: eq(schema.persons.accountId, accountId), orderBy: (p, { asc }) => [asc(p.createdAt)] });
  const mail = (email ?? "").trim().toLowerCase();
  if (mail) {
    const byMail = people.find((p) => (p.email ?? "").toLowerCase() === mail);
    if (byMail) return byMail;
  }
  const key = personKey(displayName);
  return people.find((p) => personKey(p.displayName) === key && (!mail || !p.email)) ?? null;
}

/** Gruppen mehrfach angelegter Personen eines Kunden (gleiche E-Mail oder gleicher Name). */
export function duplicateGroups<T extends { id: string; displayName: string; email: string | null; createdAt: Date }>(people: T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const p of people) {
    const k = personKey(p.displayName);
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  return [...groups.values()].filter((g) => g.length > 1).map((g) => g.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()));
}

/**
 * Mehrfach angelegte Personen zusammenführen: Funktionen, Beziehungen, Einschätzungen, Kontaktwege, Teilnahmen und
 * offene KI-Karten zeigen danach auf die behaltene Person; fehlende Kontaktdaten werden übernommen; die Dubletten
 * werden gelöscht. Identische Funktionen und Beziehungen bleiben nur einmal stehen.
 */
export async function mergePersons(actor: Actor, keepId: string, dropIds: string[]) {
  const keep = await requirePerson(actor, keepId, "write");
  const drops: (typeof schema.persons.$inferSelect)[] = [];
  for (const id of [...new Set(dropIds)].filter((x) => x !== keepId)) {
    const p = await requirePerson(actor, id, "write");
    if (p.accountId !== keep.accountId) throw new ValidationError("Zusammenführen geht nur innerhalb desselben Kunden.");
    drops.push(p);
  }
  if (!drops.length) throw new ValidationError("Bitte mindestens eine weitere Person zum Zusammenführen wählen.");
  const ids = drops.map((d) => d.id);
  const { sql } = await import("drizzle-orm");
  await db.transaction(async (tx) => {
    // Kontaktdaten ergänzen
    const fill = {
      email: keep.email ?? drops.find((d) => d.email)?.email ?? null,
      phone: keep.phone ?? drops.find((d) => d.phone)?.phone ?? null,
      linkedinUrl: keep.linkedinUrl ?? drops.find((d) => d.linkedinUrl)?.linkedinUrl ?? null,
    };
    await tx.update(schema.persons).set({ ...fill, updatedAt: new Date(), version: keep.version + 1 }).where(eq(schema.persons.id, keep.id));
    // Funktionen: umhängen, identische (Titel + Bereich) nur einmal – die mit der ausführlichsten Zuständigkeit bleibt
    await tx.update(schema.personFunctions).set({ personId: keep.id }).where(inArray(schema.personFunctions.personId, ids));
    const fns = await tx.query.personFunctions.findMany({ where: eq(schema.personFunctions.personId, keep.id) });
    const seenFn = new Map<string, typeof fns[number]>();
    const dropFn: string[] = [];
    for (const f of fns.sort((a, b) => (b.knownResponsibility ?? "").length - (a.knownResponsibility ?? "").length || b.createdAt.getTime() - a.createdAt.getTime())) {
      const k = `${f.functionTitle.trim().toLowerCase()}|${f.orgUnitId ?? ""}|${f.validTo ?? ""}`;
      if (seenFn.has(k)) dropFn.push(f.id);
      else seenFn.set(k, f);
    }
    if (dropFn.length) await tx.delete(schema.personFunctions).where(inArray(schema.personFunctions.id, dropFn));
    // Beziehungen: umhängen, gleiche (Halter, Setup, Stand) nur einmal; Kontaktweg-Schritte zeigen auf die bleibende
    await tx.update(schema.relationships).set({ personId: keep.id }).where(inArray(schema.relationships.personId, ids));
    const rels = await tx.query.relationships.findMany({ where: eq(schema.relationships.personId, keep.id), orderBy: (r, { asc }) => [asc(r.createdAt)] });
    const seenRel = new Map<string, string>();
    for (const r of rels) {
      const k = `${r.holderUserId}|${r.setupId ?? ""}|${r.state}`;
      const first = seenRel.get(k);
      if (!first) {
        seenRel.set(k, r.id);
        continue;
      }
      await tx.update(schema.accessPlanSteps).set({ relationshipId: first }).where(eq(schema.accessPlanSteps.relationshipId, r.id));
      await tx.delete(schema.relationships).where(eq(schema.relationships.id, r.id));
    }
    // Buyingcenter-Einschätzung: je Setup eine – die bewertete bzw. zuletzt geänderte bleibt
    const assessments = await tx.query.personAssessments.findMany({ where: inArray(schema.personAssessments.personId, [keep.id, ...ids]) });
    const bySetup = new Map<string, typeof assessments>();
    for (const a of assessments) bySetup.set(a.setupId, [...(bySetup.get(a.setupId) ?? []), a]);
    for (const list of bySetup.values()) {
      const score = (a: (typeof assessments)[number]) => (a.decisionRole ? 4 : 0) + (a.stance !== "UNBEKANNT" ? 2 : 0) + (a.influence !== "UNBEKANNT" ? 1 : 0);
      const best = [...list].sort((a, b) => score(b) - score(a) || b.updatedAt.getTime() - a.updatedAt.getTime())[0]!;
      const others = list.filter((a) => a.id !== best.id).map((a) => a.id);
      if (others.length) await tx.delete(schema.personAssessments).where(inArray(schema.personAssessments.id, others));
      if (best.personId !== keep.id) await tx.update(schema.personAssessments).set({ personId: keep.id }).where(eq(schema.personAssessments.id, best.id));
    }
    // übrige Verweise
    await tx.update(schema.accessPlans).set({ targetPersonId: keep.id }).where(inArray(schema.accessPlans.targetPersonId, ids));
    await tx.update(schema.accessPlanSteps).set({ fromPersonId: keep.id }).where(inArray(schema.accessPlanSteps.fromPersonId, ids));
    await tx.update(schema.accessPlanSteps).set({ toPersonId: keep.id }).where(inArray(schema.accessPlanSteps.toPersonId, ids));
    await tx.update(schema.decisionParticipations).set({ personId: keep.id }).where(inArray(schema.decisionParticipations.personId, ids));
    await tx.update(schema.mergeReviewItems).set({ decidedPersonId: keep.id }).where(inArray(schema.mergeReviewItems.decidedPersonId, ids));
    await tx.update(schema.candidacyEvents).set({ recipientPersonId: keep.id }).where(inArray(schema.candidacyEvents.recipientPersonId, ids));
    await tx.update(schema.assertions).set({ subjectId: keep.id }).where(and(eq(schema.assertions.subjectType, "PERSON"), inArray(schema.assertions.subjectId, ids)));
    for (const id of ids) {
      await tx.execute(sql`update merge_review_items set candidate_person_ids = array_replace(candidate_person_ids, ${id}, ${keep.id}) where ${id} = any(candidate_person_ids)`);
      await tx.execute(sql`update suggestions set payload = jsonb_set(payload, '{resolved,personId}', to_jsonb(${keep.id}::text)) where payload->'resolved'->>'personId' = ${id}`);
    }
    await tx.delete(schema.persons).where(inArray(schema.persons.id, ids));
    await recordAudit(tx, actor, "person.merged", "PERSON", keep.id, { zusammengefuehrt: ids.length });
  });
  return { keptId: keep.id, removed: ids.length };
}

/**
 * Person entfernen (falsch angelegt). Hängt sie an einem Kontaktweg oder einer Besetzung, bleibt sie – dann
 * zusammenführen oder den Kontaktweg zuerst ändern. Funktionen, Beziehungen und Einschätzungen gehen mit.
 */
export async function deletePerson(actor: Actor, personId: string) {
  const p = await requirePerson(actor, personId, "write");
  const [plan, step, event] = await Promise.all([
    db.query.accessPlans.findFirst({ where: eq(schema.accessPlans.targetPersonId, p.id), columns: { id: true } }),
    db.query.accessPlanSteps.findFirst({ where: or(eq(schema.accessPlanSteps.fromPersonId, p.id), eq(schema.accessPlanSteps.toPersonId, p.id)), columns: { id: true } }),
    db.query.candidacyEvents.findFirst({ where: eq(schema.candidacyEvents.recipientPersonId, p.id), columns: { id: true } }),
  ]);
  if (plan || step || event) throw new ValidationError(`${p.displayName} hängt an einem Kontaktweg oder einer Besetzung und kann nicht einfach entfernt werden. Ist sie doppelt angelegt: „Zusammenführen“.`);
  const { sql } = await import("drizzle-orm");
  await db.transaction(async (tx) => {
    const rels = await tx.query.relationships.findMany({ where: eq(schema.relationships.personId, p.id), columns: { id: true } });
    if (rels.length) await tx.update(schema.accessPlanSteps).set({ relationshipId: null }).where(inArray(schema.accessPlanSteps.relationshipId, rels.map((r) => r.id)));
    await tx.delete(schema.relationships).where(eq(schema.relationships.personId, p.id));
    await tx.delete(schema.personFunctions).where(eq(schema.personFunctions.personId, p.id));
    await tx.delete(schema.personAssessments).where(eq(schema.personAssessments.personId, p.id));
    await tx.update(schema.decisionParticipations).set({ personId: null }).where(eq(schema.decisionParticipations.personId, p.id));
    await tx.update(schema.mergeReviewItems).set({ decidedPersonId: null }).where(eq(schema.mergeReviewItems.decidedPersonId, p.id));
    await tx.execute(sql`update merge_review_items set candidate_person_ids = array_remove(candidate_person_ids, ${p.id}) where ${p.id} = any(candidate_person_ids)`);
    await tx.execute(sql`update suggestions set payload = payload #- '{resolved,personId}' where payload->'resolved'->>'personId' = ${p.id}`);
    await tx.delete(schema.persons).where(eq(schema.persons.id, p.id));
    await recordAudit(tx, actor, "person.deleted", "PERSON", p.id, { accountId: p.accountId });
  });
  return { name: p.displayName };
}
