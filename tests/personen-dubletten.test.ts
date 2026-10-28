import { describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { DomainError } from "@/lib/errors";
import { createPerson, deletePerson, duplicateGroups, listPeopleForAccount, mergePersons, personKey } from "@/modules/people/service";
import { actorFor, ensureSeed } from "./helpers";

const uniq = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

describe("Etappe 40: doppelte Personen – wiederverwenden, zusammenführen, entfernen", () => {
  it("D01: Anlegen einer bekannten Person ergänzt statt doppelt anzulegen (Name ohne Anrede, oder gleiche E-Mail)", async () => {
    const s = await ensureSeed();
    const david = await actorFor("david");
    const name = `Birgit Schäfer ${uniq()}`;
    expect(personKey(`Frau Dr. ${name}`)).toBe(personKey(name));
    const a = await createPerson(david, { accountId: s.accountId, displayName: name, functionTitle: "Manager Core Banking", setupId: s.setupId });
    const b = await createPerson(david, { accountId: s.accountId, displayName: `Frau ${name}`, functionTitle: "Manager Core Banking", knownResponsibility: "Auftraggeberin und fachliche Einkäuferin", email: `b.${uniq()}@kunde.example` });
    expect(b.id).toBe(a.id);
    expect("reused" in b).toBe(true);
    const row = (await db.query.persons.findFirst({ where: eq(schema.persons.id, a.id) }))!;
    expect(row.email).toMatch(/@kunde\.example$/);
    const fns = await db.query.personFunctions.findMany({ where: eq(schema.personFunctions.personId, a.id) });
    expect(fns).toHaveLength(1);
    expect(fns[0]!.knownResponsibility).toBe("Auftraggeberin und fachliche Einkäuferin");
    // gleiche E-Mail, anderer Name → dieselbe Person
    const c = await createPerson(david, { accountId: s.accountId, displayName: `B. Schäfer ${uniq()}`, email: row.email! });
    expect(c.id).toBe(a.id);
  });

  it("D02: Drei Dubletten (wie vom Assistenten angelegt) werden zu einer Person mit allen Angaben zusammengeführt", async () => {
    const s = await ensureSeed();
    const david = await actorFor("david");
    const name = `Doppel Dora ${uniq()}`;
    const ins = async (resp: string, email: string | null) => {
      const [p] = await db.insert(schema.persons).values({ workspaceId: s.workspaceId, accountId: s.accountId, displayName: name, email, createdBy: david.userId }).returning();
      await db.insert(schema.personFunctions).values({ personId: p!.id, functionTitle: "Leiterin Einkauf", knownResponsibility: resp });
      return p!;
    };
    const p1 = await ins("Einkauf", null);
    const p2 = await ins("Einkauf und Leistungsnachweise", `dora.${uniq()}@kunde.example`);
    const p3 = await ins("Einkauf", null);
    await db.insert(schema.relationships).values({ personId: p2.id, holderUserId: david.userId, setupId: s.setupId, state: "NAME_FUNKTION_BEKANNT", createdBy: david.userId });
    await db.insert(schema.personAssessments).values({ workspaceId: s.workspaceId, personId: p1.id, setupId: s.setupId, createdBy: david.userId });
    await db.insert(schema.personAssessments).values({ workspaceId: s.workspaceId, personId: p3.id, setupId: s.setupId, decisionRole: "EINKAUF_VERTRAGSWEG", createdBy: david.userId });
    const groups = duplicateGroups((await listPeopleForAccount(david, s.accountId)).map((x) => x.person)).filter((g) => g[0]!.displayName === name);
    expect(groups[0]).toHaveLength(3);

    const r = await mergePersons(david, p1.id, [p2.id, p3.id]);
    expect(r.removed).toBe(2);
    expect(await db.query.persons.findMany({ where: inArray(schema.persons.id, [p2.id, p3.id]) })).toHaveLength(0);
    const kept = (await db.query.persons.findFirst({ where: eq(schema.persons.id, p1.id) }))!;
    expect(kept.email).toBe(p2.email);
    const fns = await db.query.personFunctions.findMany({ where: eq(schema.personFunctions.personId, p1.id) });
    expect(fns).toHaveLength(1);
    expect(fns[0]!.knownResponsibility).toBe("Einkauf und Leistungsnachweise");
    expect(await db.query.relationships.findMany({ where: eq(schema.relationships.personId, p1.id) })).toHaveLength(1);
    const as = await db.query.personAssessments.findMany({ where: eq(schema.personAssessments.personId, p1.id) });
    expect(as).toHaveLength(1);
    expect(as[0]!.decisionRole).toBe("EINKAUF_VERTRAGSWEG");
    await expect(mergePersons(david, p1.id, [])).rejects.toBeInstanceOf(DomainError);
  });

  it("D03: Falsch angelegte Person entfernen – nur mit Schreibrecht am Kunden", async () => {
    const s = await ensureSeed();
    const david = await actorFor("david");
    const lars = await actorFor("lars");
    const p = await createPerson(david, { accountId: s.accountId, displayName: `Falsch Fritz ${uniq()}`, functionTitle: "irgendwas", setupId: s.setupId });
    await expect(deletePerson(lars, p.id)).rejects.toBeInstanceOf(DomainError);
    expect((await deletePerson(david, p.id)).name).toBe(p.displayName);
    expect(await db.query.persons.findFirst({ where: eq(schema.persons.id, p.id) })).toBeUndefined();
    expect(await db.query.relationships.findMany({ where: eq(schema.relationships.personId, p.id) })).toHaveLength(0);
  });
});
