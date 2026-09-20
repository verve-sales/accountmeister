import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { resetConfigCacheForTests } from "@/lib/config";
import { addRole, ensureRoleCatalog, groupByFamily, listRoles, matchRole, setRoleActive, VERVE_STANDARD_ROLES } from "@/modules/roles/catalog";
import { changeOpportunityStatus, createOpportunity, getOpportunityDetail, listOpportunitiesForSetup, updateOpportunity } from "@/modules/opportunities/service";
import { createSetup, requireSetupContext } from "@/modules/setups/service";
import { createAction } from "@/modules/actions/service";
import { decideCard, getThreadView, sendMessage } from "@/modules/assistant/service";
import { analyzeSetup } from "@/modules/strategy/analysis";
import { buildChanceOverview } from "@/modules/strategy/chancen";
import { buildDashboard } from "@/modules/dashboard/service";
import { suggestFormFields } from "@/modules/strategy/formsuggest";
import { actorFor, ensureSeed } from "./helpers";

describe("Etappe 10: Chance als Zentrum (E-045)", () => {
  it("Rollenkatalog: Verve-Standard wird einmalig befüllt, nach Familien gruppiert, unscharf auffindbar, nur ADMIN pflegt", async () => {
    const seed = await ensureSeed();
    await ensureRoleCatalog(seed.workspaceId);
    await ensureRoleCatalog(seed.workspaceId); // idempotent
    const roles = await listRoles(seed.workspaceId);
    expect(roles).toHaveLength(VERVE_STANDARD_ROLES.length);
    const groups = groupByFamily(roles);
    expect(groups.map((g) => g.family)).toEqual(["DELIVERY_MANAGEMENT", "AGILE_LEADERSHIP", "BUSINESS_ANALYSE", "SOLUTION_ARCHITEKTUR", "TEST_QS"]);
    expect(matchRole(roles, "test management")?.name).toBe("Test Management");
    expect(matchRole(roles, "Scrum Master")?.family).toBe("AGILE_LEADERSHIP");
    expect(matchRole(roles, "Zauberer")).toBeNull();
    const david = await actorFor("david");
    await expect(addRole(david, { family: "TEST_QS", name: "Testautomatisierung" })).rejects.toBeInstanceOf(ForbiddenError);
    const admin = await actorFor("admin");
    const r = await addRole(admin, { family: "TEST_QS", name: "Testautomatisierung" });
    await expect(addRole(admin, { family: "TEST_QS", name: "Testautomatisierung" })).rejects.toBeInstanceOf(ValidationError);
    await setRoleActive(admin, r.id, false);
    expect((await listRoles(seed.workspaceId)).some((x) => x.id === r.id)).toBe(false);
    expect((await listRoles(seed.workspaceId, { includeInactive: true })).some((x) => x.id === r.id)).toBe(true);
  });

  it("Chance mit Wofür: Art, Standardrolle (per Name), Anzahl, Horizont, antizipiert → in Klärung; Aktionen und Beobachtungen zahlen darauf ein", async () => {
    process.env.AI_PROVIDER = "test";
    resetConfigCacheForTests();
    const seed = await ensureSeed();
    const david = await actorFor("david");
    const s = await createSetup(david, { accountId: seed.accountId, name: "Chancen-Setup", contextNote: "Migration des Lagersystems.", visibility: "MITGLIEDER", creatorContribution: "BD_ZUSTAENDIG" });
    const c = await createOpportunity(david, { setupId: s.id, title: "Testkoordination Migration", needDescription: "Der Kunde braucht jemanden, der die Tests koordiniert.", kind: "VERVE_EXPERTE", roleName: "Test Management", headcount: "2", horizon: "Q1 2027", anticipated: "on" });
    expect(c.status).toBe("ANTIZIPIERT");
    expect(c.kind).toBe("VERVE_EXPERTE");
    expect(c.headcount).toBe(2);
    expect(c.horizon).toBe("Q1 2027");
    expect(c.roleFamily).toBe("TEST_QS");
    expect(c.roleId).toBeTruthy();
    // Ausschreibung ohne Rolle, nur Familie
    const t = await createOpportunity(david, { setupId: s.id, title: "Ausschreibung Plattform 2027", needDescription: "Der Kunde wird die Plattformentwicklung neu vergeben.", kind: "AUSSCHREIBUNG", roleFamily: "SOLUTION_ARCHITEKTUR", anticipated: true });
    expect(t.status).toBe("ANTIZIPIERT");
    expect(t.roleId).toBeNull();
    expect(t.roleFamily).toBe("SOLUTION_ARCHITEKTUR");

    // Analyse: Wofür-Zeile und Zug „nur antizipiert“
    const a = await analyzeSetup(david, await requireSetupContext(david, s.id));
    expect(a.purpose).toMatch(/2× Test Management Q1 2027 – antizipiert/);
    expect(a.purpose).toMatch(/Ausschreibung/);
    expect(a.moves.some((m) => /nur antizipiert/.test(m.text))).toBe(true);
    expect(a.stage).toBe("KONTAKT"); // antizipiert zählt noch nicht als Klärung

    // antizipiert → in Klärung (ohne Begründungspflicht), dann Stufe „in Klärung“
    const u = await changeOpportunityStatus(david, c.id, { version: c.version, status: "IN_KLAERUNG" });
    expect(u.status).toBe("IN_KLAERUNG");
    expect((await analyzeSetup(david, await requireSetupContext(david, s.id))).stage).toBe("BEDARF_IN_KLAERUNG");
    // Bearbeiten ändert Wofür
    const u2 = await updateOpportunity(david, c.id, { version: u.version, title: c.title, needDescription: c.needDescription, kind: "FREELANCER_EXPERTE", roleName: "Test Analyse", headcount: "1", horizon: "" });
    expect(u2.kind).toBe("FREELANCER_EXPERTE");
    expect(u2.horizon).toBeNull();

    // Aktion zahlt auf die Chance ein
    const act = await createAction(david, { setupId: s.id, title: "Gespräch mit dem Testleiter vereinbaren", ownerUserId: david.userId, opportunityId: c.id, agreedInConversation: true });
    expect(act.opportunityId).toBe(c.id);
    const d = await getOpportunityDetail(david, c.id);
    expect(d.linked.actions.map((x) => x.id)).toContain(act.id);
    expect(d.roles.length).toBeGreaterThan(20);

    // Zielbild
    const o = await buildChanceOverview(david);
    const row = o.rows.find((r) => r.id === c.id)!;
    expect(row.kindLabel).toBe("Freelancer-Experte");
    expect(row.family).toBe("TEST_QS");
    expect(o.matrix.some((m) => m.family === "TEST_QS" && m.cells.IN_KLAERUNG >= 1)).toBe(true);
    expect(o.matrix.some((m) => m.family === "SOLUTION_ARCHITEKTUR" && m.cells.ANTIZIPIERT >= 1)).toBe(true);
    // Dashboard-Karte trägt Wofür
    const dash = (await buildDashboard(david, "BD"))!;
    const card = dash.accounts.find((x) => x.accountId === seed.accountId)!;
    expect(card.purpose).toMatch(/Test Analyse|Ausschreibung/);
    expect(card.chanceCount).toBeGreaterThanOrEqual(2);
    expect((await listOpportunitiesForSetup(david, s.id)).length).toBe(2);
  });

  it("Assistent: CHANCE-Karte mit Rolle und Horizont; Beobachtungen/Aktionen tragen Wofür und werden mit der Chance verknüpft", async () => {
    process.env.AI_PROVIDER = "test";
    resetConfigCacheForTests();
    const seed = await ensureSeed();
    const david = await actorFor("david");
    const s = await createSetup(david, { accountId: seed.accountId, name: "Assistent-Wofür", contextNote: "Erstgespräch.", visibility: "MITGLIEDER", creatorContribution: "BD_ZUSTAENDIG" });
    const view = await getThreadView(david, { type: "SETUP", id: s.id });
    const r = await sendMessage(david, { threadId: view.thread.id, text: "Herr Vogel, Leiter Test, sucht Unterstützung bei der Testkoordination ab Q2 2027. Herr Vogel schickt bis 15.10. die Teststrategie." });
    const chance = r.cards.find((c) => c.item.type === "CHANCE");
    expect(chance).toBeDefined();
    const item = chance!.item as Extract<NonNullable<typeof chance>["item"], { type: "CHANCE" }>;
    expect(item.roleName).toBe("Test Management");
    expect(item.horizon).toBe("Q2 2027");
    expect(item.anticipated).toBe(true);
    const aktion = r.cards.find((c) => c.item.type === "AKTION");
    expect(aktion).toBeDefined();
    expect((aktion!.item as { purpose?: string }).purpose).toBe(item.title); // Wofür zeigt auf die vorgeschlagene Chance

    const k = await decideCard(david, { threadId: view.thread.id, messageId: r.message.id, cardId: chance!.id, decision: "UEBERNEHMEN" });
    expect(k.card.resultType).toBe("OPPORTUNITY");
    const opp = (await db.query.opportunities.findFirst({ where: eq(schema.opportunities.id, k.card.resultId!) }))!;
    expect(opp.status).toBe("ANTIZIPIERT");
    expect(opp.roleId).toBeTruthy();
    expect(opp.horizon).toBe("Q2 2027");
    const ak = await decideCard(david, { threadId: view.thread.id, messageId: r.message.id, cardId: aktion!.id, decision: "UEBERNEHMEN" });
    expect(ak.card.note).toMatch(/Wofür/);
    const sugg = await db.query.suggestions.findFirst({ where: eq(schema.suggestions.id, ak.card.resultId!) });
    expect(sugg?.opportunityId).toBe(opp.id);
    expect(sugg?.purpose).toBe(item.title);
    // Kontexttext kennt die Chance – nächste Karten hängen daran
    const v2 = await getThreadView(david, { type: "SETUP", id: s.id });
    expect(v2.missing.some((m) => /Chance|Wofür|hinaus/i.test(m))).toBe(false);
    // Formularvorschlag für Chance liefert Art und Rolle
    const f = await suggestFormFields(david, { kind: "CHANCE", setupId: s.id, fields: [{ name: "title", label: "Titel" }, { name: "kind", label: "Art", options: ["VERVE_EXPERTE", "FREELANCER_EXPERTE", "AUSSCHREIBUNG"] }, { name: "roleName", label: "Rolle" }] });
    expect(f.suggestion?.fields.kind).toBe("VERVE_EXPERTE");
  });
});
