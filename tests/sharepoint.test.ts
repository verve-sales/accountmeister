import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { resetConfigCacheForTests } from "@/lib/config";
import { ForbiddenError } from "@/lib/errors";
import { createOpportunity } from "@/modules/opportunities/service";
import { quickFill } from "@/modules/staffing/service";
import { setContractDocumentStatus } from "@/modules/engagements/service";
import { contractDefaults, generateFreelancerContract } from "@/modules/conversion/contractService";
import { saveFreelancerProfile } from "@/modules/conversion/profile";
import { FixtureSpClient, fixtureState, resetFixture, type SpClient } from "@/modules/sharepoint/client";
import { COLUMNS, filesFor, folderName, freelancerFolder, permissionPlan, setupSite, siteStatus, yearFolder, yearOf } from "@/modules/sharepoint/service";
import { plusDaysIso, todayIso } from "@/modules/work/calendar";
import { actorFor, ensureSeed } from "./helpers";

function env(mode: "off" | "fixture" = "fixture") {
  process.env.FEATURE_BESETZUNG = "true";
  process.env.SHAREPOINT_MODE = mode;
  resetConfigCacheForTests();
}

async function runningFreelancer(label: string, name: string) {
  const s = await ensureSeed();
  const david = await actorFor("david");
  const opp = await createOpportunity(david, { setupId: s.setupId, title: `${label} ${Date.now().toString(36)}`, needDescription: "Testbedarf für die SharePoint-Ablage.", kind: "FREELANCER_EXPERTE" });
  const q = await quickFill(david, opp.id, { title: "Scrum Master", resourceKind: "FREELANCER", newName: name, ekRate: "600", vkRate: "960", desiredStart: plusDaysIso(todayIso(), 14), plannedEnd: plusDaysIso(todayIso(), 200), tasks: "Coaching agiler Teams" });
  return { s, david, opp, q };
}

describe("e45: SharePoint-Ablage", () => {
  it("S01: Ordnernamen nach SharePoint-Regeln; Freelancer als „Nachname, Vorname“", () => {
    expect(folderName("HSBC Trinkaus Real Estate GmbH | HSBC Asset Management Germany")).toBe("HSBC Trinkaus Real Estate GmbH - HSBC Asset Management Germany");
    expect(folderName("Mitteldeutsche Flughafen AG (MFAG)")).toBe("Mitteldeutsche Flughafen AG (MFAG)");
    expect(folderName("Firma: A/B*C. ")).toBe("Firma- A-B-C");
    expect(freelancerFolder("Max Muster")).toBe("Muster, Max");
    expect(freelancerFolder("Anna Maria Beispiel")).toBe("Beispiel, Anna Maria");
    expect(freelancerFolder("Selma Sprint (fiktiv)")).toBe("Sprint, Selma (fiktiv)");
    expect(freelancerFolder("Muster, Max")).toBe("Muster, Max");
  });

  it("S02: Einrichten legt Bibliotheken, Spalten und Ordner an, beim zweiten Lauf nichts mehr; nur Geschäftsführung/Verwaltung", async () => {
    env();
    resetFixture();
    const fname = `Fiona Fixture ${Date.now().toString(36)} (fiktiv)`;
    const { david } = await runningFreelancer("SharePoint S02", fname);
    await expect(setupSite(david)).rejects.toBeInstanceOf(ForbiddenError);
    const ceo = await actorFor("clemens");
    const before = await siteStatus(ceo);
    expect(before.ok).toBe(true);
    expect(before.libraries.every((l) => !l.present)).toBe(true);
    const r1 = await setupSite(ceo, { client: new FixtureSpClient() });
    expect(r1.errors).toEqual([]);
    expect(r1.steps.find((s) => s.what === "Bibliotheken")).toMatchObject({ created: 3, existing: 0 });
    expect(r1.steps.find((s) => s.what === "Spalten")).toMatchObject({ created: COLUMNS.length * 2, existing: 0 });
    expect(r1.steps.find((s) => s.what === "Ordner")!.created).toBeGreaterThan(0);
    expect(r1.folders).toEqual(expect.arrayContaining(["Kunden/Beispielkonzern AG (fiktiv)", "Vorlagen/Vertrag", "Vorlagen/Angebot Kunde"]));
    expect(r1.folders).toContain(`Freelancer/${freelancerFolder(fname)}`);
    const paths = [...fixtureState().items.values()].map((i) => i.path);
    expect(paths.some((p) => p.endsWith("/Beispielkonzern AG (fiktiv)/Bestellungen"))).toBe(true);
    const r2 = await setupSite(ceo);
    expect(r2.steps.map((s) => s.created)).toEqual([0, 0, 0, 0]);
    const after = await siteStatus(ceo);
    expect(after.libraries.every((l) => l.present && l.columnsMissing.length === 0)).toBe(true);
    // Fehler der Site → Stand mit Meldung statt Absturz
    fixtureState().fail = "SharePoint: HTTP 403 – Access denied";
    const broken = await siteStatus(ceo);
    expect(broken.ok).toBe(false);
    expect(broken.error).toMatch(/403/);
    fixtureState().fail = null;
  });

  it("S03: Erzeugter Vertrag landet unter Freelancer › Person › Verträge mit Spalten; Statuswechsel wird nachgeführt; Fehler hält die Erzeugung nicht auf", async () => {
    env();
    resetFixture();
    const name = `Paul Ablage ${Date.now().toString(36)}`;
    const { david, q } = await runningFreelancer("SharePoint S03", name);
    const ceo = await actorFor("clemens");
    await setupSite(ceo);
    const f = (await db.query.freelancers.findFirst({ where: eq(schema.freelancers.id, q.engagement.freelancerId!) }))!;
    await saveFreelancerProfile(ceo, f.id, { version: f.version, legalForm: "PERSON", street: "Musterweg 3", postalCity: "12345 Beispielstadt", taxNumber: "000/222/33333" });
    const d0 = await contractDefaults(david, q.engagement.id);
    const input = { rolle: d0.rolle, leistungsbereich: d0.leistungsbereich, aufgaben: d0.aufgaben, endkunde: d0.endkunde, endkundeOrt: "Düsseldorf", beginn: d0.beginn, ende: d0.ende, kontingentTage: "110", stundenJeProjekttag: "8", bedingungFrist: d0.bedingungFrist, einsatzort: "Düsseldorf", stundensatz: d0.stundensatz, zahlungszielTage: "30", kuendigungsfristTage: "14", ort: "Düsseldorf", datum: todayIso() };
    const gen = await generateFreelancerContract(david, q.engagement.id, input);
    expect(gen.sharepointError).toBeNull();
    expect(gen.sharepoint?.webUrl).toMatch(/fixture\.sharepoint\.local/);
    const doc = (await db.query.contractDocuments.findFirst({ where: eq(schema.contractDocuments.id, gen.document.id) }))!;
    expect(doc.link).toBe(gen.sharepoint!.webUrl);
    const item = fixtureState().items.get(doc.spItemId!)!;
    expect(item.path).toContain(`/${freelancerFolder(name)}/Verträge/`);
    expect(item.fields).toMatchObject({ Dokumentart: "Projekteinzelvertrag", Person: name, DokStatus: "Entwurf", GueltigVon: input.beginn, GueltigBis: input.ende });
    await setContractDocumentStatus(david, q.engagement.id, doc.id, { version: doc.version, signedStatus: "VERSENDET" });
    expect(fixtureState().items.get(doc.spItemId!)!.fields.DokStatus).toBe("versendet");
    // SharePoint gestört → Vertrag trotzdem erzeugt, Fehler gemeldet
    fixtureState().fail = "SharePoint: HTTP 503";
    const gen2 = await generateFreelancerContract(david, q.engagement.id, input);
    expect(gen2.document.id).toBeTruthy();
    expect(gen2.sharepoint).toBeNull();
    expect(gen2.sharepointError).toMatch(/503/);
    fixtureState().fail = null;
    // ohne SharePoint: keine Ablage, kein Fehler
    env("off");
    const gen3 = await generateFreelancerContract(david, q.engagement.id, input);
    expect(gen3.sharepoint).toBeNull();
    expect(gen3.sharepointError).toBeNull();
  });

  it("S04: Rechteplan aus den Rollen im Accountmeister", async () => {
    env();
    await ensureSeed();
    const plan = await permissionPlan(await actorFor("clemens"));
    expect(plan.map((p) => p.rolle)).toEqual(["Geschäftsführung", "Sales Operations", "Backoffice", "Buchhaltung", "Vertrieb (BD, Principals)"]);
    expect(plan[0]!.personen.some((p) => /Clemens/.test(p.name))).toBe(true);
    expect(plan[4]!.personen.some((p) => /David/.test(p.name))).toBe(true);
    expect(plan[4]!.freelancer).toBe("–");
    expect(plan[3]!.personen).toEqual([]);
    await expect(permissionPlan(await actorFor("david"))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("S05: Jahresordner – Ablage nach dem Datum im Dateinamen, lose Dateien werden beim Einrichten einsortiert, Auswahl zeigt aktuelles und Vorjahr", async () => {
    env();
    resetFixture();
    await ensureSeed();
    const ceo = await actorFor("clemens");
    const y = todayIso().slice(0, 4);
    const prev = String(Number(y) - 1);
    expect(yearOf("2026-11-12_Angebot_ITERGO_Teglas.xlsx")).toBe("2026");
    expect(yearOf("Angebot.xlsx", "2025-03-01T10:00:00Z")).toBe("2025");
    expect(yearFolder(["ITERGO", "Angebote"], "2027-01-05_x.pdf")).toEqual(["ITERGO", "Angebote", "2027"]);
    expect(yearFolder(["ITERGO", "Rahmen und Einkauf"], "2027-01-05_x.pdf")).toEqual(["ITERGO", "Rahmen und Einkauf"]);
    expect(yearFolder(["Muster, Max", "Verträge"], "v.docx")).toEqual(["Muster, Max", "Verträge", y]);
    const client: SpClient = new FixtureSpClient();
    await setupSite(ceo, { client });
    const libs = await client.libraries();
    const kunden = await client.driveOf(libs.find((l) => l.name === "Kunden")!.id);
    // lose Dateien wie von Hand abgelegt
    await client.upload(kunden, ["ITERGO-Test", "Angebote"], "2026-11-12_Angebot_ITERGO_Teglas_VCA-M26-11_0001.xlsx", new ArrayBuffer(2));
    await client.upload(kunden, ["ITERGO-Test", "Angebote"], `${prev}-12-01_Angebot_ITERGO_Alt.xlsx`, new ArrayBuffer(2));
    await client.upload(kunden, ["ITERGO-Test", "Rahmen und Einkauf"], "Rahmenvertrag.pdf", new ArrayBuffer(2));
    const r = await setupSite(ceo, { client });
    expect(r.steps.find((s) => s.what === "Einsortiert")!.created).toBe(2);
    const paths = [...fixtureState().items.values()].filter((i) => i.file).map((i) => i.path);
    expect(paths.some((p) => p.endsWith("/ITERGO-Test/Angebote/2026/2026-11-12_Angebot_ITERGO_Teglas_VCA-M26-11_0001.xlsx"))).toBe(true);
    expect(paths.some((p) => p.endsWith(`/ITERGO-Test/Angebote/${prev}/${prev}-12-01_Angebot_ITERGO_Alt.xlsx`))).toBe(true);
    expect(paths.some((p) => p.endsWith("/ITERGO-Test/Rahmen und Einkauf/Rahmenvertrag.pdf"))).toBe(true);
    const files = await filesFor({ accountName: "ITERGO-Test", kinds: ["KUNDE_ANGEBOT"] }, { client });
    expect(files!.groups[0]!.files.map((f) => f.name).some((n) => n.includes("Alt"))).toBe(true);
  });
});
