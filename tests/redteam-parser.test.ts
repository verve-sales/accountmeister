import { describe, expect, it } from "vitest";
import { extractOrderNumber, folderFor, looksLikeOrder } from "@/modules/sharepoint/documents";
import { folderName, freelancerFolder, offerNumberFromName, yearFolder, yearOf } from "@/modules/sharepoint/service";
import { suggestDocType } from "@/modules/engagements/service";
import { nameSimilarity, normName } from "@/modules/moco/import";

/**
 * e63 Red Team – Erkennung aus Dateinamen und Texten. Grundlage für Offer-to-Order v2 (Upload im Assignmentmanager):
 * Jede falsch gelesene Nummer landet sonst in Moco, SharePoint und am Einsatz. Alle Daten fiktiv.
 */

describe("Red Team: Angebotsnummer aus dem Dateinamen", () => {
  it.each([
    ["2026-11-27_Angebot_VCA-M26-11_0003_Dalipi.pdf", "VCA-M26-11_0003"],
    ["Angebot VCA-M26-11_0003.xlsx", "VCA-M26-11_0003"],
    ["VCA-M26-11-0003.docx", "VCA-M26-11-0003"],
    ["VCA-M26-01_123.pdf", "VCA-M26-01_123"],
    ["Testkunde_VCA-M27-12_45678.pdf", "VCA-M27-12_45678"],
    ["ABC-X1-05_0042 Angebot.pdf", "ABC-X1-05_0042"],
  ])("%s → %s", (name, nr) => expect(offerNumberFromName(name)).toBe(nr));

  it.each([
    ["Angebot.pdf"],
    ["Angebot vom 27.11.2026.pdf"],
    ["Rechnung 2026-11-0003.pdf"],
    ["vca-m26-11_0003.pdf"],
    ["VCA-M26-1_0003.pdf"],
    ["VCA-M26-11_12.pdf"],
  ])("%s → keine Nummer", (name) => expect(offerNumberFromName(name)).toBeNull());
});

describe("Red Team: Bestellnummer aus Text", () => {
  it.each([
    ["Bestellung Nr. 4500123987 – Testmanagement", "4500123987"],
    ["PO-Nr: AB-2026-0042", "AB-2026-0042"],
    ["Purchase Order 7781-22", "7781-22"],
    ["Bestellnummer: BX/2026/17", "BX/2026/17"],
    ["Ihre Bestellung 45-778/2026 ist eingegangen", "45-778/2026"],
    ["anbei die Unterlagen, SAP 4500999911", "4500999911"],
    ["PO Number: 4500012345", "4500012345"],
  ])("%s → %s", (text, nr) => expect(extractOrderNumber(text)).toBe(nr));

  it.each([
    ["Danke für das Gespräch"],
    ["Bestellnummer folgt"],
    ["Bestellung vom Kunden kommt nächste Woche"],
    ["Rückruf unter Tel. 4012345678"],
    ["Fax 4098765432 bitte nicht nutzen"],
    ["Mobil: +49 4012345678"],
    ["IBAN DE89 4012345678 bei der Fiktivbank"],
  ])("%s → keine Bestellnummer", (text) => expect(extractOrderNumber(text)).toBeNull());

  it("SAP-Nummer nach einer Telefonnummer wird trotzdem gefunden", () => {
    expect(extractOrderNumber("Tel. 4012345678\n\nBitte Abruf 4500111222 bestätigen")).toBe("4500111222");
  });
});

describe("Red Team: sieht das nach einer Bestellung aus?", () => {
  it.each([
    ["WG: Bestellung 4500123987", "", "PO.pdf"],
    ["Purchase Order", "", ""],
    ["Auftragsbestätigung", "", ""],
    ["Beauftragung Testmanagement", "", ""],
    ["Abruf aus dem Rahmenvertrag", "", ""],
    ["", "", "Bestellnummer_4711.pdf"],
    ["Ihr Angebot", "hiermit Bestellung gemäß Angebot", ""],
  ])("%s / %s / %s → ja", (s, b, f) => expect(looksLikeOrder(s, b, f)).toBe(true));

  it.each([
    ["Ihr Dokument ist abrufbar", "", ""],
    ["Termine abrufen", "", ""],
    ["Potenzial für 2027", "", ""],
    ["Angebot VCA-M26-11_0003", "anbei unser Angebot", "Angebot.pdf"],
    ["Rechnung November", "", "Rechnung.pdf"],
  ])("%s / %s / %s → nein", (s, b, f) => expect(looksLikeOrder(s, b, f)).toBe(false));
});

describe("Red Team: Dokumentart-Vorschlag", () => {
  it.each([
    ["Hiermit bestellen wir gemäß Bestellnummer 4711", "BESTELLUNG"],
    ["Gemäß Ihrem Angebot bestellen wir folgende Leistungen", "BESTELLUNG"],
    ["Purchase Order 4500012345", "BESTELLUNG"],
    ["Rahmenvertrag über IT-Dienstleistungen", "RAHMENVERTRAG"],
    ["Master Services Agreement", "RAHMENVERTRAG"],
    ["Nachtrag Nr. 2 zum Einzelvertrag", "NACHTRAG"],
    ["Amendment No. 1", "NACHTRAG"],
    ["Kündigung des Einzelauftrags", "KUENDIGUNG"],
    ["Vertraulichkeitsvereinbarung (NDA)", "NDA"],
    ["Leistungsschein Testmanagement", "EINZELBEAUFTRAGUNG"],
    ["Statement of Work", "EINZELBEAUFTRAGUNG"],
    ["Unser Angebot für Testmanagement", "ANGEBOT"],
    ["Angebotsnummer VCA-M26-11_0003", "ANGEBOT"],
    ["Quotation for testing services", "ANGEBOT"],
  ])("%s → %s", (text, type) => expect(suggestDocType(text)?.docType).toBe(type));

  it.each([["Lorem ipsum"], ["Stellenangebot Senior Tester"], ["Angebotsanfragen bitte an vertrieb@verve.example"]])("%s → kein Vorschlag", (text) => expect(suggestDocType(text)).toBeNull());

  it("Belegstelle zeigt die Fundstelle mit Umgebung", () => {
    const r = suggestDocType("Sehr geehrte Damen und Herren, hiermit bestellen wir zwei Tester.")!;
    expect(r.evidence).toContain("bestellen wir");
  });
});

describe("Red Team: Firmennamen abgleichen (Dubletten in Moco vermeiden)", () => {
  it.each([
    ["Vaillant GmbH (fiktiv)", "vaillant"],
    ["Hafenbank eG", "hafenbank eg"],
    ["Muster & Co. KG", "muster"],
    ["Nordlicht Versicherung AG", "nordlicht versicherung"],
    ["Stadtwerke Beispielstadt", "stadtwerke beispielstadt"],
  ])("normName(%s) = %s", (a, b) => expect(normName(a)).toBe(b));

  it.each([
    ["Vaillant GmbH", "Vaillant GmbH", 1],
    ["Vaillant GmbH", "VAILLANT", 1],
    ["ITERGO", "ITERGO Informationstechnologie GmbH", 0.85],
    ["Hays AG", "Gulp GmbH", 0],
    ["AG", "GmbH", 0],
  ])("%s ~ %s = %s", (a, b, v) => expect(nameSimilarity(a, b)).toBeCloseTo(v as number, 2));

  it("Teilweise Übereinstimmung liegt zwischen 0 und 1", () => {
    const v = nameSimilarity("Nordlicht Versicherung AG", "Nordlicht Leben AG");
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(0.85);
  });
});

describe("Red Team: SharePoint-Pfade", () => {
  it.each([
    [["ITERGO", "Angebote"], "2026-11-27_Angebot.pdf", ["ITERGO", "Angebote", "2026"]],
    [["ITERGO", "Bestellungen"], "2025-01-02_PO.pdf", ["ITERGO", "Bestellungen", "2025"]],
    [["ITERGO", "Rahmen und Einkauf"], "2026-11-27_RV.pdf", ["ITERGO", "Rahmen und Einkauf"]],
    [["Mustermann, Max", "Verträge"], "2027-03-01_PEV.pdf", ["Mustermann, Max", "Verträge", "2027"]],
  ])("yearFolder(%j, %s)", (folder, name, out) => expect(yearFolder(folder as string[], name as string)).toEqual(out));

  it("Jahr ohne Datum im Namen: Änderungsdatum, sonst aktuelles Jahr", () => {
    expect(yearOf("Angebot.pdf", "2024-05-01T10:00:00Z")).toBe("2024");
    expect(yearOf("Angebot.pdf")).toBe(new Date().toISOString().slice(0, 4));
  });

  it.each([
    ["Max Mustermann", "Mustermann, Max"],
    ["Mustermann, Max", "Mustermann, Max"],
    ["Anna Maria Beispiel", "Beispiel, Anna Maria"],
  ])("Freelancer-Ordner %s → %s", (n, out) => expect(freelancerFolder(n)).toBe(out));

  it("Ordnernamen enthalten keine Schrägstriche oder Doppelpunkte (SharePoint lehnt sie ab)", () => {
    const n = folderName("A/B: C | D");
    expect(n).not.toMatch(/[/:|]/);
  });

  it.each([
    [{ side: "KUNDE", docType: "ANGEBOT" }, ["Kunden", "Angebote"]],
    [{ side: "KUNDE", docType: "BESTELLUNG" }, ["Kunden", "Bestellungen"]],
    [{ side: "KUNDE", docType: "NACHTRAG" }, ["Kunden", "Bestellungen"]],
    [{ side: "KUNDE", docType: "KUENDIGUNG" }, ["Kunden", "Bestellungen"]],
    [{ side: "KUNDE", docType: "RAHMENVERTRAG" }, ["Kunden", "Rahmen und Einkauf"]],
    [{ side: "KUNDE", docType: "NDA" }, ["Kunden", "Rahmen und Einkauf"]],
    [{ side: "FREELANCER", docType: "EINZELBEAUFTRAGUNG" }, ["Freelancer", "Verträge"]],
    [{ side: "FREELANCER", docType: "SONSTIGES" }, ["Freelancer", "Nachweise"]],
  ])("folderFor(%j)", (d, [lib, sub]) => {
    const r = folderFor(d, "Testkunde (fiktiv)", "Max Mustermann");
    expect(r.lib).toBe(lib);
    expect(r.path.at(-1)).toBe(sub);
  });

  it("Freelancer-Dokument ohne Freelancer landet beim Kunden, nie im Nirgendwo", () => {
    expect(folderFor({ side: "FREELANCER", docType: "EINZELBEAUFTRAGUNG" }, "Testkunde", null).lib).toBe("Kunden");
  });
});
