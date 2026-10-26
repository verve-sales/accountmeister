import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { resetConfigCacheForTests } from "@/lib/config";
import { createAccount } from "@/modules/accounts/service";
import { createSetup } from "@/modules/setups/service";
import { createOpportunity } from "@/modules/opportunities/service";
import { createAction } from "@/modules/actions/service";
import { quickFill } from "@/modules/staffing/service";
import { ensureRenewalDecisions } from "@/modules/engagements/care";
import { eingangFromSource, eingangFromText, listRunningEingang, routeText } from "@/modules/eingang/service";
import { acceptSuggestion, listMySuggestions } from "@/modules/suggestions/service";
import { loadActor } from "@/modules/identity/actor";
import { parseRelativeDue, plusDaysIso, todayIso } from "@/modules/work/calendar";
import type { IntakeItem } from "@/modules/ai/schemas";
import { LangdockProvider } from "@/modules/ai/providers/langdock";
import { actorFor, ensureSeed } from "./helpers";

const MAIL = readFileSync("tests/fixtures/mails/verlaengerung-verlauf.txt", "utf8");
type Card = typeof schema.suggestions.$inferSelect;
const item = (c: Card) => (c.payload as { item: IntakeItem }).item;
const cardsOf = async (sourceId: string) => (await db.query.suggestions.findMany({ where: eq(schema.suggestions.type, "KARTE") })).filter((c) => c.sourceIds.includes(sourceId));

async function setupFlags() {
  process.env.AI_PROVIDER = "test";
  process.env.FEATURE_BESETZUNG = "true";
  resetConfigCacheForTests();
}

describe("Etappe 36: Eingangs-Auswertung – Kunde erkennen, Karten mit Bezug auf den Bestand, ein Klick", () => {
  it("E01: Mailverlauf ohne Setup-Wahl → Kunde über Name/Domäne/Einsatz erkannt; Verlängerung am richtigen Einsatz bestätigt; Personen mit Funktion, Bereich und Buyingcenter-Rolle; keine Verve-Person", async () => {
    await setupFlags();
    const s = await ensureSeed();
    const david = await actorFor("david");
    if (!(await db.query.users.findFirst({ where: eq(schema.users.email, "max.beispiel@verveconsulting.de") }))) await db.insert(schema.users).values({ workspaceId: s.workspaceId, email: "max.beispiel@verveconsulting.de", displayName: "Max Beispiel" });
    const acc = await createAccount(david, { name: `Musterversicherung AG (fiktiv)`, orgType: "KONZERN", responsibleBdUserId: david.userId });
    const d2 = (await loadActor(david.userId))!;
    const setup = await createSetup(d2, { accountId: acc.id, name: "HR Arbeitnehmerüberlassung", bdUserId: david.userId, creatorContribution: "BD_ZUSTAENDIG" });
    const [sophia] = await db.insert(schema.users).values({ workspaceId: s.workspaceId, email: `sophia-e01-${Date.now()}@verve.example`, displayName: "Sophia Rosenblatt" }).returning();
    const opp = await createOpportunity(d2, { setupId: setup.id, title: "ANÜ HR-Referentin", needDescription: "Arbeitnehmerüberlassung im HR-Bereich.", kind: "VERVE_EXPERTE" });
    const q = await quickFill(d2, opp.id, { title: "HR-Referentin", resourceKind: "INTERN", internalUserId: sophia!.id, desiredStart: plusDaysIso(todayIso(), -365), plannedEnd: plusDaysIso(todayIso(), 45), vkRate: "900" });
    await db.update(schema.engagements).set({ status: "AKTIV", actualStart: plusDaysIso(todayIso(), -365) }).where(eq(schema.engagements.id, q.engagement.id));
    await ensureRenewalDecisions(s.workspaceId);

    const route = await routeText(d2, MAIL, [{ name: "Sabine Sander", email: "sabine.sander@musterversicherung.example" }]);
    expect(route.account?.id).toBe(acc.id);
    expect(route.ctx?.setup.id).toBe(setup.id);

    const r = await eingangFromText(d2, { text: MAIL, setupId: "AUTO" });
    expect(r.accountName).toBe("Musterversicherung AG (fiktiv)");
    const cards = await cardsOf(r.sourceId);
    const ren = cards.find((c) => item(c).type === "VERLAENGERUNG");
    expect(ren?.objectId).toBe(q.engagement.id);
    const sabine = cards.find((c) => { const i = item(c); return i.type === "PERSON" && i.displayName === "Sabine Sander"; });
    expect(sabine && item(sabine).type === "PERSON" ? (item(sabine) as Extract<IntakeItem, { type: "PERSON" }>).functionTitle : "").toBe("HR Business Partner (K) & Rekrutierung");
    const silke = cards.find((c) => { const i = item(c); return i.type === "PERSON" && i.displayName === "Silke Dornbusch"; })!;
    const si = item(silke) as Extract<IntakeItem, { type: "PERSON" }>;
    expect(si.orgUnitName).toBe("Dienstleistungs-Einkauf");
    expect(si.decisionRole).toBe("EINKAUF_VERTRAGSWEG");
    expect(cards.some((c) => { const i = item(c); return i.type === "PERSON" && /Beispiel/.test(i.displayName); })).toBe(false);
    // auf Start sichtbar
    expect((await listMySuggestions(d2)).some((x) => x.id === ren!.id)).toBe(true);

    const acc1 = await acceptSuggestion(d2, ren!.id, { version: ren!.version, newEnd: plusDaysIso(todayIso(), 45 + 365) });
    expect(acc1.message).toMatch(/bestätigt/);
    const eng = await db.query.engagements.findFirst({ where: eq(schema.engagements.id, q.engagement.id) });
    expect(eng?.plannedEnd).toBe(plusDaysIso(todayIso(), 45 + 365));
    expect(await db.query.renewalDecisions.findFirst({ where: and(eq(schema.renewalDecisions.engagementId, q.engagement.id), inArray(schema.renewalDecisions.status, ["ZU_KLAEREN", "IN_ABSTIMMUNG", "ANGEBOTEN"])) })).toBeUndefined();

    const acc2 = await acceptSuggestion(d2, silke.id, { version: silke.version });
    const fn = await db.query.personFunctions.findFirst({ where: eq(schema.personFunctions.personId, acc2.acceptedObjectId) });
    const unit = fn?.orgUnitId ? await db.query.orgUnits.findFirst({ where: eq(schema.orgUnits.id, fn.orgUnitId) }) : null;
    expect(unit?.name).toBe("Dienstleistungs-Einkauf");
    const ass = await db.query.personAssessments.findFirst({ where: eq(schema.personAssessments.personId, acc2.acceptedObjectId) });
    expect(ass?.decisionRole).toBe("EINKAUF_VERTRAGSWEG");

    // Neu auswerten: offene Karten der Quelle werden überholt, keine Doppelung angenommener Karten
    const again = await eingangFromSource(d2, r.sourceId);
    expect(again.accountName).toBe("Musterversicherung AG (fiktiv)");
  });

  it("E02: unbekannter Kunde → Karte „Neuer Kunde“; nach Übernahme gehören die übrigen Karten (Chance) automatisch dazu", async () => {
    await setupFlags();
    const david = await actorFor("david");
    const name = `Nordwind Logistik ${Date.now().toString(36)} GmbH`;
    const text = `${name}\nHamburg\n\nHallo Herr Beispiel,\nwir brauchen ab Januar zwei Scrum Master für unser Lagerprojekt. Nächster Schritt: Profile bis Ende des Monats schicken.\n\nViele Grüße\nPetra Wind\n--\n${name}\nLeiterin Projektmanagement\nE-Mail petra.wind@nordwind.example`;
    const r = await eingangFromText(david, { text, setupId: "AUTO" });
    expect(r.accountName).toBeNull();
    const cards = await cardsOf(r.sourceId);
    const kunde = cards.find((c) => item(c).type === "KUNDE");
    expect(kunde).toBeTruthy();
    const chance = cards.find((c) => item(c).type === "CHANCE");
    expect(chance?.setupId).toBeNull();
    const aktion = cards.find((c) => item(c).type === "AKTION");
    expect((aktion?.payload as { resolved: { dueDate?: string } }).resolved.dueDate).toBe(parseRelativeDue("Ende des Monats"));
    const a = await acceptSuggestion(david, kunde!.id, { version: kunde!.version });
    expect(a.message).toMatch(/übrigen Karten/);
    const chance2 = (await db.query.suggestions.findFirst({ where: eq(schema.suggestions.id, chance!.id) }))!;
    expect(chance2.setupId).toBeTruthy();
    const c = await acceptSuggestion((await loadActor(david.userId))!, chance2.id, { version: chance2.version });
    const o = await db.query.opportunities.findFirst({ where: eq(schema.opportunities.id, c.acceptedObjectId) });
    expect(o?.setupId).toBe(chance2.setupId);
    expect(o?.status).toBe("IN_KLAERUNG");
  });

  it("E03: Bezug auf Bestand – Aufgabe abhaken, Chance beendet, Stimmung als Check-in, Aufgabe mit Datum", async () => {
    await setupFlags();
    const s = await ensureSeed();
    const david = await actorFor("david");
    const action = await createAction(david, { setupId: s.setupId, title: `Profile an Frau Keller schicken ${Date.now().toString(36)}`, ownerUserId: david.userId, agreedInConversation: true });
    const opp = await createOpportunity(david, { setupId: s.setupId, title: `Plattformmigration Lasttest ${Date.now().toString(36)}`, needDescription: "Lasttests für die Plattformmigration.", kind: "VERVE_EXPERTE" });
    const fopp = await createOpportunity(david, { setupId: s.setupId, title: `Testautomatisierung E03 ${Date.now()}`, needDescription: "Testautomatisierung im Kernteam.", kind: "FREELANCER_EXPERTE" });
    const q = await quickFill(david, fopp.id, { title: "Tester:in", resourceKind: "FREELANCER", newName: "Mara Kleinschmidt (fiktiv)", ekRate: "800", vkRate: "1000", desiredStart: plusDaysIso(todayIso(), -30), plannedEnd: plusDaysIso(todayIso(), 120) });
    await db.update(schema.engagements).set({ status: "AKTIV", actualStart: plusDaysIso(todayIso(), -30) }).where(eq(schema.engagements.id, q.engagement.id));
    const text = "Kurzes Update vom Jour fixe. Die Profile an Frau Keller haben wir erhalten, das ist erledigt. Für die Plattformmigration gab es leider eine Absage vom Fachbereich. Der Kunde ist mit Frau Kleinschmidt sehr zufrieden.";
    const r = await eingangFromText(david, { text, setupId: s.setupId });
    const cards = await cardsOf(r.sourceId);
    const done = cards.find((c) => item(c).type === "ERLEDIGT");
    const status = cards.find((c) => item(c).type === "CHANCE_STATUS");
    const mood = cards.find((c) => item(c).type === "STIMMUNG");
    expect(done && status && mood).toBeTruthy();
    await acceptSuggestion(david, done!.id, { version: done!.version });
    expect((await db.query.actions.findFirst({ where: eq(schema.actions.id, action.id) }))?.status).toBe("ERLEDIGT");
    await acceptSuggestion(david, status!.id, { version: status!.version });
    expect((await db.query.opportunities.findFirst({ where: eq(schema.opportunities.id, opp.id) }))?.status).toBe("BEENDET");
    await acceptSuggestion(david, mood!.id, { version: mood!.version });
    const ci = await db.query.checkins.findMany({ where: and(eq(schema.checkins.engagementId, q.engagement.id), eq(schema.checkins.status, "ERLEDIGT")) });
    expect(ci.some((c) => /Stimmung: positiv/.test(c.note ?? ""))).toBe(true);
  });

  it("E04: Langdock-Weg – Lagebild mit Kürzeln geht an die KI; abgeschnittene Antwort wird gerettet; falsches Kürzel, Verve-Person und Zitat ohne Beleg werden verworfen", async () => {
    await setupFlags();
    const s = await ensureSeed();
    const david = await actorFor("david");
    const acc = await createAccount(david, { name: `Seewind Versicherung ${Date.now().toString(36)} AG`, orgType: "KONZERN", responsibleBdUserId: david.userId });
    const d2 = (await loadActor(david.userId))!;
    const setup = await createSetup(d2, { accountId: acc.id, name: "IT-Betrieb", bdUserId: david.userId, creatorContribution: "BD_ZUSTAENDIG" });
    const opp = await createOpportunity(d2, { setupId: setup.id, title: "Betriebsführung", needDescription: "Unterstützung im IT-Betrieb.", kind: "FREELANCER_EXPERTE" });
    const q = await quickFill(d2, opp.id, { title: "Betriebsingenieur", resourceKind: "FREELANCER", newName: "Lena Lindqvist (fiktiv)", ekRate: "700", vkRate: "900", desiredStart: plusDaysIso(todayIso(), -200), plannedEnd: plusDaysIso(todayIso(), 30) });
    await db.update(schema.engagements).set({ status: "AKTIV", actualStart: plusDaysIso(todayIso(), -200) }).where(eq(schema.engagements.id, q.engagement.id));
    if (!(await db.query.users.findFirst({ where: eq(schema.users.email, "max.beispiel@verveconsulting.de") }))) await db.insert(schema.users).values({ workspaceId: s.workspaceId, email: "max.beispiel@verveconsulting.de", displayName: "Max Beispiel" });
    const text = "Von: Jana Jung <jana.jung@seewind.example>\n\nHallo Herr Beispiel,\nwir möchten den Einsatz von Frau Lindqvist bis zum 30.06.2027 verlängern, Konditionen unverändert.\n\nViele Grüße\nJana Jung\nTeamleiterin IT-Betrieb";
    let sent = "";
    const reply = JSON.stringify({ items: [
      { type: "VERLAENGERUNG", engagementRef: "E1", decision: "VERLAENGERN", newEnd: "2027-06-30", conditionsNote: "Konditionen unverändert", evidenceQuote: "wir möchten den Einsatz von Frau Lindqvist bis zum 30.06.2027 verlängern," },
      { type: "VERLAENGERUNG", engagementRef: "E9", decision: "VERLAENGERN", newEnd: "", conditionsNote: "", evidenceQuote: "Konditionen unverändert" },
      { type: "PERSON", displayName: "Max Beispiel", functionTitle: "", evidenceQuote: "Hallo Herr Beispiel" },
      { type: "SIGNAL", observation: "Erfunden", evidenceQuote: "Dieser Satz steht nicht im Text" },
      { type: "PERSON", displayName: "Jana Jung", functionTitle: "Teamleiterin IT-Betrieb", email: "jana.jung@seewind.example", decisionRole: "BEDARFSTRAEGER", evidenceQuote: "Jana  Jung\nTeamleiterin IT-Betrieb" },
    ] }).replace(/\]\}$/, ', {"type":"AKTION","title":"abgeschnit');
    const fetchImpl = (async (_u: string, init: { body: string }) => {
      sent = init.body;
      return new Response(JSON.stringify({ choices: [{ message: { content: reply } }], usage: { prompt_tokens: 10, completion_tokens: 10 }, model: "m" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const provider = new LangdockProvider({ apiKey: "k", baseUrl: "https://api.langdock.test/v1", defaultModel: "m", fetchImpl });
    const r = await eingangFromText(d2, { text, setupId: "AUTO" }, { provider });
    expect(r.accountName).toBe(acc.name);
    const body = JSON.parse(sent) as { messages: { content: string }[]; max_tokens: number };
    const user = body.messages.at(-1)!.content;
    expect(user).toMatch(/E1: Lena Lindqvist/);
    expect(user).toMatch(/Heute: \d{4}-\d{2}-\d{2}/);
    expect(body.max_tokens).toBeGreaterThanOrEqual(9000);
    expect(r.created).toBe(2);
    expect(r.rejected).toBe(3);
    const cards = await cardsOf(r.sourceId);
    const ren = cards.find((c) => item(c).type === "VERLAENGERUNG")!;
    expect(ren.objectId).toBe(q.engagement.id);
    expect(ren.title).toBe("Verlängerung: Lena Lindqvist bis 30.06.2027");
  });

  it("E05: Laufende und gescheiterte Eingangs-Auswertungen sind sichtbar (Hintergrundlauf, Etappe 39)", async () => {
    const s = await ensureSeed();
    const david = await actorFor("david");
    const base = { workspaceId: s.workspaceId, type: "EINGANG", actorUserId: david.userId, provider: "test", model: "t", promptVersion: "intake.v1", inputHash: "x", inputChars: 1 };
    const [running] = await db.insert(schema.aiJobs).values({ ...base, dedupeKey: `run-${Date.now()}`, status: "GESTARTET" }).returning();
    let st = await listRunningEingang(david);
    expect(st.running.some((j) => j.id === running!.id)).toBe(true);
    // Fehler nach dem Lauf: sichtbar, bis eine spätere Auswertung gelingt
    await db.update(schema.aiJobs).set({ status: "ABGELEHNT", error: "Anbieter antwortet nicht" }).where(eq(schema.aiJobs.id, running!.id));
    st = await listRunningEingang(david);
    expect(st.running.some((j) => j.id === running!.id)).toBe(false);
    expect(st.lastError?.error).toBe("Anbieter antwortet nicht");
    await db.insert(schema.aiJobs).values({ ...base, dedupeKey: `ok-${Date.now()}`, status: "ERFOLGREICH", startedAt: new Date(Date.now() + 1000) });
    st = await listRunningEingang(david);
    expect(st.lastError).toBeNull();
    // ein anderer Nutzer sieht nichts davon
    expect((await listRunningEingang(await actorFor("nina"))).running.some((j) => j.id === running!.id)).toBe(false);
  });
});
