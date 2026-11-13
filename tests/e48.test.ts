import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { resetConfigCacheForTests } from "@/lib/config";
import { ForbiddenError } from "@/lib/errors";
import { createAccount } from "@/modules/accounts/service";
import { createSetup } from "@/modules/setups/service";
import { createOpportunity } from "@/modules/opportunities/service";
import { quickFill } from "@/modules/staffing/service";
import { addContractDocument, addPeriod, changeEngagementStatus, setContractDocumentStatus, uploadSignedVersion } from "@/modules/engagements/service";
import { acknowledgeHandover, createHandover } from "@/modules/conversion/handover";
import { buildGfOverview } from "@/modules/overview/gf";
import { assignIntakeSetup, curateCards, eingangFromText, routeText } from "@/modules/eingang/service";
import { acceptSuggestion } from "@/modules/suggestions/service";
import { FixtureSpClient, fixtureState, resetFixture } from "@/modules/sharepoint/client";
import { setupSite } from "@/modules/sharepoint/service";
import { extractOrderNumber, looksLikeOrder } from "@/modules/sharepoint/documents";
import { runMailInbox, type InboxClient, type InboxMeta } from "@/modules/mailin/service";
import { DEMO_USERS } from "@/db/seed";
import { loadActor } from "@/modules/identity/actor";
import { intakeItemSchema, type IntakeItem } from "@/modules/ai/schemas";
import { plusDaysIso, todayIso } from "@/modules/work/calendar";
import { actorFor, ensureSeed } from "./helpers";

function env() {
  process.env.AI_PROVIDER = "test";
  process.env.FEATURE_BESETZUNG = "true";
  process.env.SHAREPOINT_MODE = "fixture";
  resetConfigCacheForTests();
}
const u = () => Date.now().toString(36);
const card = (raw: Record<string, unknown>) => ({ item: intakeItemSchema.parse({ evidenceQuote: "Beleg im Text", ...raw }) as IntakeItem, resolved: {} });

describe("e48: GF-Start, leisere KI, Dokumentenfluss", () => {
  it("G01: GF-Übersicht – Auslaufendes mit Namen (8 Wochen), Pipeline mit VK × Köpfe, Team mit Überfälligem; nur für die GF", async () => {
    env();
    const s = await ensureSeed();
    const david = await actorFor("david");
    const ceo = await actorFor("clemens");
    const name = `Gerd Gf ${u()} (fiktiv)`;
    const opp = await createOpportunity(david, { setupId: s.setupId, title: `E48 Läuft aus ${u()}`, needDescription: "Einsatz endet bald.", kind: "FREELANCER_EXPERTE" });
    const q = await quickFill(david, opp.id, { title: "Tester", resourceKind: "FREELANCER", newName: name, ekRate: "600", vkRate: "960", desiredStart: plusDaysIso(todayIso(), -90), plannedEnd: plusDaysIso(todayIso(), 30) });
    await db.update(schema.engagements).set({ status: "AKTIV", actualStart: plusDaysIso(todayIso(), -90) }).where(eq(schema.engagements.id, q.engagement.id));
    const far = await createOpportunity(david, { setupId: s.setupId, title: `E48 Weit weg ${u()}`, needDescription: "Endet erst in einem Jahr.", kind: "FREELANCER_EXPERTE" });
    const q2 = await quickFill(david, far.id, { title: "Tester", resourceKind: "FREELANCER", newName: `Fritz Fern ${u()} (fiktiv)`, ekRate: "600", vkRate: "960", desiredStart: plusDaysIso(todayIso(), -10), plannedEnd: plusDaysIso(todayIso(), 365) });
    await db.update(schema.engagements).set({ status: "AKTIV" }).where(eq(schema.engagements.id, q2.engagement.id));
    // offene Chance mit zwei Positionen à 1.000 €/Tag
    const pipe = await createOpportunity(david, { setupId: s.setupId, title: `E48 Pipeline ${u()}`, needDescription: "Zwei Scrum Master gesucht.", kind: "FREELANCER_EXPERTE" });
    const { createPosition } = await import("@/modules/staffing/service");
    await createPosition(david, pipe.id, { title: "Scrum Master", resourceKind: "FREELANCER", vkMin: "900", vkMax: "1100" });
    await createPosition(david, pipe.id, { title: "Scrum Master", resourceKind: "FREELANCER", vkMin: "900", vkMax: "1100" });
    // überfällige Aufgabe bei David
    await db.insert(schema.actions).values({ workspaceId: s.workspaceId, setupId: s.setupId, title: `E48 überfällig ${u()}`, ownerUserId: david.userId, status: "ANGENOMMEN", dueDate: plusDaysIso(todayIso(), -3), createdBy: david.userId });

    await expect(buildGfOverview(david)).rejects.toBeInstanceOf(ForbiddenError);
    const o = await buildGfOverview(ceo);
    expect(o.windowDays).toBe(56);
    const ex = o.expiring.find((e) => e.engagementId === q.engagement.id)!;
    expect(ex.person).toBe(name);
    expect(ex.renewal).toBeTruthy();
    expect(o.expiring.some((e) => e.engagementId === q2.engagement.id)).toBe(false);
    const p = o.pipeline.find((x) => x.opportunityId === pipe.id)!;
    expect(p.heads).toBe(2);
    expect(p.vkPerDay).toBe(2000);
    expect(o.kpis.pipelinePerDay).toBeGreaterThanOrEqual(2000);
    const t = o.team.find((x) => x.userId === david.userId)!;
    expect(t.overdue).toBeGreaterThanOrEqual(1);
    expect(o.kpis.teamOverdue).toBeGreaterThanOrEqual(1);
  });

  it("K01: Karten kuratieren – Besetzungen wandern als Positionen in die Chance, Nebenkarten fallen weg, höchstens 3 Hauptkarten und 2 Personen", async () => {
    const cards = [
      card({ type: "CHANCE", title: "Zwei Scrum Master", needDescription: "Wir brauchen ab Januar zwei Scrum Master.", kind: "FREELANCER_EXPERTE", roleName: "Scrum Master", headcount: 2, anticipated: false }),
      card({ type: "BESETZUNG", title: "Scrum Master", location: "Hamburg (50 % remote)" }),
      card({ type: "BESETZUNG", title: "Scrum Master", location: "Hamburg (50 % remote)" }),
      card({ type: "SIGNAL", observation: "Das Lagerprojekt wächst." }),
      card({ type: "FRAGE", question: "Wie hoch ist das Budget?" }),
      card({ type: "AKTION", title: "Profile schicken", dueHint: "Ende des Monats" }),
      card({ type: "AKTION", title: "Rahmenvertrag prüfen" }),
      card({ type: "VORGANG", title: "Sales Ops: Ausschreibung aufbereiten" }),
      card({ type: "PERSON", displayName: "Petra Wind", functionTitle: "Leiterin Projektmanagement", email: "petra.wind@nordwind.example" }),
      card({ type: "PERSON", displayName: "Herzlichen Dank", functionTitle: "Grußformel" }),
      card({ type: "PERSON", displayName: "Olaf Ohne" }),
      card({ type: "PERSON", displayName: "Eva Einkauf", decisionRole: "EINKAUF_VERTRAGSWEG", email: "eva.einkauf@nordwind.example" }),
    ];
    const out = await curateCards("-", null, cards);
    const types = out.map((c) => c.item.type);
    expect(types.filter((t) => t !== "PERSON")).toEqual(["CHANCE", "AKTION", "AKTION"]);
    const ch = out[0]!.item as Extract<IntakeItem, { type: "CHANCE" }>;
    expect(ch.positions).toHaveLength(2);
    expect(ch.positions[0]!.location).toMatch(/Hamburg/);
    const persons = out.filter((c) => c.item.type === "PERSON").map((c) => (c.item as Extract<IntakeItem, { type: "PERSON" }>).displayName);
    expect(persons).toEqual(["Eva Einkauf", "Petra Wind"]);
    // ohne Chance: gleiche Besetzungen → eine Karte mit Anzahl
    const only = await curateCards("-", null, [card({ type: "BESETZUNG", title: "Tester" }), card({ type: "BESETZUNG", title: "Tester" }), card({ type: "BESETZUNG", title: "Tester" })]);
    expect(only).toHaveLength(1);
    expect(only[0]!.resolved.count).toBe(3);
  });

  it("K02: Kunde erkannt, Setup nicht eindeutig → kein geratenes Setup; eine Rückfrage ordnet alle Karten der Mail zu; Chance-Karte legt je Platz eine Position an", async () => {
    env();
    await ensureSeed();
    const david = await actorFor("david");
    const acc = await createAccount(david, { name: `Zweisetup ${u()} AG (fiktiv)`, orgType: "KONZERN", responsibleBdUserId: david.userId });
    const d2 = (await loadActor(david.userId))!;
    const s1 = await createSetup(d2, { accountId: acc.id, name: "Plattform", bdUserId: david.userId, creatorContribution: "BD_ZUSTAENDIG" });
    await createSetup(d2, { accountId: acc.id, name: "Vertrieb Digital", bdUserId: david.userId, creatorContribution: "BD_ZUSTAENDIG" });
    const d3 = (await loadActor(david.userId))!;
    const text = `${acc.name}\n\nHallo Herr Demo,\nwir brauchen ab Januar zwei Scrum Master für unser Lagerprojekt. Nächster Schritt: Profile bis Ende des Monats schicken.\n\nViele Grüße\nPetra Wind`;
    const route = await routeText(d3, text);
    expect(route.account?.id).toBe(acc.id);
    expect(route.ctx).toBeNull();
    expect(route.setupUnsure).toBe(true);
    const r = await eingangFromText(d3, { text, setupId: "AUTO" });
    const cards = (await db.query.suggestions.findMany({ where: eq(schema.suggestions.type, "KARTE") })).filter((c) => c.sourceIds.includes(r.sourceId));
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.length).toBeLessThanOrEqual(5);
    expect(cards.every((c) => c.setupId === null && c.accountId === acc.id)).toBe(true);
    const moved = await assignIntakeSetup(d3, cards[0]!.id, s1.id);
    expect(moved.moved).toBe(cards.length);
    const after = await db.query.suggestions.findMany({ where: eq(schema.suggestions.accountId, acc.id) });
    expect(after.every((c) => c.setupId === s1.id)).toBe(true);
    // Chance-Karte mit zwei Plätzen → zwei Positionen
    const chance = after.find((c) => (c.payload as { item: IntakeItem }).item.type === "CHANCE");
    if (chance) {
      const res = await acceptSuggestion(d3, chance.id, { version: chance.version });
      expect(res.message).toMatch(/2 Positionen/);
      const pos = await db.query.staffingPositions.findMany({ where: eq(schema.staffingPositions.opportunityId, res.acceptedObjectId) });
      expect(pos).toHaveLength(2);
    }
  });

  it("K03: Was ein Anker einspielt, geht an den BD des Setups – mit Benachrichtigung", async () => {
    env();
    const s = await ensureSeed();
    const nina = await actorFor("nina");
    const david = await actorFor("david");
    const r = await eingangFromText(nina, { text: `Beim Kunden gehört (${u()}):\n\nHallo,\nwir brauchen ab Januar zwei Scrum Master für unser Lagerprojekt. Nächster Schritt: Profile bis Ende des Monats schicken.\n\nViele Grüße\nAnne Keller`, setupId: s.setupId });
    const cards = (await db.query.suggestions.findMany({ where: eq(schema.suggestions.type, "KARTE") })).filter((c) => c.sourceIds.includes(r.sourceId));
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.every((c) => c.proposedOwnerUserId === david.userId)).toBe(true);
    const note = await db.query.notifications.findFirst({ where: and(eq(schema.notifications.userId, david.userId), eq(schema.notifications.link, "/start#vorschlaege")), orderBy: (n, { desc }) => desc(n.createdAt) });
    expect(note?.title).toMatch(/Nina/);
  });

  it("D01: Hochgeladene Unterlage landet in SharePoint; erzeugter Entwurf wird nur mit hochgeladener Fassung „unterschrieben“, der Entwurf steht dann auf „ersetzt“", async () => {
    env();
    resetFixture();
    const s = await ensureSeed();
    const david = await actorFor("david");
    await setupSite(await actorFor("clemens"), { client: new FixtureSpClient() });
    const name = `Uwe Upload ${u()} (fiktiv)`;
    const opp = await createOpportunity(david, { setupId: s.setupId, title: `E48 Upload ${u()}`, needDescription: "Unterlagen.", kind: "FREELANCER_EXPERTE" });
    const q = await quickFill(david, opp.id, { title: "Tester", resourceKind: "FREELANCER", newName: name, ekRate: "600", vkRate: "960", desiredStart: plusDaysIso(todayIso(), 7), plannedEnd: plusDaysIso(todayIso(), 120) });
    const file = (n: string) => { const b = new TextEncoder().encode(`Testinhalt ${n}`); return { name: n, type: "text/plain", size: b.length, arrayBuffer: async () => b.buffer.slice(0) as ArrayBuffer }; };
    const best = await addContractDocument(david, q.engagement.id, { side: "KUNDE", docType: "BESTELLUNG", title: "Bestellung 4500123456", reference: "4500123456", signedStatus: "UNTERSCHRIEBEN" }, file("Bestellung.txt"));
    expect(best.sharepointError).toBeNull();
    const bdoc = (await db.query.contractDocuments.findFirst({ where: eq(schema.contractDocuments.id, best.document.id) }))!;
    expect(fixtureState().items.get(bdoc.spItemId!)!.path).toMatch(/Bestellungen/);
    expect(fixtureState().items.get(bdoc.spItemId!)!.fields).toMatchObject({ Dokumentart: "Bestellung", Bestellnummer: "4500123456" });
    // erzeugter Entwurf (Kennzeichen wie aus der Vorlage)
    const draft = await addContractDocument(david, q.engagement.id, { side: "FREELANCER", docType: "EINZELBEAUFTRAGUNG", title: "Projekteinzelvertrag", signedStatus: "ENTWURF", reviewNote: "Erzeugt aus der Vorlage v1 (Einzelperson)." }, file("Vertrag.txt"));
    const d0 = (await db.query.contractDocuments.findFirst({ where: eq(schema.contractDocuments.id, draft.document.id) }))!;
    expect(fixtureState().items.get(d0.spItemId!)!.path).toMatch(/Verträge/);
    await expect(setContractDocumentStatus(david, q.engagement.id, d0.id, { version: d0.version, signedStatus: "UNTERSCHRIEBEN" })).rejects.toThrow(/unterschriebene Fassung/);
    await uploadSignedVersion(david, q.engagement.id, d0.id, file("Vertrag_signiert.txt"));
    const d1 = (await db.query.contractDocuments.findFirst({ where: eq(schema.contractDocuments.id, d0.id) }))!;
    expect(d1.signedStatus).toBe("UNTERSCHRIEBEN");
    expect(d1.spItemId).not.toBe(d0.spItemId);
    expect(fixtureState().items.get(d1.spItemId!)!.path).toMatch(/unterschrieben/);
    expect(fixtureState().items.get(d0.spItemId!)!.fields.DokStatus).toBe("ersetzt");
  });

  it("D02: Quittung schreibt Einsatzblätter (Kunde ohne EK, Freelancer mit EK) und führt Moco-Projekt nach; neue Konditionen und Einsatzende lösen Übergabe bzw. „gültig bis“ aus", async () => {
    env();
    resetFixture();
    const s = await ensureSeed();
    const david = await actorFor("david");
    await setupSite(await actorFor("clemens"), { client: new FixtureSpClient() });
    await db.update(schema.accounts).set({ billingAddress: "Beispielkonzern AG\nKreditoren\nMusterweg 1\n12345 Beispielstadt", invoiceRoute: "PDF an kreditoren@beispiel.example" }).where(eq(schema.accounts.id, s.accountId));
    const name = `Bea Blatt ${u()} (fiktiv)`;
    const opp = await createOpportunity(david, { setupId: s.setupId, title: `E48 Blatt ${u()}`, needDescription: "Einsatzblatt.", kind: "FREELANCER_EXPERTE" });
    const q = await quickFill(david, opp.id, { title: "Tester", resourceKind: "FREELANCER", newName: name, ekRate: "600", vkRate: "960", desiredStart: plusDaysIso(todayIso(), -7), plannedEnd: plusDaysIso(todayIso(), 120) });
    const tb = new TextEncoder().encode("Bestellung 4500999111");
    const file = { name: "Bestellung.txt", type: "text/plain", size: tb.length, arrayBuffer: async () => tb.buffer.slice(0) as ArrayBuffer };
    const doc = await addContractDocument(david, q.engagement.id, { side: "KUNDE", docType: "BESTELLUNG", title: "Bestellung", reference: "4500999111", signedStatus: "UNTERSCHRIEBEN" }, file);
    await db.update(schema.engagements).set({ orderReference: "4500999111" }).where(eq(schema.engagements.id, q.engagement.id));
    const h = await createHandover(david, q.engagement.id, "BEAUFTRAGT");
    const ack = await acknowledgeHandover(await actorFor("clemens"), h.id, { mocoProjectId: "987654" });
    expect(ack.sharepointError).toBeNull();
    expect(ack.einsatzblatt?.kunde).toBeTruthy();
    expect(ack.einsatzblatt?.freelancer).toBeTruthy();
    const items = [...fixtureState().items.values()];
    const url = (i: { path: string }) => `https://fixture.sharepoint.local/${encodeURI(i.path)}`;
    const kBlatt = items.find((i) => url(i) === ack.einsatzblatt!.kunde)!;
    const fBlatt = items.find((i) => url(i) === ack.einsatzblatt!.freelancer)!;
    expect(kBlatt.path).toMatch(/Bestellungen/);
    expect(kBlatt.fields).toMatchObject({ Dokumentart: "Einsatzblatt", Bestellnummer: "4500999111", MocoProjekt: "987654" });
    expect(String(kBlatt.fields.Satz)).toMatch(/960/);
    expect(fBlatt.path).toMatch(/Verträge/);
    expect(String(fBlatt.fields.Satz)).toMatch(/600/);
    const d = (await db.query.contractDocuments.findFirst({ where: eq(schema.contractDocuments.id, doc.document.id) }))!;
    expect(fixtureState().items.get(d.spItemId!)!.fields.MocoProjekt).toBe("987654");
    // neue bestätigte Konditionen → Übergabe „Konditionen geändert“
    const p0 = await addPeriod(david, q.engagement.id, { kind: "BESTAETIGT", validFrom: plusDaysIso(todayIso(), -7), validTo: plusDaysIso(todayIso(), 30), ek: "600", vk: "960", rateUnit: "TAG", correction: true });
    await addPeriod(david, q.engagement.id, { kind: "BESTAETIGT", validFrom: plusDaysIso(todayIso(), 31), vk: "1010", ek: "640", rateUnit: "TAG", supersedesId: p0.id });
    const kh = await db.query.backofficeHandovers.findFirst({ where: and(eq(schema.backofficeHandovers.engagementId, q.engagement.id), eq(schema.backofficeHandovers.kind, "KONDITIONEN")) });
    expect((kh?.payload as { hinweis?: string })?.hinweis).toMatch(/1010.*Nachtrag/s);
    // Einsatzende → „gültig bis“ an den Unterlagen, Übergabe „beendet“
    await db.update(schema.engagements).set({ status: "AKTIV" }).where(eq(schema.engagements.id, q.engagement.id));
    const e = (await db.query.engagements.findFirst({ where: eq(schema.engagements.id, q.engagement.id) }))!;
    const end = plusDaysIso(todayIso(), 20);
    await changeEngagementStatus(david, e.id, { version: e.version, status: "ENDET", actualDate: end });
    expect(fixtureState().items.get(d.spItemId!)!.fields.GueltigBis).toBe(end);
    expect(await db.query.backofficeHandovers.findFirst({ where: and(eq(schema.backofficeHandovers.engagementId, e.id), eq(schema.backofficeHandovers.kind, "BEENDET")) })).toBeTruthy();
  });

  it("D03: Bestell-Mail mit Anhang → Kunden › Bestellungen mit Bestellnummer, Hinweis an Sales Operations", async () => {
    env();
    process.env.MAIL_INBOX_MODE = "fixture";
    process.env.MAIL_INBOX = "sales@verve.example";
    resetConfigCacheForTests();
    resetFixture();
    await ensureSeed();
    await setupSite(await actorFor("clemens"), { client: new FixtureSpClient() });
    expect(extractOrderNumber("Bestellung Nr. 4500123987 – Testmanagement")).toBe("4500123987");
    expect(extractOrderNumber("PO-Nr: AB-2026-0042")).toBe("AB-2026-0042");
    expect(extractOrderNumber("Danke für das Gespräch")).toBeNull();
    expect(looksLikeOrder("WG: Bestellung 4500123987", "", "PO.pdf")).toBe(true);
    expect(looksLikeOrder("Termin am Freitag", "Bis dann", "Agenda.pdf")).toBe(false);
    const body = `Bitte ablegen.\n\nVon: Anne Keller <anne.keller@beispielkonzern.example>\nBetreff: Bestellung 4500123987\n\nSehr geehrter Herr Demo, anbei unsere Bestellung 4500123987 für die Testautomatisierung beim Beispielkonzern. Viele Grüße, Anne Keller`;
    const meta: InboxMeta = { id: `b-${u()}`, messageId: `<best-${u()}@x>`, subject: "WG: Bestellung 4500123987", fromEmail: DEMO_USERS.david.email, fromName: "David Demo", receivedAt: new Date().toISOString(), internal: true };
    const inbox: InboxClient = { list: async () => [meta], body: async () => body, attachments: async () => [{ name: "Bestellung_4500123987.pdf", contentType: "application/pdf", bytes: new Uint8Array([1, 2, 3]).buffer as ArrayBuffer }] };
    const r = await runMailInbox({ client: inbox });
    expect(r.ausgewertet).toBe(1);
    const item = [...fixtureState().items.values()].find((i) => i.path.endsWith("Bestellung_4500123987.pdf"));
    expect(item?.path).toMatch(/Bestellungen/);
    expect(item?.fields).toMatchObject({ Dokumentart: "Bestellung", Bestellnummer: "4500123987" });
  });

  it("D04: Bestellnummer nachtragen – am Einsatz und an der Verlängerung, Übergabe „Bestellung nachgereicht“", async () => {
    env();
    const s = await ensureSeed();
    const david = await actorFor("david");
    const opp = await createOpportunity(david, { setupId: s.setupId, title: `E48c Nachtrag ${u()}`, needDescription: "Bestellung kommt später.", kind: "FREELANCER_EXPERTE" });
    const q = await quickFill(david, opp.id, { title: "Tester", resourceKind: "FREELANCER", newName: `Nora Nach ${u()} (fiktiv)`, ekRate: "600", vkRate: "960", desiredStart: plusDaysIso(todayIso(), -30), plannedEnd: plusDaysIso(todayIso(), 40) });
    const { setOrderReference } = await import("@/modules/engagements/service");
    expect((await setOrderReference(david, q.engagement.id, "4500111222")).changed).toBe(true);
    expect((await db.query.engagements.findFirst({ where: eq(schema.engagements.id, q.engagement.id) }))!.orderReference).toBe("4500111222");
    const h = await db.query.backofficeHandovers.findFirst({ where: and(eq(schema.backofficeHandovers.engagementId, q.engagement.id), eq(schema.backofficeHandovers.kind, "BESTELLUNG_NACHGEREICHT")) });
    expect((h?.payload as { bestellnummer?: string }).bestellnummer).toBe("4500111222");
    expect((await setOrderReference(david, q.engagement.id, "4500111222")).changed).toBe(false);
    await expect(setOrderReference(await actorFor("lars"), q.engagement.id, "x123")).rejects.toThrow();
  });

  it("D05: Verlängerung mit Angebot aus SharePoint – Unterlage „Angebot“, Nummer aus dem Dateinamen, Übergabe nennt das Angebot", async () => {
    env();
    resetFixture();
    const s = await ensureSeed();
    const david = await actorFor("david");
    await setupSite(await actorFor("clemens"), { client: new FixtureSpClient() });
    const acc = (await db.query.accounts.findFirst({ where: eq(schema.accounts.id, s.accountId) }))!;
    const name = `Hugo Hueper ${u()} (fiktiv)`;
    const opp = await createOpportunity(david, { setupId: s.setupId, title: `E48e Verlängerung ${u()}`, needDescription: "Verlängerung mit Angebot.", kind: "FREELANCER_EXPERTE" });
    const q = await quickFill(david, opp.id, { title: "Tester", resourceKind: "FREELANCER", newName: name, ekRate: "80", vkRate: "100", desiredStart: plusDaysIso(todayIso(), -60), plannedEnd: plusDaysIso(todayIso(), 40) });
    await db.update(schema.engagements).set({ status: "AKTIV" }).where(eq(schema.engagements.id, q.engagement.id));
    const client = new FixtureSpClient() as unknown as import("@/modules/sharepoint/client").SpClient;
    const libs = await client.libraries();
    const kunden = await client.driveOf(libs.find((l) => l.name === "Kunden")!.id);
    const { folderName, filesFor } = await import("@/modules/sharepoint/service");
    await client.upload(kunden, [folderName(acc.name), "Angebote", "2026"], "2026-11-12_Angebot_Beispiel_Hueper_VCA-M26-11_0003.xlsx", new ArrayBuffer(2));
    const files = await filesFor({ accountName: acc.name, kinds: ["KUNDE_ANGEBOT"] });
    const pick = files!.groups[0]!.files.find((f) => f.name.includes("Hueper"))!.value;
    const { startRenewal, decideRenewal } = await import("@/modules/engagements/care");
    const newEnd = plusDaysIso(todayIso(), 220);
    await startRenewal(david, q.engagement.id, { newEnd, conditions: "UNVERAENDERT", offerPick: pick }, { direct: true });
    await decideRenewal(david, q.engagement.id, { decision: "BESTAETIGEN" });
    const ren = (await db.query.renewalDecisions.findFirst({ where: eq(schema.renewalDecisions.engagementId, q.engagement.id), orderBy: (r, { desc }) => desc(r.createdAt) }))!;
    expect(ren.offerNumber).toBe("VCA-M26-11_0003");
    expect(ren.offerLink).toMatch(/Angebote/);
    const links = await db.query.engagementDocuments.findMany({ where: eq(schema.engagementDocuments.engagementId, q.engagement.id) });
    const docs = await db.query.contractDocuments.findMany({ where: eq(schema.contractDocuments.accountId, s.accountId) });
    const offer = docs.find((d) => links.some((l) => l.documentId === d.id) && d.docType === "ANGEBOT")!;
    expect(offer.reference).toBe("VCA-M26-11_0003");
    const h = await db.query.backofficeHandovers.findFirst({ where: and(eq(schema.backofficeHandovers.engagementId, q.engagement.id), eq(schema.backofficeHandovers.kind, "VERLAENGERT")) });
    expect((h?.payload as { angebotsnummer?: string }).angebotsnummer).toBe("VCA-M26-11_0003");
  });
});
