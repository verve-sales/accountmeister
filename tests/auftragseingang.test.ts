import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { ConflictError, ForbiddenError, ValidationError } from "@/lib/errors";
import { loadActor, type Actor } from "@/modules/identity/actor";
import { assignRole } from "@/modules/governance/service";
import { detectKind, detectPeriod, detectRate, parseDocument } from "@/modules/o2o/parse";
import { hourlyRate, openPoints, plan, type CaseFacts } from "@/modules/o2o/plan";
import { cancelCase, confirmCase, createOfferWithoutDocument, getCase, listCases, setEndCustomer, uploadForCase } from "@/modules/o2o/service";
import { actorFor, ensureSeed } from "./helpers";

/** e67: Auftragseingang – Angebot und Bestellung hochladen (Konzept Offer-to-Order v2). Alle Daten fiktiv. */

const file = (name: string, text: string) => {
  const buf = Buffer.from(text, "utf8");
  return { name, type: "text/plain", size: buf.length, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer };
};
const uniq = () => Date.now().toString(36) + Math.floor(Math.random() * 1000);

async function makeSalesOps(): Promise<Actor> {
  const s = await ensureSeed();
  const [u] = await db.insert(schema.users).values({ workspaceId: s.workspaceId, email: `ops-o2o-${uniq()}@verve.example`, displayName: "Olga Ops (Sales Operations, fiktiv)" }).returning();
  await assignRole(await actorFor("admin"), { userId: u!.id, role: "SALES_OPS" });
  return (await loadActor(u!.id))!;
}

const facts = (over: Partial<CaseFacts> = {}): CaseFacts => ({ channel: "VERMITTLER", status: "ANGEBOT_VERSENDET", partnerName: "Hays (fiktiv)", endCustomerName: null, personName: "Pia Probe (fiktiv)", role: "Testmanagerin", startDate: "2027-01-01", endDate: "2027-06-30", dailyRate: 985, days: 100, offerNumber: null, brokerRef: "HAY-4711", orderNumber: null, isRenewal: false, bdName: "David Demo (BD)", ...over });

describe("e67 Auftragseingang: Vorlesen", () => {
  it("erkennt Bestellung, Nummer, Zeitraum, Tagessatz, Tage und bekannte Person", () => {
    const t = "Bestellung Nr. 4500123987\nWir bestellen hiermit Beratungsleistungen.\nBerater: Pia Probe\nZeitraum: 01.01.2027 bis 30.06.2027\nTagessatz: 960,00 €\n100 PT\nTel. +49 221 4500998877";
    const p = parseDocument(t, "PO_4500123987.pdf", ["Pia Probe (fiktiv)"]);
    expect(p.kind?.value).toBe("BESTELLUNG");
    expect(p.orderNumber?.value).toBe("4500123987");
    expect(p.start?.value).toBe("2027-01-01");
    expect(p.end?.value).toBe("2027-06-30");
    expect(p.dailyRate?.value).toBe(960);
    expect(p.days?.value).toBe(100);
    expect(p.person?.value).toBe("Pia Probe (fiktiv)");
    expect(p.person?.evidence).toContain("Pia Probe");
  });
  it("ein Angebot, das „bei Bestellung“ erwähnt, bleibt ein Angebot; Moco-Nummer aus dem Dateinamen", () => {
    expect(detectKind("Unser Angebot für Sie. Gültig bis 31.12.2026. Bei Bestellung bitte Nummer angeben.", "Angebot_VCA-M26-11_0003.pdf")?.value).toBe("ANGEBOT");
    const p = parseDocument("Unser Angebot\nRolle: Scrum Master\n120 € / Stunde", "Angebot_VCA-M26-11_0003.pdf");
    expect(p.offerNumber?.value).toBe("VCA-M26-11_0003");
    expect(p.dailyRate?.value).toBe(960);
    expect(p.role?.value).toBe("Scrum Master");
    expect(p.orderNumber).toBeNull();
  });
  it("Zeitraum mit Gedankenstrich, Ende vor Start wird verworfen; unplausible Sätze werden ignoriert", () => {
    expect(detectPeriod("Laufzeit 1.2.2027 – 31.3.2027").end?.value).toBe("2027-03-31");
    expect(detectPeriod("Beginn: 01.05.2027 Ende: 01.04.2027").end).toBeNull();
    expect(detectRate("Tagessatz 5 €")).toBeNull();
  });
  it("Moco-Plan: Stundensatz = Tagessatz ÷ 8 auf Cent; ohne Endkunde wartet das Projekt", () => {
    expect(hourlyRate(985)).toBe(123.13);
    const steps = plan(facts({ status: "BEAUFTRAGT", orderNumber: "PO-1" }));
    expect(steps.find((s) => s.title === "Projekt anlegen")?.state).toBe("WARTET");
    expect(openPoints(facts({ status: "BEAUFTRAGT" }))).toEqual(expect.arrayContaining(["Endkunde fehlt", "Bestellnummer fehlt"]));
    const ok = plan(facts({ status: "BEAUFTRAGT", orderNumber: "PO-1", endCustomerName: "Nordwerk AG (fiktiv)" }));
    expect(ok.find((s) => s.title === "Projekt anlegen")?.detail).toContain("123,13 €");
    expect(ok.find((s) => s.title === "Lead umziehen")).toBeTruthy();
    expect(ok.find((s) => s.system === "SHAREPOINT")?.detail).toContain("Kunden › Nordwerk AG (fiktiv)");
  });
});

describe("e67 Auftragseingang: Ablauf", () => {
  it("direkt: Angebot hochladen → Chance „Angebot“, dann Bestellung mit Angebotsnummer → Einsatz, Auftrag, Unterlagen", async () => {
    const s = await ensureSeed();
    const ops = await makeSalesOps();
    const no = `VCA-M27-01_${String(Math.floor(Math.random() * 9000) + 1000)}`;
    const draft = await uploadForCase(ops, file(`Angebot_${no}.txt`, `Angebot für Beispielkonzern AG\nRolle: Testmanagerin\nBeraterin: Frau Probe\nZeitraum: 01.02.2027 bis 30.06.2027\nTagessatz: 950 €`));
    expect(draft.status).toBe("ENTWURF");
    expect(draft.offerNumber).toBe(no);
    const offer = await confirmCase(ops, draft.id, { kind: "ANGEBOT", channel: "DIREKT", partnerAccountId: s.accountId, personKind: "FREELANCER", personNewName: "Pia Probe (fiktiv)", role: "Testmanagerin", startDate: "2027-02-01", endDate: "2027-06-30", dailyRate: "950", offerNumber: no });
    expect(offer.status).toBe("ANGEBOT_VERSENDET");
    const opp = await db.query.opportunities.findFirst({ where: eq(schema.opportunities.id, offer.opportunityId!) });
    expect(opp!.status).toBe("PROFIL_ANGEBOT_VORGESTELLT");
    expect(opp!.accountId).toBe(s.accountId);
    const v = await getCase(ops, offer.id);
    expect(v.documents.map((d) => d.kind)).toEqual(["ANGEBOT"]);
    expect(v.open).toEqual([]);

    const po = `45${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
    const d2 = await uploadForCase(ops, file("Bestellung.txt", `Bestellung ${po}\nBezug: Angebot ${no}\nZeitraum: 01.02.2027 bis 30.06.2027\nTagessatz: 950 €`));
    expect(d2.orderNumber).toBe(po);
    expect((d2.parsed as { matchCaseId: string }).matchCaseId).toBe(offer.id);
    const done = await confirmCase(ops, d2.id, { kind: "BESTELLUNG", channel: "DIREKT", partnerAccountId: s.accountId, personKind: "FREELANCER", personNewName: "Pia Probe (fiktiv)", role: "Testmanagerin", startDate: "2027-02-01", endDate: "2027-06-30", dailyRate: "950", orderNumber: po, offerNumber: no, matchCaseId: offer.id });
    expect(done.id).toBe(offer.id);
    expect(done.status).toBe("BEAUFTRAGT");
    expect(await db.query.orderCases.findFirst({ where: eq(schema.orderCases.id, d2.id) })).toBeUndefined();
    const e = await db.query.engagements.findFirst({ where: eq(schema.engagements.id, done.engagementId!) });
    expect(e!.orderReference).toBe(po);
    expect(e!.status).toBe("GEPLANT");
    expect((await db.query.opportunities.findFirst({ where: eq(schema.opportunities.id, done.opportunityId!) }))!.status).toBe("BEAUFTRAGT");
    expect((await db.query.offers.findFirst({ where: eq(schema.offers.id, done.offerId!) }))!.status).toBe("AKZEPTIERT");
    const docs = await db.query.engagementDocuments.findMany({ where: eq(schema.engagementDocuments.engagementId, e!.id) });
    expect(docs.length).toBe(2);
    // EK kommt nicht aus dem Kundendokument
    const period = await db.query.engagementPeriods.findFirst({ where: eq(schema.engagementPeriods.engagementId, e!.id) });
    expect(period?.ek ?? null).toBeNull();
    // R7: dieselbe Bestellung desselben Kunden nur einmal
    const d3 = await uploadForCase(ops, file("Bestellung-kopie.txt", `Bestellung ${po}`));
    await expect(confirmCase(ops, d3.id, { kind: "BESTELLUNG", channel: "DIREKT", partnerAccountId: s.accountId, personNewName: "Pia Probe (fiktiv)", role: "Testmanagerin", orderNumber: po })).rejects.toBeInstanceOf(ConflictError);
  });

  it("Abweichung zum Angebot muss bestätigt werden (B7)", async () => {
    const s = await ensureSeed();
    const ops = await makeSalesOps();
    const offer = await createOfferWithoutDocument(ops, { channel: "DIREKT", partnerAccountId: s.accountId, personNewName: "Ben Beispiel (fiktiv)", role: "Business Analyst", dailyRate: "900", startDate: "2027-03-01", endDate: "2027-05-31", offerNumber: `T-${uniq()}` });
    const draft = await uploadForCase(ops, file("PO.txt", "Bestellung PO-77881\nTagessatz 990 €"), { forCaseId: offer.id });
    const raw = { kind: "BESTELLUNG", channel: "DIREKT", partnerAccountId: s.accountId, personNewName: "Ben Beispiel (fiktiv)", role: "Business Analyst", dailyRate: "990", startDate: "2027-03-01", endDate: "2027-05-31", orderNumber: `PO-${uniq()}`, matchCaseId: offer.id };
    await expect(confirmCase(ops, draft.id, raw)).rejects.toThrow(/weicht vom Angebot ab: Satz 900 € → 990 €/);
    const ok = await confirmCase(ops, draft.id, { ...raw, deviationsOk: "on" });
    expect(ok.status).toBe("BEAUFTRAGT");
    expect(ok.dailyRate).toBe("990.00");
  });

  it("Vermittler ohne Endkunde: Bestellung ohne Angebot (B5) läuft, Moco wartet; Endkunde nachtragen zieht alles um", async () => {
    const s = await ensureSeed();
    const ops = await makeSalesOps();
    const broker = `Hays ${uniq()} (fiktiv)`;
    const draft = await uploadForCase(ops, file("Abruf.txt", `Bestellung über ${broker}\nProjektnummer: HAY-${uniq()}\nZeitraum: 01.01.2027 bis 31.03.2027\nTagessatz: 880 €`));
    const raw = { kind: "BESTELLUNG", channel: "VERMITTLER", partnerNewName: broker, personNewName: "Carla Clever (fiktiv)", role: "Scrum Master", startDate: "2027-01-01", endDate: "2027-03-31", dailyRate: "880", orderNumber: `ORD-${uniq()}` };
    // neuer Vermittler ohne BD: Sales Operations muss einen BD wählen (übernimmt selbst keine Verantwortung)
    await expect(confirmCase(ops, draft.id, raw)).rejects.toThrow(/kein BD hinterlegt/);
    const c = await confirmCase(ops, draft.id, { ...raw, bdUserId: s.users.david });
    expect(c.status).toBe("BEAUFTRAGT");
    const partner = await db.query.accounts.findFirst({ where: eq(schema.accounts.id, c.partnerAccountId!) });
    expect(partner!.accountKind).toBe("VERMITTLER");
    const v = await getCase(ops, c.id);
    expect(v.open).toContain("Endkunde fehlt");
    expect(((c.systems as { moco: { steps: { title: string; state: string }[] } }).moco.steps.find((x) => x.title === "Projekt anlegen"))!.state).toBe("WARTET");
    const e0 = await db.query.engagements.findFirst({ where: eq(schema.engagements.id, c.engagementId!) });
    expect(e0!.accountId).toBe(partner!.id);
    const moved = await setEndCustomer(ops, c.id, { endCustomerAccountId: s.accountId });
    expect(moved.endCustomerAccountId).toBe(s.accountId);
    const e1 = await db.query.engagements.findFirst({ where: eq(schema.engagements.id, c.engagementId!) });
    expect(e1!.accountId).toBe(s.accountId);
    expect((await db.query.opportunities.findFirst({ where: eq(schema.opportunities.id, c.opportunityId!) }))!.accountId).toBe(s.accountId);
    const docs = await db.query.orderCaseDocuments.findMany({ where: eq(schema.orderCaseDocuments.caseId, c.id) });
    const cd = await db.query.contractDocuments.findFirst({ where: eq(schema.contractDocuments.id, docs[0]!.documentId) });
    expect(cd!.accountId).toBe(s.accountId);
    expect((await getCase(ops, c.id)).open).not.toContain("Endkunde fehlt");
    expect(((moved.systems as { moco: { steps: { title: string; state: string }[] } }).moco.steps.find((x) => x.title === "Projekt anlegen"))!.state).toBe("GEPLANT");
    await expect(setEndCustomer(ops, c.id, { endCustomerAccountId: partner!.id })).rejects.toBeInstanceOf(ValidationError);
  });

  it("Bestellung zur laufenden Person wird als Verlängerung übernommen", async () => {
    const s = await ensureSeed();
    const ops = await makeSalesOps();
    const first = await createOfferWithoutDocument(ops, { channel: "DIREKT", partnerAccountId: s.accountId, personNewName: `Dora Dauer ${uniq()} (fiktiv)`, role: "Entwicklerin", dailyRate: "800", startDate: "2026-10-01", endDate: "2026-12-31", offerNumber: `R-${uniq()}` });
    const d = await uploadForCase(ops, file("po.txt", "Bestellung"), { forCaseId: first.id });
    const ordered = await confirmCase(ops, d.id, { kind: "BESTELLUNG", channel: "DIREKT", partnerAccountId: s.accountId, personKind: "FREELANCER", personNewName: first.personName!, role: "Entwicklerin", dailyRate: "800", startDate: "2026-10-01", endDate: "2026-12-31", orderNumber: `A-${uniq()}`, matchCaseId: first.id });
    const ext = await uploadForCase(ops, file("verl.txt", "Bestellung Verlängerung bis 31.03.2027"));
    const nextPo = `V-${uniq()}`;
    const r = await confirmCase(ops, ext.id, { kind: "BESTELLUNG", channel: "DIREKT", partnerAccountId: s.accountId, role: "Entwicklerin", endDate: "2027-03-31", orderNumber: nextPo, renewalEngagementId: ordered.engagementId! });
    expect(r.isRenewal).toBe(true);
    const e = await db.query.engagements.findFirst({ where: eq(schema.engagements.id, ordered.engagementId!) });
    expect(e!.plannedEnd).toBe("2027-03-31");
    expect(e!.orderReference).toBe(nextPo);
  });

  it("Absage setzt Angebot abgelehnt und Chance zurückgestellt; Entwurf verwerfen löscht ihn", async () => {
    const s = await ensureSeed();
    const ops = await makeSalesOps();
    const c = await createOfferWithoutDocument(ops, { channel: "DIREKT", partnerAccountId: s.accountId, personNewName: "Emil Ende (fiktiv)", role: "Architekt", offerNumber: `X-${uniq()}` });
    const done = await cancelCase(ops, c.id, "Kunde hat intern besetzt");
    expect(done.status).toBe("ABGESAGT");
    expect((await db.query.opportunities.findFirst({ where: eq(schema.opportunities.id, c.opportunityId!) }))!.status).toBe("ZURUECKGESTELLT");
    expect((await db.query.offers.findFirst({ where: eq(schema.offers.id, c.offerId!) }))!.status).toBe("ABGELEHNT");
    const draft = await uploadForCase(ops, file("x.txt", "Angebot"));
    await cancelCase(ops, draft.id, "");
    expect(await db.query.orderCases.findFirst({ where: eq(schema.orderCases.id, draft.id) })).toBeUndefined();
  });

  it("Rechte: Kontaktpate darf nicht hochladen; BD sieht nur Vorgänge seiner Kunden; Plausibilität greift", async () => {
    const s = await ensureSeed();
    const nina = await actorFor("nina");
    await expect(uploadForCase(nina, file("a.txt", "Angebot"))).rejects.toBeInstanceOf(ForbiddenError);
    const lars = await actorFor("lars");
    const ops = await makeSalesOps();
    const c = await createOfferWithoutDocument(ops, { channel: "DIREKT", partnerAccountId: s.accountId, personNewName: "Fritz Fern (fiktiv)", role: "Tester", offerNumber: `L-${uniq()}` });
    expect((await listCases(lars, "alle")).some((x) => x.id === c.id)).toBe(false);
    const david = await actorFor("david");
    expect((await listCases(david, "alle")).some((x) => x.id === c.id)).toBe(true);
    const d = await uploadForCase(ops, file("b.txt", "Angebot"));
    await expect(confirmCase(ops, d.id, { kind: "ANGEBOT", channel: "DIREKT", partnerAccountId: s.accountId, role: "Tester", startDate: "2027-05-01", endDate: "2027-04-01" })).rejects.toThrow(/Ende liegt vor dem Start/);
    await expect(confirmCase(ops, d.id, { kind: "ANGEBOT", channel: "DIREKT", partnerAccountId: s.accountId, role: "Tester", startDate: "2027-01-01", endDate: "2030-01-01" })).rejects.toThrow(/24 Monate/);
  });
});

describe("e67 Auftragseingang: dieselbe Datei", () => {
  it("liest den eigenen Entwurf neu und weist eine schon bestätigte Datei ab (B8)", async () => {
    const s = await ensureSeed();
    const ops = await makeSalesOps();
    const text = `Angebot Nr. DUP-${uniq()}\nRolle: Tester`;
    const a0 = await uploadForCase(ops, file("dup.txt", text));
    const a = await uploadForCase(ops, file("dup.txt", text));
    expect(a.id).not.toBe(a0.id);
    expect(await db.query.orderCases.findFirst({ where: eq(schema.orderCases.id, a0.id) })).toBeUndefined();
    await confirmCase(ops, a.id, { kind: "ANGEBOT", channel: "DIREKT", partnerAccountId: s.accountId, role: "Tester", personNewName: "Gina Gleich (fiktiv)" });
    await expect(uploadForCase(ops, file("dup.txt", text))).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("e68 Auftragseingang: Projekteinzelvertrag über Vermittler", () => {
  const vertrag = (person: string) => `12.10.2026
Rev. 26/606/0
60M2099000001X00002-01 Seite 1 von 6
PROJEKTEINZELVERTRAG
NR. 60M2099000001
Zwischen der Vermittla AG (fiktiv)
Musterallee 1
68000 Musterstadt
Deutschland
– nachfolgend „Vermittla“ genannt –
und Verve Consulting GmbH
Kaiserswerther Str. 40
40477 Düsseldorf
– nachfolgend „Auftragnehmer" genannt –
Zu Ziffer 2.1.
Der Auftrag umfasst vom Auftragnehmer zu erbringende Leistungen im Bereich:
Berater Projekt Umfeldanalyse
Die Ausführung des Auftrages beginnt am 01.01.2027 und endet voraussichtlich am 31.03.2027.
Zu Ziffer 2.2.
Der Leistungsumfang beträgt für das Projekt maximal 480 Stunden.
Die Leistungserbringung erfolgt remote (nachfolgend: „Projektort“) für Beispielkonzern AG (fiktiv) (nachfolgend: „Kunde“).
Zu Ziffer 3.5.
Für die Durchführung des in Ziffer 2.1. genannten Auftrages setzt der Auftragnehmer ${person}
ein (nachfolgend: „eingesetzte Person“).
Zu Ziffer 4.1.
Der Verrechnungssatz beträgt:
87,50 EUR pro tatsächlich geleisteter Projektstunde zuzüglich der gesetzlichen Umsatzsteuer.
Die Forderungen sind 45 Tage netto nach Eingang fällig.
Bei Vor-Ort-Einsätzen wird eine Reisekosten- und Mehraufwandsentschädigung von 200 EUR netto pro Reisetag gezahlt.
Unterschrift Zeitstempel David Demo (BD) Geschäftsführer`;

  it("Regeln lesen Vertragspartei, Endkunde, Nummer, Laufzeit, Stundensatz, Umfang und Person – ohne Reisepauschale, Zahlungsziel und Unterzeichner", () => {
    const p = parseDocument(vertrag("Mia Muster"), "Vermittla_-_Projektvertrag.pdf", { knownPersons: ["David Demo (BD)"], ownNames: ["Verve Consulting", "Verve"] });
    expect(p.kind?.value).toBe("BESTELLUNG");
    expect(p.orderNumber?.value).toBe("60M2099000001");
    expect(p.sender?.value).toBe("Vermittla AG (fiktiv)");
    expect(p.endCustomer?.value).toBe("Beispielkonzern AG (fiktiv)");
    expect(p.start?.value).toBe("2027-01-01");
    expect(p.end?.value).toBe("2027-03-31");
    expect(p.dailyRate?.value).toBe(700);
    expect(p.days?.value).toBe(60);
    expect(p.person?.value).toBe("Mia Muster");
    expect(p.role?.value).toBe("Berater Projekt Umfeldanalyse");
  });

  it("Upload: Vermittler wird Vertragspartner (neu), bekannter Endkunde wird erkannt, alle Felder vorbelegt", async () => {
    const s = await ensureSeed();
    const ops = await makeSalesOps();
    const person = `Mia Muster${uniq().replace(/\d/g, "")}`;
    const c = await uploadForCase(ops, file("Vermittla_-_Projektvertrag.txt", vertrag(person.replace(/[^A-Za-zäöüß ]/g, ""))));
    expect(c.channel).toBe("VERMITTLER");
    expect(c.partnerAccountId).toBeNull();
    expect(c.endCustomerAccountId).toBe(s.accountId);
    expect(c.orderNumber).toBe("60M2099000001");
    expect(Number(c.dailyRate)).toBe(700);
    expect(c.days).toBe(60);
    expect(c.startDate).toBe("2027-01-01");
    expect(c.endDate).toBe("2027-03-31");
    const sug = c.parsed as { parsed: { sender: { value: string } }; partnerReason: string; readMode: string };
    expect(sug.parsed.sender.value).toBe("Vermittla AG (fiktiv)");
    expect(sug.partnerReason).toContain("noch nicht angelegt");
    expect(["KI", "REGELN"]).toContain(sug.readMode);
  });

  it("KI-Werte zählen nur mit wörtlicher Textstelle; Pauschalen und Zahlungsziele fallen raus", async () => {
    const { fromAi, merge } = await import("@/modules/o2o/ai");
    const text = vertrag("Mia Muster");
    const ai = fromAi(text, {
      contractPartner: { value: "Vermittla AG (fiktiv)", quote: "Zwischen der Vermittla AG (fiktiv)" },
      endCustomer: { value: "Erfundene GmbH", quote: "steht so nicht im Dokument" },
      rate: { value: { amount: 87.5, unit: "STUNDE" }, quote: "87,50 EUR pro tatsächlich geleisteter Projektstunde" },
      volume: { value: { amount: 9999, unit: "TAGE" }, quote: "45 Tage netto" },
    });
    expect(ai.sender?.by).toBe("KI");
    expect(ai.endCustomer).toBeNull();
    expect(ai.dailyRate?.value).toBe(700);
    expect(ai.days).toBeNull();
    const merged = merge(parseDocument(text, "x.pdf", { ownNames: ["Verve"] }), ai);
    expect(merged.endCustomer?.value).toBe("Beispielkonzern AG (fiktiv)");
    expect(merged.endCustomer?.by).toBe("REGEL");
    expect(merged.days?.value).toBe(60);
  });
});

describe("e68 Auftragseingang: Person zuordnen", () => {
  it("bildet den vollen Namen auf eine nur mit Vornamen geführte Person ab, auch „Nachname, Vorname“; mehrdeutig bleibt offen", async () => {
    const { matchKnownPerson } = await import("@/modules/o2o/service");
    const persons = { freelancers: [{ id: "f1", displayName: "Lea Lustig (fiktiv)" }, { id: "f2", displayName: "Tim Tal" }, { id: "f3", displayName: "Tom Tal" }], users: [{ id: "u1", displayName: "Moritz" }, { id: "u2", displayName: "Probe, Paula" }] };
    expect(matchKnownPerson("Moritz Mustermann", persons)).toEqual({ kind: "INTERN", id: "u1", name: "Moritz" });
    expect(matchKnownPerson("Paula Probe", persons)?.id).toBe("u2");
    expect(matchKnownPerson("Lea Lustig", persons)?.id).toBe("f1");
    expect(matchKnownPerson("T. Tal", persons)).toBeNull();
    expect(matchKnownPerson("Anna Anders", persons)).toBeNull();
  });
  it("Verwaltung kann den Anzeigenamen einer Person ändern; andere nicht", async () => {
    const s = await ensureSeed();
    const { renameUser } = await import("@/modules/governance/service");
    const [u] = await db.insert(schema.users).values({ workspaceId: s.workspaceId, email: `vorname-${uniq()}@verve.example`, displayName: "Moritz" }).returning();
    await expect(renameUser(await actorFor("david"), u!.id, "Moritz Mustermann")).rejects.toBeInstanceOf(ForbiddenError);
    const r = await renameUser(await actorFor("admin"), u!.id, "  Moritz   Mustermann ");
    expect(r.displayName).toBe("Moritz Mustermann");
  });
});

describe("e70 Auftragseingang: nach Moco schreiben", () => {
  it("Vermittler-Bestellung: Firma, Kontakt Buchhaltung, Lead gewonnen, Projekt mit Bestellnummer, Leistung mit Tagessatz ÷ 8; wiederholen legt nichts doppelt an", async () => {
    const { FixtureMocoClient } = await import("@/modules/moco/client");
    const { writeOrderToMoco } = await import("@/modules/o2o/moco");
    FixtureMocoClient.resetWrites();
    const client = new FixtureMocoClient("./tests/fixtures/moco");
    const input = { broker: true, customerName: `Endkunde ${uniq()} AG (fiktiv)`, brokerName: `Vermittla ${uniq()} AG (fiktiv)`, projectName: "Berater Umfeldanalyse", personName: "Mia Muster", personMocoUserId: null, leaderMocoUserId: 1, startDate: "2027-01-01", endDate: "2027-03-31", dailyRate: 985, days: 60, orderNumber: "60M2099000001", note: "VG-TEST", allowCreateCustomer: false, allowCreateBroker: false };
    // R3: ohne ausdrückliches „neu anlegen“ entsteht keine Firma – und danach auch sonst nichts
    const blocked = await writeOrderToMoco(client, input);
    expect(blocked.done).toBe(false);
    expect(blocked.steps[0]!.state).toBe("OFFEN");
    expect(FixtureMocoClient.written.length).toBe(0);
    const r = await writeOrderToMoco(client, { ...input, allowCreateCustomer: true, allowCreateBroker: true });
    expect(r.done).toBe(true);
    const w = (what: string) => FixtureMocoClient.written.filter((x) => x.what === what).map((x) => x.payload as Record<string, unknown>);
    expect(w("company").length).toBe(2);
    expect(w("contact")[0]).toMatchObject({ lastname: "Buchhaltung", gender: "U", job_position: "Buchhaltung", company_id: r.ids.brokerCompanyId });
    const project = w("project")[0]!;
    expect(project).toMatchObject({ customer_id: r.ids.customerCompanyId, deal_id: r.ids.dealId, billing_contact_id: r.ids.contactId, start_date: "2027-01-01", finish_date: "2027-03-31", billing_variant: "task" });
    expect((project.custom_properties as Record<string, string>).Bestellnummer).toBe("60M2099000001");
    expect(w("task")[0]).toMatchObject({ hourly_rate: 123.13, billable: true });
    expect(r.steps.find((s) => s.key === "person")!.state).toBe("OFFEN");
    const before = FixtureMocoClient.written.length;
    const again = await writeOrderToMoco(client, { ...input, personMocoUserId: 2 }, r.ids);
    expect(FixtureMocoClient.written.slice(before).map((x) => x.what)).toEqual(["deal.update", "contract"]);
    expect(again.ids.projectId).toBe(r.ids.projectId);
  });

  it("am Vorgang: nur Berechtigte, nur beauftragt; IDs landen an Kunde, Chance und Einsatz", async () => {
    const s = await ensureSeed();
    const ops = await makeSalesOps();
    const { FixtureMocoClient } = await import("@/modules/moco/client");
    const { writeCaseToMoco } = await import("@/modules/o2o/moco");
    FixtureMocoClient.resetWrites();
    const client = new FixtureMocoClient("./tests/fixtures/moco");
    await db.update(schema.users).set({ mocoUserId: 4711 }).where(eq(schema.users.id, s.users.david));
    const offer = await createOfferWithoutDocument(ops, { channel: "DIREKT", partnerAccountId: s.accountId, personNewName: `Nora Neu ${uniq()} (fiktiv)`, role: "Testerin", dailyRate: "800", startDate: "2027-02-01", endDate: "2027-04-30", offerNumber: `M-${uniq()}` });
    // Angebot: nur Firma und Lead in der Angebotsphase
    const lead = await writeCaseToMoco(ops, offer.id, { allowCreateCustomer: true }, client);
    expect(lead.done).toBe(true);
    expect(FixtureMocoClient.written.some((x) => x.what === "project")).toBe(false);
    expect(((await getCase(ops, offer.id)).systems as { moco: { mode: string } }).moco.mode).toBe("LEAD");
    const d = await uploadForCase(ops, file(`po-${uniq()}.txt`, `Bestellung ${uniq()}`), { forCaseId: offer.id });
    const po = `MO-${uniq()}`;
    const c = await confirmCase(ops, d.id, { kind: "BESTELLUNG", channel: "DIREKT", partnerAccountId: s.accountId, personNewName: offer.personName!, role: "Testerin", dailyRate: "800", startDate: "2027-02-01", endDate: "2027-04-30", orderNumber: po, matchCaseId: offer.id });
    await expect(writeCaseToMoco(await actorFor("nina"), c.id, {}, client)).rejects.toBeInstanceOf(ForbiddenError);
    const r = await writeCaseToMoco(ops, c.id, { allowCreateCustomer: true }, client);
    expect(r.done).toBe(true);
    expect((await db.query.engagements.findFirst({ where: eq(schema.engagements.id, c.engagementId!) }))!.mocoProjectId).toBe(r.ids.projectId);
    expect((await db.query.opportunities.findFirst({ where: eq(schema.opportunities.id, c.opportunityId!) }))!.mocoDealId).toBe(lead.ids.dealId);
    expect(r.ids.dealId).toBe(lead.ids.dealId);
    expect(FixtureMocoClient.written.some((x) => x.what === "deal.update" && (x.payload as { status: string }).status === "won")).toBe(true);
    expect((await db.query.accounts.findFirst({ where: eq(schema.accounts.id, s.accountId) }))!.mocoCompanyId).toBeTruthy();
    const after = await getCase(ops, c.id);
    expect((after.systems as { moco: { mode: string } }).moco.mode).toBe("GESCHRIEBEN");
  });
});

describe("e71 Auftragseingang: Excel-Angebotsformular", () => {
  it("liest Satz, Tage, Zeitraum und Nummer direkt aus den Zellen; verbundene Zellen blähen den Text nicht auf", async () => {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Offer overview");
    ws.getCell("B5").value = "offer for";
    ws.getCell("C5").value = "Beispielkonzern AG (fiktiv)";
    ws.mergeCells("C5:R5");
    ws.getCell("Z5").value = "Instructions for using the offer template. ".repeat(20);
    ws.mergeCells("Z5:AH60");
    ws.getCell("S9").value = "VCA-M27-01_0042";
    ws.getCell("B22").value = "Brief summary of the service description";
    ws.getCell("B23").value = "Verlängerung: Scrum Master Testprojekt";
    ws.getCell("Q28").value = 100;
    ws.getCell("U28").value = 1250;
    ws.getCell("X28").value = 1180;
    ws.getCell("M54").value = new Date(Date.UTC(2027, 0, 1));
    ws.getCell("Q54").value = new Date(Date.UTC(2027, 5, 30));
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const { readOfferTemplate } = await import("@/modules/o2o/template");
    const t = (await readOfferTemplate(buf))!;
    expect(t.dailyRate?.value).toBe(1180);
    expect(t.days?.value).toBe(100);
    expect(t.start?.value).toBe("2027-01-01");
    expect(t.end?.value).toBe("2027-06-30");
    expect(t.offerNumber?.value).toBe("VCA-M27-01_0042");
    expect(t.role?.value).toBe("Scrum Master Testprojekt");
    const { extractDocumentText } = await import("@/modules/documents/extract");
    const ex = await extractDocumentText(buf, "xlsx");
    expect(ex.text.length).toBeLessThan(2000);
    expect(ex.text.match(/Beispielkonzern/g)!.length).toBe(1);
    const s = await ensureSeed();
    const ops = await makeSalesOps();
    const c = await uploadForCase(ops, { name: `offer_${uniq()}.xlsx`, type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: buf.length, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer });
    expect(Number(c.dailyRate)).toBe(1180);
    expect(c.days).toBe(100);
    expect(c.startDate).toBe("2027-01-01");
    expect(c.endDate).toBe("2027-06-30");
    expect(c.partnerAccountId).toBe(s.accountId);
  });
});

describe("e71 Auftragseingang: mehrere Bestellungen derselben Person", () => {
  it("zweite Bestellung im selben Zeitraum wird ein eigener Einsatz (mit Rückfrage), keine Verlängerung und keine Dublette", async () => {
    const s = await ensureSeed();
    const ops = await makeSalesOps();
    const name = `Paula Parallel ${uniq().replace(/\d/g, "x")}`;
    const mk = async (po: string) => {
      const d = await uploadForCase(ops, file(`po-${po}.txt`, `Bestellung Nr. ${po}\nBeraterin: ${name}\nZeitraum: 01.02.2027 bis 30.06.2027\nTagessatz: 900 €`));
      return { draft: d, raw: { kind: "BESTELLUNG", channel: "DIREKT", partnerAccountId: s.accountId, personKind: "FREELANCER", ...(d.freelancerId ? { freelancerId: d.freelancerId } : { personNewName: name }), role: "Beraterin", startDate: "2027-02-01", endDate: "2027-06-30", dailyRate: "900", orderNumber: po } };
    };
    const a = await mk(`PA-${uniq()}`);
    const first = await confirmCase(ops, a.draft.id, a.raw);
    const b = await mk(`PB-${uniq()}`);
    const sug = b.draft.parsed as { renewalEngagementId: string | null; parallelNote?: string };
    expect(sug.renewalEngagementId).toBeNull();
    expect(sug.parallelNote).toContain("bereits einen laufenden Einsatz");
    const second = await confirmCase(ops, b.draft.id, b.raw);
    expect(second.engagementId).not.toBe(first.engagementId);
    const { findEngagementDuplicates } = await import("@/modules/cleanup/service");
    const dups = await findEngagementDuplicates(await actorFor("clemens"));
    expect(JSON.stringify(dups)).not.toContain(first.engagementId!);
  });
});

describe("e72 Zeitleiste zeigt versendete Angebote", () => {
  it("zwei Angebote derselben Person erscheinen als zwei Balken, auch ohne Position und Kandidatur", async () => {
    const s = await ensureSeed();
    const ops = await makeSalesOps();
    const name = `Olga Offerte ${uniq().replace(/\d/g, "x")}`;
    const ids: string[] = [];
    for (const nr of [`AN-${uniq()}`, `AN-${uniq()}`]) {
      const d = await uploadForCase(ops, file(`angebot-${nr}.txt`, `Angebot Nr. ${nr}\nBeraterin: ${name}\nZeitraum: 01.03.2027 bis 30.09.2027\nTagessatz: 950 €`));
      // ein zweites Angebot mit anderer Nummer wird nicht als neue Fassung des ersten vorgeschlagen
      expect((d.parsed as { matchCaseId?: string | null }).matchCaseId ?? null).toBeNull();
      const c = await confirmCase(ops, d.id, { kind: "ANGEBOT", channel: "DIREKT", partnerAccountId: s.accountId, personKind: "FREELANCER", ...(d.freelancerId ? { freelancerId: d.freelancerId } : { personNewName: name }), role: "Beraterin", startDate: "2027-03-01", endDate: "2027-09-30", dailyRate: "950", offerNumber: nr, matchCaseId: "" });
      ids.push(c.id);
    }
    const { asgOffers } = await import("@/modules/assignments/service");
    const offers = (await asgOffers(ops, [])).filter((o) => ids.includes(o.id.replace("case:", "")));
    expect(offers).toHaveLength(2);
    expect(offers[0]!.phase).toBe("ANGEBOT");
    expect(offers[0]!.personId).toBe(offers[1]!.personId);
    expect(offers[0]!.href).toContain("/auftragseingang/");
  });
});


describe("e74 Sammelbestellung", () => {
  it("erkennt drei Positionen, ordnet sie über Satz, Zeitraum und Tage den Angeboten zu und bestätigt je Position", async () => {
    const s = await ensureSeed();
    const ops = await makeSalesOps();
    const po = `49${Date.now().toString().slice(-8)}`;
    const offers: string[] = [];
    for (const [rate, days, name] of [[960, 130, "Anna Alpha"], [1180, 100, "Bert Beta"], [940, 100, "Cora Gamma"]] as const) {
      const d = await uploadForCase(ops, file(`ang-${uniq()}.txt`, `Angebot Nr. SAM-${uniq()}\nRolle: Beratung\nBerater: ${name} (fiktiv)\nZeitraum: 01.01.2027 bis 30.06.2027`));
      const c = await confirmCase(ops, d.id, { kind: "ANGEBOT", channel: "DIREKT", partnerAccountId: s.accountId, role: `Beratung ${name}`, personNewName: `${name} (fiktiv)`, startDate: "2027-01-01", endDate: "2027-06-30", dailyRate: String(rate), days: String(days), offerNumber: `SAM-${uniq()}` });
      offers.push(c.id);
    }
    const text = `BESTELLUNG\nBESTELLNUMMER ${po}\nArtikel Beschreibung Service Start - End Date Menge Einheit Preis Gesamt\n1 DL Beratung 2027-01-01 - 2027-\n06-30\n130 "Day Rate 960,00 124.800,00\n2 DL Beratung 2027-01-01 - 2027-\n06-30\n100 "Day Rate 1.180,00 118.000,00\n3 DL Beratung 2027-01-01 - 2027-\n06-30\n100 "Day Rate 940,00 94.000,00\n336.800,00 EUR`;
    const d = await uploadForCase(ops, file(`po-${po}.txt`, text));
    await db.update(schema.orderCases).set({ partnerAccountId: s.accountId, orderNumber: po }).where(eq(schema.orderCases.id, d.id));
    const { matchPositions, confirmCollection } = await import("@/modules/o2o/service");
    const sug = d.parsed as { positions?: { no: number; rate: number; days: number; matchCaseId: string | null }[] };
    expect(sug.positions?.map((p) => [p.days, p.rate])).toEqual([[130, 960], [100, 1180], [100, 940]]);
    const m = await matchPositions(ops, s.accountId, sug.positions!.map((p) => ({ no: p.no, days: p.days, rate: p.rate, start: "2027-01-01", end: "2027-06-30", total: null, evidence: "" })));
    expect(m.map((x) => x.matchCaseId)).toEqual(offers);
    const rows = await confirmCollection(ops, d.id, { orderNumber: po, pos_1: offers[0], pos_2: offers[1], pos_3: offers[2] });
    expect(rows.map((r) => [r.status, r.orderNumber, r.orderPosition])).toEqual([["BEAUFTRAGT", po, 1], ["BEAUFTRAGT", po, 2], ["BEAUFTRAGT", po, 3]]);
    expect(rows.map((r) => r.id)).toEqual(offers);
    expect(new Set(rows.map((r) => r.engagementId)).size).toBe(3);
    // dieselbe Position ein zweites Mal: verständliche Ablehnung statt „unerwarteter Fehler“
    const again = await uploadForCase(ops, file(`po2-${po}.txt`, `Bestellung Nr. ${po}\nRolle: Beratung\nZeitraum: 01.01.2027 bis 30.06.2027`));
    await expect(confirmCase(ops, again.id, { kind: "BESTELLUNG", channel: "DIREKT", partnerAccountId: s.accountId, role: "Beratung", personNewName: "Dora Delta (fiktiv)", orderNumber: po, orderPosition: "2" })).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("e74 Angebotsnotiz, SharePoint-Ablage und täglicher Abgleich", () => {
  it("Angebot ohne Dokument bekommt eine Angebotsnotiz als PDF", async () => {
    const ops = await makeSalesOps();
    const bd = await actorFor("david");
    const c = await createOfferWithoutDocument(ops, { bdUserId: bd.userId, partnerNewName: `Vermittla Notiz ${uniq()} (fiktiv)`, personKind: "FREELANCER", personNewName: "Nils Notiz (fiktiv)", role: "Testmanager", dailyRate: "900", startDate: "2027-02-01", endDate: "2027-07-31", brokerRef: `REF-${uniq()}` });
    const docs = await db.query.orderCaseDocuments.findMany({ where: eq(schema.orderCaseDocuments.caseId, c.id) });
    expect(docs).toHaveLength(1);
    const cd = await db.query.contractDocuments.findFirst({ where: eq(schema.contractDocuments.id, docs[0]!.documentId) });
    const f = await db.query.documents.findFirst({ where: eq(schema.documents.sourceId, cd!.sourceId!) });
    expect(f?.fileName).toMatch(/^Angebotsnotiz_VG-\d{4}-\d{4}_Notiz\.pdf$/);
  });

  it("Dateiname nach Konzept", async () => {
    const { caseFileName } = await import("@/modules/o2o/files");
    expect(caseFileName({ kind: "BESTELLUNG", number: "4711", caseNumber: "VG-2026-0001", personName: "Pia Probe (fiktiv)", originalName: "x.PDF", date: "2026-11-27" })).toBe("2026-11-27_Bestellung_4711_Probe.pdf");
    expect(caseFileName({ kind: "ANGEBOT", number: null, caseNumber: "VG-2026-0002", personName: "Müller, Jörg", originalName: "a.docx", date: "2026-11-27" })).toBe("2026-11-27_Angebot_VG-2026-0002_Muller.docx");
  });

  it("Abgleich meldet Abweichungen in Moco, schreibt nie zurück und legt fehlgeschlagene Ablagen erneut ab", async () => {
    const s = await ensureSeed();
    const ops = await makeSalesOps();
    const { FixtureMocoClient } = await import("@/modules/moco/client");
    const { FixtureSpClient, resetFixture } = await import("@/modules/sharepoint/client");
    const { dailyCheck } = await import("@/modules/o2o/sync");
    FixtureMocoClient.resetWrites();
    resetFixture();
    const moco = new FixtureMocoClient("./tests/fixtures/moco");
    const d = await uploadForCase(ops, file(`ab-${uniq()}.txt`, `Bestellung Nr. AB-${uniq()}\nRolle: Beratung\nZeitraum: 01.03.2027 bis 31.08.2027\nTagessatz: 1000 €`));
    const c = await confirmCase(ops, d.id, { kind: "BESTELLUNG", channel: "DIREKT", partnerAccountId: s.accountId, role: "Beratung", personNewName: "Abel Abgleich (fiktiv)", startDate: "2027-03-01", endDate: "2027-08-31", dailyRate: "1000", orderNumber: `AB-${uniq()}` });
    const p = await moco.createProject({ name: "Beratung", currency: "EUR", start_date: "2027-03-01", finish_date: "2027-08-31", fixed_price: false, retainer: false, leader_id: 1, customer_id: 4242, billing_variant: "task", custom_properties: { Bestellnummer: c.orderNumber! } } as never);
    await db.update(schema.orderCases).set({ systems: { ...(c.systems as object), moco: { mode: "GESCHRIEBEN", ids: { projectId: p.id, customerCompanyId: 4242 } }, sharepoint: { state: "FEHLER", note: "Test", link: null } } }).where(eq(schema.orderCases.id, c.id));
    const sp = new FixtureSpClient();
    const { setupSite } = await import("@/modules/sharepoint/service");
    await setupSite(await actorFor("clemens"), { client: sp });
    let r = await dailyCheck(s.workspaceId, { moco, sp });
    expect(r.items.filter((i) => i.caseId === c.id)).toHaveLength(0);
    expect(r.retried).toBeGreaterThanOrEqual(1);
    const after = await db.query.orderCases.findFirst({ where: eq(schema.orderCases.id, c.id) });
    expect((after!.systems as { sharepoint: { state: string } }).sharepoint.state).toBe("ABGELEGT");
    // Backoffice ändert in Moco das Ende von Hand → Hinweis, kein Rückschreiben
    FixtureMocoClient.patchProject(p.id, { finish_date: "2027-09-30" });
    const writes = FixtureMocoClient.written.length;
    r = await dailyCheck(s.workspaceId, { moco, sp });
    const mine = r.items.filter((i) => i.caseId === c.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.detail).toContain("Ende in Moco 30.09.2027, hier 31.08.2027");
    expect(FixtureMocoClient.written.length).toBe(writes);
  });
});

describe("e75 Bestellung zum Angebot mit gleicher Bestellnummer am Entwurf", () => {
  it("Entwurf mit erkanntem Kunden und Bestellnummer lässt sich mit dem Angebot zusammenführen", async () => {
    const s = await ensureSeed();
    const ops = await makeSalesOps();
    const od = await uploadForCase(ops, file(`a-${uniq()}.txt`, `Angebot Nr. ZA-${uniq()}\nRolle: Scrum Master`));
    const offer = await confirmCase(ops, od.id, { kind: "ANGEBOT", channel: "DIREKT", partnerAccountId: s.accountId, role: "Scrum Master", personNewName: "Zora Zusammen (fiktiv)", startDate: "2027-01-01", endDate: "2027-06-30", dailyRate: "1180" });
    const po = `ZB-${uniq()}`;
    const d = await uploadForCase(ops, file(`b-${uniq()}.txt`, `Bestellung Nr. ${po}\nZeitraum: 01.01.2027 bis 30.06.2027\nTagessatz: 1180 €`), { forCaseId: offer.id });
    expect(d.partnerAccountId).toBe(s.accountId);
    expect(d.orderNumber).toBe(po);
    const done = await confirmCase(ops, d.id, { kind: "BESTELLUNG", channel: "DIREKT", partnerAccountId: s.accountId, startDate: "2027-01-01", endDate: "2027-06-30", dailyRate: "1180", orderNumber: po, matchCaseId: offer.id });
    expect(done.id).toBe(offer.id);
    expect(done.status).toBe("BEAUFTRAGT");
    expect(done.orderNumber).toBe(po);
  });
});
