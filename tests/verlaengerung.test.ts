import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { resetConfigCacheForTests } from "@/lib/config";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { loadActor, type Actor } from "@/modules/identity/actor";
import { assignRole } from "@/modules/governance/service";
import { createOpportunity } from "@/modules/opportunities/service";
import { quickFill } from "@/modules/staffing/service";
import { getEngagementDetail, listEngagements } from "@/modules/engagements/service";
import { actOnCheckin, createCheckin, decideRenewal, listRenewalCards, startRenewal } from "@/modules/engagements/care";
import { FixtureMocoClient } from "@/modules/moco/client";
import { listNotifications } from "@/modules/notifications/service";
import { searchAll } from "@/modules/search/service";
import { plusDaysIso, todayIso } from "@/modules/work/calendar";
import { actorFor, ensureSeed } from "./helpers";

async function makeSalesOps(): Promise<Actor> {
  const s = await ensureSeed();
  const [u] = await db.insert(schema.users).values({ workspaceId: s.workspaceId, email: `ops-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}@verve.example`, displayName: "Olga Ops (Sales Operations)" }).returning();
  await assignRole(await actorFor("admin"), { userId: u!.id, role: "SALES_OPS" });
  return (await loadActor(u!.id))!;
}

describe("Etappe 33 (Use Case 1): Verlängerung als Anstoß und Karte", () => {
  it("V01: Sales Operations sieht alle Einsätze, stößt die Verlängerung an; der BD bestätigt mit einem Klick → Periode, Einsatz- und Auftragsende, Moco-Projektende; Sales Ops darf nicht bestätigen", async () => {
    process.env.AI_PROVIDER = "test";
    process.env.FEATURE_BESETZUNG = "true";
    process.env.MOCO_MODE = "fixture";
    process.env.MOCO_FIXTURE_DIR = "./tests/fixtures/moco";
    resetConfigCacheForTests();
    const s = await ensureSeed();
    const david = await actorFor("david");
    const ops = await makeSalesOps();
    const freelancerName = `Rita Renew ${Date.now().toString(36)} (fiktiv)`;
    const opp = await createOpportunity(david, { setupId: s.setupId, title: `Verlängerungsfall ${Date.now()}`, needDescription: "Testautomatisierung im Kernteam.", kind: "FREELANCER_EXPERTE", ownerUserId: david.userId });
    const r = await quickFill(david, opp.id, { title: "Testautomatisierer:in", resourceKind: "FREELANCER", newName: freelancerName, ekRate: "800", vkRate: "1000", desiredStart: plusDaysIso(todayIso(), -30), plannedEnd: plusDaysIso(todayIso(), 60) });
    let e = (await db.query.engagements.findFirst({ where: eq(schema.engagements.id, r.engagement.id) }))!;
    // als Moco-Projekt 1001 markieren (Fixture) – das Ende wird dorthin geschrieben
    await db.update(schema.engagements).set({ mocoProjectId: 1001, status: "AKTIV", actualStart: plusDaysIso(todayIso(), -30) }).where(eq(schema.engagements.id, e.id));
    e = (await db.query.engagements.findFirst({ where: eq(schema.engagements.id, e.id) }))!;
    const oldEnd = e.plannedEnd!;

    // Sales Operations sieht den Einsatz ohne Betreuungszuordnung – mit Person, Kunde, Verlängerungsstand
    const list = await listEngagements(ops, "alle", freelancerName.split(" ")[0]);
    const row = list.items.find((x) => x.id === e.id);
    expect(row).toBeTruthy();
    expect(row!.personName).toBe(freelancerName);
    const detail = await getEngagementDetail(ops, e.id);
    expect(detail.access.ops).toBe(true);
    expect(detail.access.commercial).toBe(false);

    // Anstoßen: neues Ende muss nach dem heutigen liegen
    await expect(startRenewal(ops, e.id, { newEnd: oldEnd })).rejects.toBeInstanceOf(ValidationError);
    const newEnd = plusDaysIso(oldEnd, 180);
    const dec = await startRenewal(ops, e.id, { newEnd, conditions: "UNVERAENDERT", note: "Kunde hat mündlich zugesagt." });
    expect(dec.status).toBe("IN_ABSTIMMUNG");
    expect(dec.proposedFrom).toBe(plusDaysIso(oldEnd, 1));
    expect(dec.proposedTo).toBe(newEnd);
    expect(dec.conditionsNote).toMatch(/unverändert.*EK 800.*VK 1000/);
    // BD hat die Karte, Sales Ops nicht (sie ist keine Entscheiderin)
    const bdCards = await listRenewalCards(david);
    const card = bdCards.find((c) => c.engagementId === e.id)!;
    expect(card.mode).toBe("ENTSCHEIDEN");
    expect(card.person).toBe(freelancerName);
    expect((await listRenewalCards(ops)).some((c) => c.engagementId === e.id)).toBe(false);
    expect((await listNotifications(david)).some((n) => n.title.startsWith("Verlängerung bestätigen") && n.title.includes(freelancerName))).toBe(true);

    // Sales Ops darf nicht bestätigen; Anker (nina) sieht den Einsatz gar nicht
    await expect(decideRenewal(ops, e.id, { decision: "BESTAETIGEN" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(decideRenewal(await actorFor("nina"), e.id, { decision: "BESTAETIGEN" })).rejects.toBeInstanceOf(NotFoundError);

    // BD bestätigt mit einem Klick
    const client = new FixtureMocoClient("./tests/fixtures/moco");
    const res = await decideRenewal(david, e.id, { version: card.version, decision: "BESTAETIGEN", contractFollowUp: "Nachtrag" }, client);
    expect(res.decision.status).toBe("BESTAETIGT");
    expect(res.mocoWritten).toBe(true);
    expect((await client.project(1001))?.finish_date).toBe(newEnd);
    const after = (await db.query.engagements.findFirst({ where: eq(schema.engagements.id, e.id) }))!;
    expect(after.plannedEnd).toBe(newEnd);
    if (after.orderId) expect((await db.query.orders.findFirst({ where: eq(schema.orders.id, after.orderId) }))?.plannedEnd).toBe(newEnd);
    const periods = await db.query.engagementPeriods.findMany({ where: and(eq(schema.engagementPeriods.engagementId, e.id), eq(schema.engagementPeriods.kind, "BESTAETIGT")) });
    const np = periods.find((p) => p.validTo === newEnd)!;
    expect(np).toBeTruthy();
    expect(Number(np.ek)).toBe(800);
    expect(Number(np.vk)).toBe(1000);
    // Karte verschwunden, Rückmeldung an Sales Ops
    expect((await listRenewalCards(david)).some((c) => c.engagementId === e.id)).toBe(false);
    expect((await listNotifications(ops)).some((n) => n.title.startsWith("Verlängerung bestätigt"))).toBe(true);
    // Einsatzliste zeigt den Stand
    const row2 = (await listEngagements(ops, "alle", freelancerName.split(" ")[0])).items.find((x) => x.id === e.id)!;
    expect(row2.renewalStatus).toBe("BESTAETIGT");
    expect(row2.renewalTo).toBe(newEnd);
  });

  it("V02: Ablehnen geht mit Notiz zurück; Weitergeben nur an kommerziell Zuständige; Stimmung aus Check-ins steht in der Liste; Suche findet Person, Kunde und Einsatz", async () => {
    process.env.AI_PROVIDER = "test";
    process.env.FEATURE_BESETZUNG = "true";
    resetConfigCacheForTests();
    const s = await ensureSeed();
    const david = await actorFor("david");
    const petra = await actorFor("petra");
    const ops = await makeSalesOps();
    const freelancerName = `Sven Such ${Date.now().toString(36)} (fiktiv)`;
    const opp = await createOpportunity(david, { setupId: s.setupId, title: `Ablehnungsfall ${Date.now()}`, needDescription: "Kurzer Einsatz.", kind: "FREELANCER_EXPERTE", ownerUserId: david.userId });
    const r = await quickFill(david, opp.id, { title: "Tester:in", resourceKind: "FREELANCER", newName: freelancerName, ekRate: "700", desiredStart: plusDaysIso(todayIso(), -10), plannedEnd: plusDaysIso(todayIso(), 40) });
    await db.update(schema.engagements).set({ status: "AKTIV", actualStart: plusDaysIso(todayIso(), -10) }).where(eq(schema.engagements.id, r.engagement.id));
    const e = (await db.query.engagements.findFirst({ where: eq(schema.engagements.id, r.engagement.id) }))!;
    await startRenewal(ops, e.id, { newEnd: plusDaysIso(e.plannedEnd!, 90) });
    // Weitergeben an Sales Ops ist nicht erlaubt (nicht kommerziell), an Petra (Principal) schon
    await expect(decideRenewal(david, e.id, { decision: "WEITERGEBEN", targetUserId: ops.userId })).rejects.toBeInstanceOf(ValidationError);
    const handed = await decideRenewal(david, e.id, { decision: "WEITERGEBEN", targetUserId: petra.userId, note: "Bitte du, ich bin im Urlaub." });
    expect(handed.decision.commercialOwnerUserId).toBe(petra.userId);
    const rej = await decideRenewal(petra, e.id, { decision: "ABLEHNEN", note: "Budget läuft aus." });
    expect(rej.decision.status).toBe("ABGELEHNT");
    expect(rej.decision.availabilityNote).toMatch(/Abgelehnt.*Budget/);
    expect((await listNotifications(ops)).some((n) => n.title.startsWith("Verlängerung abgelehnt"))).toBe(true);
    const unchanged = (await db.query.engagements.findFirst({ where: eq(schema.engagements.id, e.id) }))!;
    expect(unchanged.plannedEnd).toBe(e.plannedEnd);

    // Stimmung: Freelancer-Check-in per Schnellerfassung → Spalte in der Liste
    const ci = await createCheckin(david, e.id, { side: "FREELANCER", dueDate: todayIso() });
    await actOnCheckin(david, ci.id, { version: ci.version, action: "ERLEDIGEN", mood: "NEGATIV" });
    const row = (await listEngagements(ops, "alle", "Sven Such")).items.find((x) => x.id === e.id)!;
    expect(row.moodFreelancer?.mood).toBe("NEGATIV");
    expect(row.moodKunde).toBeNull();

    // Suche
    const byPerson = await searchAll(ops, "Sven Such");
    expect(byPerson.groups.find((g) => g.kind === "EINSATZ")?.hits.some((h) => h.id === e.id)).toBe(true);
    expect(byPerson.groups.find((g) => g.kind === "FREELANCER")?.hits.some((h) => h.title === freelancerName)).toBe(true);
    const byAccount = await searchAll(david, "Beispielkonzern");
    expect(byAccount.groups.find((g) => g.kind === "KUNDE")?.hits.some((h) => h.id === s.accountId)).toBe(true);
    // Anker nina sieht den Einsatz in der Suche nicht
    const nina = await searchAll(await actorFor("nina"), "Sven Such");
    expect(nina.groups.find((g) => g.kind === "EINSATZ")?.hits.some((h) => h.id === e.id) ?? false).toBe(false);
  });
});
