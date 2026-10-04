import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { resetConfigCacheForTests } from "@/lib/config";
import { ForbiddenError } from "@/lib/errors";
import { FixtureMocoClient, pickProject, pickUser, type MocoClient, type MocoProject, type MocoUser } from "@/modules/moco/client";
import { applyImport, buildImportPreview, decisionsFromForm, getImport, nameSimilarity, normName, type ImportItem } from "@/modules/moco/import";
import { handleMocoWebhook, listHints, resolveHint, runMocoSync, verifyMocoSignature } from "@/modules/moco/sync";
import { ensureCatchups } from "@/modules/engagements/care";
import { buildTeamActivity } from "@/modules/activity/service";
import { loadActor } from "@/modules/identity/actor";
import { actorFor, ensureSeed } from "./helpers";

const FIX = "./tests/fixtures/moco";

/** Veränderbarer Client für den Sync-Test: startet mit den Fixtures, Projekte lassen sich überschreiben. */
class MemoryMocoClient implements MocoClient {
  readonly kind = "fixture" as const;
  private base = new FixtureMocoClient(FIX);
  projectsOverride: MocoProject[] | null = null;
  extraUsers: MocoUser[] = [];
  users = async (o?: { includeArchived?: boolean }) => [...(await this.base.users(o)), ...this.extraUsers];
  companies = (o?: { type?: "customer" | "supplier" | "organization" }) => this.base.companies(o);
  projectGroups = () => this.base.projectGroups();
  projects = async (o: { includeArchived?: boolean; updatedFrom?: string } = {}) => {
    const rows = this.projectsOverride ?? (await this.base.projects({ includeArchived: true }));
    return rows.filter((p) => o.includeArchived || p.active);
  };
  project = async (id: number) => (await this.projects({ includeArchived: true })).find((p) => p.id === id) ?? null;
}

function setMocoEnv() {
  process.env.MOCO_MODE = "fixture";
  process.env.MOCO_FIXTURE_DIR = FIX;
  process.env.MOCO_WEBHOOK_SECRET = "0123456789abcdef0123456789abcdef";
  process.env.FEATURE_BESETZUNG = "true";
  resetConfigCacheForTests();
}

describe("Etappe 31: Moco-Anbindung", () => {
  it("M00: Feldwhitelist und Namensabgleich", () => {
    const u = pickUser({ id: 1, firstname: "A", lastname: "B", email: "A@X.de", iban: "DE00", home_address: "geheim", unit: { id: 1, name: "Team" }, role: { id: 2, name: "Teamleiter" } });
    expect(u.email).toBe("a@x.de");
    expect((u as unknown as Record<string, unknown>).iban).toBeUndefined();
    const p = pickProject({ id: 5, name: "X", contracts: [{ id: 1, user_id: 2, firstname: "F", lastname: "L", active: true, hourly_rate: "95.0" }] });
    expect(p.contracts[0]!.hourly_rate).toBe(95);
    expect(normName("Beispielkonzern AG (fiktiv)")).toBe("beispielkonzern");
    expect(nameSimilarity("ITERGO Informationstechnologie GmbH", "ITERGO")).toBeGreaterThanOrEqual(0.85);
    expect(nameSimilarity("Nordlicht Versicherung AG", "Südwind Bank")).toBe(0);
  });

  it("M01: Vorschau – Kunde/Setup/Nutzer per E-Mail und Name verknüpft, Rest neu; nur CEO/Principal", async () => {
    setMocoEnv();
    const s = await ensureSeed();
    const petra = await actorFor("petra");
    await expect(buildImportPreview(await actorFor("nina"))).rejects.toBeInstanceOf(ForbiddenError);
    const imp = await buildImportPreview(petra);
    const items = imp.items as ImportItem[];
    const kunde = items.find((i) => i.type === "KUNDE" && i.mocoId === 101)!;
    expect(kunde.proposal).toBe("LINK");
    expect(kunde.targetId).toBe(s.accountId);
    expect(items.find((i) => i.type === "KUNDE" && i.mocoId === 102)!.proposal).toBe("NEW");
    expect(items.find((i) => i.type === "KUNDE" && i.mocoId === 103)).toBeUndefined(); // ohne aktives Projekt
    const setup11 = items.find((i) => i.type === "SETUP" && i.mocoId === 11)!;
    expect(setup11.proposal).toBe("LINK");
    expect(setup11.targetId).toBe(s.setupId);
    expect(items.find((i) => i.type === "SETUP" && i.mocoId === 12)!.proposal).toBe("NEW");
    const noGroup = items.find((i): i is Extract<ImportItem, { type: "SETUP" }> => i.type === "SETUP" && i.key === "setup:none:102")!;
    expect(noGroup.name).toBe("Ohne Bereich");
    const david = items.find((i) => i.type === "PERSON" && i.mocoId === 501)!;
    expect(david.proposal).toBe("LINK");
    expect(david.targetId).toBe(petra.userId === s.users.david ? petra.userId : s.users.david);
    const anna = items.find((i): i is Extract<ImportItem, { type: "PERSON" }> => i.type === "PERSON" && i.mocoId === 502)!;
    expect(anna.proposal).toBe("NEW");
    expect(anna.teamlead).toBe(true);
    const finn = items.find((i): i is Extract<ImportItem, { type: "PERSON" }> => i.type === "PERSON" && i.mocoId === 601)!;
    expect(finn.personKind).toBe("FREELANCER");
    const greta = items.find((i) => i.type === "PERSON" && i.mocoId === 602)!;
    expect(greta.proposal).toBe("NEW"); // Freelancer ohne E-Mail ist erlaubt
    expect(items.filter((i) => i.type === "EINSATZ")).toHaveLength(4); // 9005 inaktiv, 1004 archiviert
    expect(items.find((i) => i.type === "TEAM")!.name).toBe("Team Nord");
    expect(items.find((i) => i.type === "PERSON" && i.mocoId === 701)).toBeUndefined(); // inaktiv
  });

  it("M02: Übernahme – Zugänge als Anker, Teamleitung, Freelancer-Pool, Setups mit BD, Einsätze aktiv mit Check-ins nur für Freelancer; idempotent", async () => {
    setMocoEnv();
    const s = await ensureSeed();
    const petra = await actorFor("petra");
    const imp = await buildImportPreview(petra);
    const items = imp.items as ImportItem[];
    const setupKeys = items.filter((i) => i.type === "SETUP").map((i) => i.key);
    const form: Record<string, string> = {};
    for (const k of setupKeys) form[`d.${k}.bdUserId`] = s.users.david;
    form["d.setup:12.principalUserId"] = petra.userId;
    const res = await applyImport(petra, imp.id, decisionsFromForm(form));
    expect(res.errors).toEqual([]);
    expect(res.created.einsaetze).toBe(4);
    expect(res.created.kunden).toBe(1);
    expect(res.created.setups).toBe(2); // Gruppe 12 + „Ohne Bereich“ bei Nordlicht
    expect(res.created.freelancer).toBe(2);
    expect(res.created.nutzer).toBe(2); // Anna, Ben
    // Anna: Zugang, Rolle Anker, Leitung Team Nord; David verknüpft, nicht dupliziert
    const anna = await db.query.users.findFirst({ where: eq(schema.users.mocoUserId, 502) });
    expect(anna).toBeTruthy();
    const annaRoles = await db.query.roleAssignments.findMany({ where: eq(schema.roleAssignments.userId, anna!.id) });
    expect(annaRoles.map((r) => r.role)).toEqual(["ANKER"]);
    const team = await db.query.teams.findFirst({ where: eq(schema.teams.mocoUnitId, 31) });
    const lead = await db.query.teamMembers.findFirst({ where: and(eq(schema.teamMembers.teamId, team!.id), eq(schema.teamMembers.userId, anna!.id)) });
    expect(lead?.role).toBe("LEITUNG");
    expect((await db.query.users.findMany({ where: eq(schema.users.email, "david.demo@verve.example") })).length).toBe(1);
    expect((await db.query.users.findFirst({ where: eq(schema.users.id, s.users.david) }))?.mocoUserId).toBe(501);
    // Kunde verknüpft, Setup verknüpft und mit Gruppen-ID, neues Setup mit Principal-Zuständigkeit
    expect((await db.query.accounts.findFirst({ where: eq(schema.accounts.id, s.accountId) }))?.mocoCompanyId).toBe(101);
    expect((await db.query.projectSetups.findFirst({ where: eq(schema.projectSetups.id, s.setupId) }))?.mocoProjectGroupId).toBe(11);
    const setup12 = await db.query.projectSetups.findFirst({ where: eq(schema.projectSetups.mocoProjectGroupId, 12) });
    expect(setup12?.bdUserId).toBe(s.users.david);
    const pm = await db.query.setupMemberships.findFirst({ where: and(eq(schema.setupMemberships.setupId, setup12!.id), eq(schema.setupMemberships.userId, petra.userId)) });
    expect(pm?.contribution).toBe("PRINCIPAL_ZUSTAENDIG");
    // Einsätze: aktiv, Freelancer mit 2 Check-ins, intern ohne; Konditionen €/Stunde, EK leer
    const engs = await db.query.engagements.findMany({ where: eq(schema.engagements.mocoProjectId, 1001) });
    expect(engs).toHaveLength(2);
    expect(engs.every((e) => e.status === "AKTIV" && e.actualStart === "2026-07-01" && e.plannedEnd === "2026-12-31")).toBe(true);
    const fl = engs.find((e) => e.freelancerId)!;
    const intern = engs.find((e) => e.internalUserId)!;
    expect(intern.internalUserId).toBe(s.users.david);
    const flCheckins = await db.query.checkins.findMany({ where: eq(schema.checkins.engagementId, fl.id) });
    expect(flCheckins.map((c) => c.side).sort()).toEqual(["FREELANCER", "KUNDE"]);
    expect(await db.query.checkins.findMany({ where: eq(schema.checkins.engagementId, intern.id) })).toHaveLength(0);
    const period = await db.query.engagementPeriods.findFirst({ where: eq(schema.engagementPeriods.engagementId, fl.id) });
    expect(period?.vk).toBe("95.00");
    expect(period?.ek).toBeNull();
    expect(period?.rateUnit).toBe("STUNDE");
    const opp = await db.query.opportunities.findFirst({ where: eq(schema.opportunities.id, fl.opportunityId) });
    expect(opp?.status).toBe("BEAUFTRAGT");
    expect(opp?.mocoProjectId).toBe(1001);
    expect(fl.orderId).toBeTruthy();
    const pos = await db.query.staffingPositions.findFirst({ where: eq(schema.staffingPositions.id, fl.positionId) });
    expect(pos?.status).toBe("BESETZT");
    // Catch-up-Lauf legt für interne nichts an, für Freelancer nichts Doppeltes
    await ensureCatchups(petra.workspaceId);
    expect(await db.query.checkins.findMany({ where: eq(schema.checkins.engagementId, intern.id) })).toHaveLength(0);
    expect(await db.query.checkins.findMany({ where: eq(schema.checkins.engagementId, fl.id) })).toHaveLength(2);
    // Zweiter Lauf: alles „verknüpfen“, keine Dubletten
    const imp2 = await buildImportPreview(petra);
    const items2 = imp2.items as ImportItem[];
    expect(items2.filter((i) => i.type === "EINSATZ").every((i) => i.proposal === "LINK" && i.note === "bereits verknüpft")).toBe(true);
    expect(items2.filter((i) => i.type === "KUNDE").every((i) => i.proposal === "LINK")).toBe(true);
    const res2 = await applyImport(petra, imp2.id);
    expect(res2.created.einsaetze).toBe(0);
    expect(res2.created.nutzer).toBe(0);
    expect(await db.query.engagements.findMany({ where: eq(schema.engagements.mocoProjectId, 1001) })).toHaveLength(2);
    const stored = await getImport(petra, imp.id);
    expect(stored.status).toBe("UEBERNOMMEN");
    // Teamleiter-Kachel: Anna sieht ihr Team mit Zahlen
    const annaActor = (await loadActor(anna!.id))!;
    const tiles = await buildTeamActivity(annaActor);
    expect(tiles[0]?.teamName).toBe("Team Nord");
    expect(tiles[0]?.members.map((m) => m.name)).toContain("David Demo (BD)");
  });

  it("M03: Sync – Ende geändert, Zuweisung inaktiv, neues Projekt, neuer Nutzer; Hinweise mit 1-Klick", async () => {
    setMocoEnv();
    const petra = await actorFor("petra");
    const client = new MemoryMocoClient();
    const base = await client.projects({ includeArchived: true });
    const p1001 = base.find((p) => p.id === 1001)!;
    const p1003 = base.find((p) => p.id === 1003)!;
    client.projectsOverride = [
      { ...p1001, finish_date: "2027-03-31" },
      { ...p1003, contracts: p1003.contracts.map((c) => (c.id === 9004 ? { ...c, active: false } : c)) },
      { ...p1001, id: 1999, name: "Neues Vorhaben", contracts: [{ ...p1001.contracts[0]!, id: 9999 }] },
      ...base.filter((p) => ![1001, 1003].includes(p.id)),
    ];
    client.extraUsers = [{ id: 504, firstname: "Neu", lastname: "Nachzug (fiktiv)", email: "neu.nachzug@verve.example", active: true, external: false, unit: { id: 31, name: "Team Nord" }, role: { id: 2, name: "Berater" } }];
    const counts = await runMocoSync({ client, workspaceId: petra.workspaceId });
    expect(counts.neueNutzer).toBe(1);
    const neu = await db.query.users.findFirst({ where: eq(schema.users.mocoUserId, 504) });
    expect((await db.query.roleAssignments.findMany({ where: eq(schema.roleAssignments.userId, neu!.id) })).map((r) => r.role)).toEqual(["ANKER"]);
    const hints = await listHints(petra, { status: "OFFEN" });
    const ende = hints.find((h) => h.kind === "ENDE_GEAENDERT")!;
    const inaktiv = hints.find((h) => h.kind === "CONTRACT_INAKTIV")!;
    expect(hints.some((h) => h.kind === "NEUES_PROJEKT" && /Neues Vorhaben/.test(h.title))).toBe(true);
    expect(hints.some((h) => h.kind === "NUTZER_INAKTIV")).toBe(false); // Olaf war nie im AM
    // Übernehmen: Ende nachgezogen; Einsatz beendet mit abgesagten Check-ins; Anker darf nicht
    await expect(resolveHint(await actorFor("nina"), ende.id, "UEBERNEHMEN")).rejects.toThrow();
    await resolveHint(petra, ende.id, "UEBERNEHMEN");
    expect((await db.query.engagements.findFirst({ where: eq(schema.engagements.id, ende.subjectId!) }))?.plannedEnd).toBe("2027-03-31");
    await resolveHint(petra, inaktiv.id, "UEBERNEHMEN");
    const ended = await db.query.engagements.findFirst({ where: eq(schema.engagements.id, inaktiv.subjectId!) });
    expect(ended?.status).toBe("ENDET");
    expect((await db.query.checkins.findMany({ where: eq(schema.checkins.engagementId, ended!.id) })).every((c) => c.status === "ABGESAGT")).toBe(true);
    // Erneuter Lauf erzeugt keine doppelten Hinweise
    const again = await runMocoSync({ client, workspaceId: petra.workspaceId });
    expect(again.hinweise).toBe(0);
  });

  it("M04: Webhook – Signatur HMAC-SHA256, Ereignis protokolliert, ungültig abgelehnt", async () => {
    setMocoEnv();
    const body = JSON.stringify({ id: 1001, name: "Datenplattform Ausbau" });
    const sig = createHmac("sha256", "0123456789abcdef0123456789abcdef").update(body).digest("hex");
    expect(verifyMocoSignature(body, sig)).toBe(true);
    expect(verifyMocoSignature(body, "deadbeef")).toBe(false);
    const bad = await handleMocoWebhook({ target: "Project", event: "update", signature: "deadbeef" }, body, { wait: true });
    expect(bad.accepted).toBe(false);
    const ok = await handleMocoWebhook({ target: "Project", event: "update", signature: sig }, body, { wait: true });
    expect(ok.accepted).toBe(true);
    const events = await db.query.mocoEvents.findMany({ where: eq(schema.mocoEvents.mocoId, 1001) });
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.some((e) => e.signatureOk && e.processedAt)).toBe(true);
  });
});
