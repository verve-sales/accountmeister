import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { resetConfigCacheForTests } from "@/lib/config";
import { ValidationError } from "@/lib/errors";
import { extractAccountPage } from "@/modules/assistant/accountPage";
import { decideCard, getThreadView, sendMessage } from "@/modules/assistant/service";
import { createInitiative, ensureInitiativeReminders, parseDueHint, updateProcurement } from "@/modules/agenda/service";
import { changeSosStatus, createSos, listOpenSosForActor } from "@/modules/sos/service";
import { getHealth } from "@/modules/health/service";
import { getAccount } from "@/modules/accounts/service";
import { actorFor, ensureSeed } from "./helpers";

const PAGE = fs.readFileSync(path.join(__dirname, "fixtures", "account-page.md"), "utf8");
const APPLY_ORDER = ["KUNDE", "EINSORTIERUNG", "SETUP", "TEAM", "BESCHAFFUNG", "INITIATIVE", "PERSON", "EINSATZ", "CHANCE", "HEBEL", "RISIKO", "SOS", "SIGNAL", "AKTION", "KONTAKT", "FRAGE", "ACCOUNTZIEL"];

describe("Etappe 26: Kundenagenda, Beschaffung, Berater, SOS – und die Account-Seite im Assistenten", () => {
  it("Termine in Kundensprache werden zu Daten", () => {
    expect(parseDueHint("Ende 2026")).toBe("2026-12-31");
    expect(parseDueHint("Q2 2027")).toBe("2027-06-30");
    expect(parseDueHint("Dezember 2026")).toBe("2026-12-31");
    expect(parseDueHint("bis 15.03.2027")).toBe("2027-03-15");
    expect(parseDueHint("irgendwann")).toBeNull();
  });

  it("Eine eingefügte Account-Seite wird vollständig erkannt – ohne Umsatzschätzung und ohne leere Vorlagenfelder", () => {
    const r = extractAccountPage(PAGE, { hasCustomer: false });
    expect(r.recognized).toBe(true);
    const types = r.items.map((i) => i.type);
    expect(types[0]).toBe("KUNDE");
    expect(types.filter((t) => t === "INITIATIVE")).toHaveLength(7);
    expect(r.items.find((i) => i.type === "INITIATIVE" && i.title.includes("Ende 2026"))).toMatchObject({ kind: "INITIATIVE", dueHint: "Ende 2026" });
    expect(r.items.filter((i) => i.type === "PERSON")).toHaveLength(2);
    expect(r.items.find((i) => i.type === "PERSON" && i.displayName === "Anna Beispiel")).toMatchObject({ decisionRole: "BEDARFSTRAEGER", email: "anna.beispiel@nordbahn.example" });
    expect(r.items.find((i) => i.type === "BESCHAFFUNG")).toMatchObject({ channel: "VERMITTLER", intermediaryName: "Beispiel Personal GmbH" });
    expect(r.items.find((i) => i.type === "EINSATZ")).toMatchObject({ plannedEnd: "2026-12-31", consultantName: "Nina Demo" });
    expect(r.items.find((i) => i.type === "HEBEL")).toMatchObject({ lever: "AUSWEITEN" });
    expect(r.items.find((i) => i.type === "RISIKO")).toMatchObject({ risk: "NACHBARTEAM" });
    expect(r.items.find((i) => i.type === "TEAM")).toMatchObject({ bdName: "David Demo", ankerNames: ["Nina Demo"] });
    expect(JSON.stringify(r.items)).not.toMatch(/Umsatz|____/);
    expect(r.missing.join(" ")).toMatch(/budgetnah/);
    // Jede Karte zitiert wörtlich
    for (const i of r.items) expect(PAGE.replace(/\*\*/g, "")).toContain(i.evidenceQuote);
  });

  it("Assistent bei der Kundenanlage: Seite einfügen, alle Karten übernehmen – alles landet an der richtigen Stelle", async () => {
    process.env.AI_PROVIDER = "test";
    resetConfigCacheForTests();
    await ensureSeed();
    const david = await actorFor("david");
    const view = await getThreadView(david, { type: "GLOBAL" });
    const r = await sendMessage(david, { threadId: view.thread.id, text: PAGE });
    expect(r.cards.length).toBeGreaterThanOrEqual(15);
    const ordered = [...r.cards].sort((a, b) => APPLY_ORDER.indexOf(a.item.type) - APPLY_ORDER.indexOf(b.item.type));
    const notes: string[] = [];
    for (const c of ordered) {
      const res = await decideCard(david, { threadId: view.thread.id, messageId: r.message.id, cardId: c.id, decision: "UEBERNEHMEN" });
      notes.push(`${c.item.type}: ${res.card.note ?? ""}`);
    }
    const account = await db.query.accounts.findFirst({ where: eq(schema.accounts.name, "Nordbahn Logistik AG (fiktiv)") });
    expect(account).toBeTruthy();
    expect(account!.procurementChannel).toBe("VERMITTLER");
    expect(account!.intermediaryName).toBe("Beispiel Personal GmbH");
    const inis = await db.query.accountInitiatives.findMany({ where: eq(schema.accountInitiatives.accountId, account!.id) });
    expect(inis).toHaveLength(7);
    expect(inis.find((i) => i.title.includes("Ende 2026"))?.dueDate).toBe("2026-12-31");
    const persons = await db.query.persons.findMany({ where: eq(schema.persons.accountId, account!.id) });
    expect(persons.map((p) => p.displayName).sort()).toEqual(["Anna Beispiel", "Jan Muster"]);
    expect(persons.find((p) => p.displayName === "Anna Beispiel")?.email).toBe("anna.beispiel@nordbahn.example");
    const orders = await db.select({ o: schema.orders }).from(schema.orders).innerJoin(schema.opportunities, eq(schema.opportunities.id, schema.orders.opportunityId)).where(eq(schema.opportunities.accountId, account!.id));
    expect(orders).toHaveLength(1);
    expect(orders[0]!.o.plannedEnd).toBe("2026-12-31");
    expect(orders[0]!.o.consultantName).toBe("Nina Demo (Anker)");
    const prios = await db.query.accountPriorities.findMany({ where: eq(schema.accountPriorities.accountId, account!.id) });
    expect(prios.map((p) => p.kind)).toContain("AUSWEITEN");
    const h = await getHealth(david, account!.id);
    expect(h.answers.risks?.items).toContain("NACHBARTEAM");
    const setup = await db.query.projectSetups.findFirst({ where: eq(schema.projectSetups.accountId, account!.id) });
    const nina = await actorFor("nina");
    const m = await db.query.setupMemberships.findFirst({ where: and(eq(schema.setupMemberships.setupId, setup!.id), eq(schema.setupMemberships.userId, nina.userId)) });
    expect(m?.contribution).toBe("ANKER_KONTEXT");
    expect(notes.join("\n")).toMatch(/TEAM: .*bereits zuständiger BD/);
  });

  it("SOS: Anker löst aus, BD sieht es auf der Startseite, Health-Check zieht ab, Lösung ist Pflicht", async () => {
    const s = await ensureSeed();
    const nina = await actorFor("nina");
    const david = await actorFor("david");
    const lars = await actorFor("lars");
    const before = await getHealth(david, s.accountId);
    const sos = await createSos(nina, { accountId: s.accountId, setupId: s.setupId, kind: "ANKER_BLOCKIERT", title: "Kein Zugang mehr zum Lenkungskreis", situation: "Seit der Umstrukturierung werde ich nicht mehr zum Lenkungskreis eingeladen.", need: "BD soll mit Frau Keller sprechen" });
    expect((await listOpenSosForActor(david)).some((x) => x.id === sos.id)).toBe(true);
    expect((await listOpenSosForActor(lars)).some((x) => x.id === sos.id)).toBe(false);
    const after = await getHealth(david, s.accountId);
    expect(after.dimensions.find((d) => d.key === "RISIKEN")!.reasons.join(" ")).toMatch(/offene\(s\) SOS/);
    if (before.score !== null && after.score !== null) expect(after.score).toBeLessThan(before.score);
    await expect(changeSosStatus(nina, sos.id, { version: sos.version, status: "GELOEST" })).rejects.toBeInstanceOf(ValidationError);
    await expect(changeSosStatus(lars, sos.id, { version: sos.version, status: "GELOEST", resolution: "x" })).rejects.toBeTruthy();
    const done = await changeSosStatus(nina, sos.id, { version: sos.version, status: "GELOEST", resolution: "Frau Keller lädt wieder ein." });
    expect(done.status).toBe("GELOEST");
    expect((await listOpenSosForActor(david)).some((x) => x.id === sos.id)).toBe(false);
  });

  it("Initiative mit Datum erinnert den zuständigen BD rechtzeitig – genau einmal", async () => {
    const s = await ensureSeed();
    const david = await actorFor("david");
    const due = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
    const ini = await createInitiative(david, { accountId: s.accountId, kind: "INITIATIVE", title: `Go-live Testplattform ${Date.now().toString(36)}`, dueDate: due });
    await ensureInitiativeReminders(david);
    const key = `initiative:${ini.id}`;
    const task = await db.query.standardTasks.findFirst({ where: eq(schema.standardTasks.key, key) });
    expect(task?.actionId).toBeTruthy();
    const action = await db.query.actions.findFirst({ where: eq(schema.actions.id, task!.actionId!) });
    expect(action?.status).toBe("VORGESCHLAGEN");
    expect(action?.title).toMatch(/Go-live Testplattform/);
    await ensureInitiativeReminders(david);
    expect((await db.query.standardTasks.findMany({ where: eq(schema.standardTasks.key, key) })).length).toBe(1);
  });

  it("Beschaffungsweg: Vermittler braucht einen Namen; Fremde dürfen nicht pflegen", async () => {
    const s = await ensureSeed();
    const david = await actorFor("david");
    const lars = await actorFor("lars");
    const acc = await getAccount(david, s.accountId);
    await expect(updateProcurement(david, s.accountId, { version: acc.version, procurementChannel: "VERMITTLER", intermediaryName: "" })).rejects.toBeInstanceOf(ValidationError);
    await expect(updateProcurement(lars, s.accountId, { version: acc.version, procurementChannel: "DIREKT" })).rejects.toBeTruthy();
    const u = await updateProcurement(david, s.accountId, { version: acc.version, procurementChannel: "RAHMENVERTRAG", intermediaryName: "Rahmenvertrag IT 2025" });
    expect(u.procurementChannel).toBe("RAHMENVERTRAG");
  });
});
