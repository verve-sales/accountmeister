import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { resetConfigCacheForTests } from "@/lib/config";
import { availableViews, buildDashboard, resolveView } from "@/modules/dashboard/service";
import { analyzeSetup } from "@/modules/strategy/analysis";
import { getStrategy, proposeStrategy, saveStrategy, formToStrategyInput } from "@/modules/strategy/service";
import { suggestFormFields } from "@/modules/strategy/formsuggest";
import { requireSetupContext, createSetup } from "@/modules/setups/service";
import { createOpportunity } from "@/modules/opportunities/service";
import { actorFor, ensureSeed } from "./helpers";

describe("Etappe 9A: Dashboard je Rolle mit Sichtwechsler", () => {
  it("Sichten folgen den zugewiesenen Rollen; unbekannte Wünsche fallen auf die erste erlaubte Sicht zurück", async () => {
    await ensureSeed();
    const david = await actorFor("david");
    const nina = await actorFor("nina");
    const clemens = await actorFor("clemens");
    const petra = await actorFor("petra");
    const admin = await actorFor("admin");
    expect(await availableViews(david)).toEqual(["BD"]);
    expect(await availableViews(nina)).toEqual(["ANKER"]);
    expect(await availableViews(petra)).toEqual(["PRINCIPAL"]);
    expect(await availableViews(clemens)).toEqual(["CEO"]);
    expect(await availableViews(admin)).toEqual([]);
    // CEO darf nicht einfach die BD-Sicht wählen
    expect((await resolveView(clemens, "BD")).view).toBe("CEO");
    expect((await resolveView(david, "BD")).view).toBe("BD");
    expect(await buildDashboard(admin, null)).toBeNull();
  });

  it("BD-Sicht: Kundenkarten mit Stufe, Blockern, Lücken und Zügen; Wochenliste; Ideen ohne Rohquellen", async () => {
    process.env.AI_PROVIDER = "test";
    resetConfigCacheForTests();
    const seed = await ensureSeed();
    const david = await actorFor("david");
    const d = (await buildDashboard(david, "BD"))!;
    expect(d.view).toBe("BD");
    const card = d.accounts.find((c) => c.accountId === seed.accountId);
    expect(card).toBeDefined();
    expect(card!.setups.length).toBeGreaterThan(0);
    expect(card!.nextStep.length).toBeGreaterThan(10);
    expect(Array.isArray(card!.missing)).toBe(true);
    // Lars’ Kunde (Musterwerke) taucht bei David nicht auf
    expect(d.accounts.some((c) => c.accountId === seed.otherAccountId)).toBe(false);
    expect(typeof d.note).toBe("string");
    // Anker-Sicht: nur Setups mit Anker-Beitrag
    const nina = await actorFor("nina");
    const n = (await buildDashboard(nina, "ANKER"))!;
    expect(n.view).toBe("ANKER");
    expect(n.accounts.some((c) => c.accountId === seed.accountId)).toBe(true);
    // CEO-Sicht: keine Ideen (Rohquellen), aber Kunden und Ziele
    const clemens = await actorFor("clemens");
    const c = (await buildDashboard(clemens, "CEO"))!;
    expect(c.ideas).toEqual([]);
    expect(c.accounts.length).toBeGreaterThan(0);
  });
});

describe("Etappe 9B: Lageanalyse und Strategiefaden", () => {
  it("Analyse benennt Stufe und Lücken; Strategiefaden wird versioniert gespeichert; nur Bearbeitende dürfen", async () => {
    process.env.AI_PROVIDER = "test";
    resetConfigCacheForTests();
    const seed = await ensureSeed();
    const david = await actorFor("david");
    const ctx = await requireSetupContext(david, seed.setupId);
    const a = await analyzeSetup(david, ctx);
    expect(a.stage).toBeDefined();
    expect(a.nextStep.length).toBeGreaterThan(10);
    expect(a.counts.persons).toBeGreaterThan(0);

    // Neues Setup ohne alles: Lücken sind konkret
    const s = await createSetup(david, { accountId: seed.accountId, name: "Lagetest ohne Kontext", visibility: "MITGLIEDER", creatorContribution: "BD_ZUSTAENDIG" });
    const ctx2 = await requireSetupContext(david, s.id);
    const a2 = await analyzeSetup(david, ctx2);
    expect(a2.stage).toBe("KONTAKT");
    expect(a2.missing.some((m) => /Kontextsatz/.test(m))).toBe(true);
    expect(a2.missing.some((m) => /Kein nächster Schritt/.test(m))).toBe(true);
    await createOpportunity(david, { setupId: s.id, title: "Testkoordination", needDescription: "Der Kunde braucht Unterstützung bei der Testkoordination.", trigger: "Gespräch" });
    const a3 = await analyzeSetup(david, await requireSetupContext(david, s.id));
    expect(a3.stage).toBe("BEDARF_IN_KLAERUNG");
    expect(a3.nextStep).toMatch(/bestätigen/);

    // Vorschlag (Testanbieter) hat Züge mit Textstelle aus der Analyse
    const p = await proposeStrategy(david, s.id);
    expect(p.proposal.nextStep.length).toBeGreaterThan(5);
    expect(p.proposal.moves.length).toBeGreaterThan(0);
    expect(p.rejected).toBe(0);
    expect(p.aiJobId).toBeTruthy();

    // Speichern → Version 1, erneut → Version 2; Anker ohne Bearbeitungsrecht (Nina ist hier kein Mitglied) darf nicht
    const v1 = await saveStrategy(david, { ...p.proposal, setupId: s.id, aiJobId: p.aiJobId, note: "Erste Fassung" });
    expect(v1.versionNo).toBe(1);
    expect(v1.stage).toBe("BEDARF_IN_KLAERUNG");
    const v2 = await saveStrategy(david, formToStrategyInput({ setupId: s.id, summary: "Belegt: Bedarf in Klärung. Vermutlich: Budget noch offen.", nextStep: "Bedarf mit Herrn Berger bestätigen.", "moves.0.title": "Gesprächstermin vereinbaren", "moves.0.why": "Bestätigung fehlt", "moves.0.ownerRole": "BD", "moves.0.evidenceQuote": "", "moves.1.title": "", "risks.0.text": "Stillstand", "risks.0.evidenceQuote": "", "openQuestions.0.text": "Wer entscheidet?", note: "" }));
    expect(v2.versionNo).toBe(2);
    expect((v2.moves as unknown[]).length).toBe(1);
    const g = await getStrategy(david, s.id);
    expect(g.latest?.versionNo).toBe(2);
    expect(g.versions).toHaveLength(2);
    const nina = await actorFor("nina");
    await expect(saveStrategy(nina, { ...p.proposal, setupId: s.id })).rejects.toBeInstanceOf(NotFoundError); // sieht das Setup (nur Mitglieder) gar nicht
    const clemens = await actorFor("clemens");
    expect((await getStrategy(clemens, s.id)).canEdit).toBe(false); // CEO: lesend
    await expect(saveStrategy(clemens, { ...p.proposal, setupId: s.id })).rejects.toBeInstanceOf(ForbiddenError);
    const lars = await actorFor("lars");
    await expect(getStrategy(lars, s.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(saveStrategy(david, { setupId: s.id, summary: "kurz", nextStep: "x" })).rejects.toBeInstanceOf(ValidationError);
    // Prüfprotokoll
    const audit = await db.query.auditEvents.findMany({ where: eq(schema.auditEvents.action, "strategy.version_saved") });
    expect(audit.length).toBeGreaterThanOrEqual(2);
  });
});

describe("Etappe 9C: Formularvorschläge", () => {
  it("belegt Felder aus dem Kontext vor, hält sich an Optionen, nennt Textstelle und Lücken; Rechte gelten", async () => {
    process.env.AI_PROVIDER = "test";
    resetConfigCacheForTests();
    const seed = await ensureSeed();
    const david = await actorFor("david");
    const r = await suggestFormFields(david, { kind: "BEDARF", setupId: seed.setupId, fields: [{ name: "title", label: "Titel" }, { name: "needDescription", label: "Bedarf" }, { name: "trigger", label: "Anlass" }] });
    expect(r.suggestion).not.toBeNull();
    expect(r.suggestion!.fields.title).toBeTruthy();
    expect(r.suggestion!.evidenceQuote.length).toBeGreaterThan(2);
    const v = await suggestFormFields(david, { kind: "VORHABEN", accountId: seed.accountId, fields: [{ name: "title", label: "Vorhaben" }, { name: "kind", label: "Art", options: ["VERLAENGERN", "AUSWEITEN", "VERTIEFEN", "UEBERTRAGEN"] }, { name: "rationale", label: "Begründung" }] });
    expect(v.suggestion).not.toBeNull();
    expect(["VERLAENGERN", "AUSWEITEN", "VERTIEFEN", "UEBERTRAGEN"]).toContain(v.suggestion!.fields.kind);
    const s = await suggestFormFields(david, { kind: "SETUP", accountId: seed.accountId, fields: [{ name: "name", label: "Name" }, { name: "contextNote", label: "Kontext" }, { name: "visibility", label: "Sichtbarkeit", options: ["MITGLIEDER", "ACCOUNT_TEAM", "WORKSPACE"] }] });
    expect(s.suggestion!.fields.name).toBeTruthy();
    // Fremder BD: kein Zugriff auf das Setup; CEO darf keinen Bedarf erfassen
    const lars = await actorFor("lars");
    await expect(suggestFormFields(lars, { kind: "BEDARF", setupId: seed.setupId, fields: [{ name: "title", label: "Titel" }] })).rejects.toBeInstanceOf(NotFoundError);
    const clemens = await actorFor("clemens");
    await expect(suggestFormFields(clemens, { kind: "BEDARF", setupId: seed.setupId, fields: [{ name: "title", label: "Titel" }] })).rejects.toBeInstanceOf(ForbiddenError);
    // Ohne KI: klare Ansage statt Fehler
    process.env.AI_PROVIDER = "disabled";
    resetConfigCacheForTests();
    const off = await suggestFormFields(david, { kind: "BEDARF", setupId: seed.setupId, fields: [{ name: "title", label: "Titel" }] });
    expect(off.suggestion).toBeNull();
    expect(off.note).toMatch(/deaktiviert/);
  });
});
