import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { normalizePlaceholders, renderContract, type ContractData } from "@/modules/conversion/contract";
import { contractTemplateFromSharePoint } from "@/modules/sharepoint/contractTemplate";
import { FixtureSpClient, resetFixture } from "@/modules/sharepoint/client";
import { setupSite, LIB, libraryMap } from "@/modules/sharepoint/service";
import { actorFor } from "./helpers";

const base: ContractData = {
  variant: "PERSON", rolle: "Scrum Master", leistungsbereich: "der Integrationsentwicklung", aufgaben: ["Coaching agiler Teams", "Moderation"],
  auftragnehmer_name: "Frieda Frei (fiktiv)", auftragnehmer_strasse: "Musterweg 1", auftragnehmer_plz_ort: "12345 Beispielstadt", steuernummer: "000/000/00000",
  endkunde: "Beispielkonzern AG (fiktiv)", endkunde_ort: "Düsseldorf", beginn: "01.01.2027", ende: "30.06.2027", kontingent_tage: "110", stunden_je_projekttag: "8", bedingung_frist: "15.01.2027",
  einsatzort: "Düsseldorf", stundensatz: "75,00", zahlungsziel_tage: "30", kuendigungsfrist_tage: "14", ort: "Düsseldorf", datum: "10.12.2026",
};

const text = async (buf: Buffer) => (await (await JSZip.loadAsync(buf)).file("word/document.xml")!.async("string")).replace(/<[^>]+>/g, "");

describe("e54: eigene Vertragsvorlage aus SharePoint", () => {
  it("V01: von Word zerlegte Platzhalter werden wieder zusammengezogen", () => {
    const x = `<w:p><w:r><w:t>{auftrag</w:t></w:r><w:proofErr w:type="spellStart"/><w:r><w:rPr><w:b/></w:rPr><w:t>nehmer_name}</w:t></w:r></w:p>`;
    expect(normalizePlaceholders(x)).toContain("{auftragnehmer_name}");
    // nie über Absatzgrenzen hinweg
    expect(normalizePlaceholders("<w:p><w:t>{a</w:t></w:p><w:p><w:t>b}</w:t></w:p>")).toContain("</w:p>");
  });

  it("V02: Vorlage unter Vorlagen › Vertrag wird gewählt und gefüllt; einfache Aufgaben-Variante {aufgaben}", async () => {
    resetFixture();
    const client = new FixtureSpClient();
    await setupSite(await actorFor("clemens"), { client });
    // Ohne Vorlage: null → eingebaute Vorlage
    expect(await contractTemplateFromSharePoint("PERSON", { client })).toBeNull();
    // eigene Vorlage: eingebaute nehmen, Kennzeichen einfügen, Aufgaben als {aufgaben}, Platzhalter zerlegt
    const zip = await JSZip.loadAsync(await readFile(path.join(process.cwd(), "templates", "vertrag", "projekteinzelvertrag-einzelperson.docx")));
    let xml = await zip.file("word/document.xml")!.async("string");
    xml = xml.replace("{#aufgaben}{.}{/aufgaben}", "{aufgaben}").replace("{rolle}", "{ro</w:t></w:r><w:r><w:t>lle} VERVE-HAUSVORLAGE");
    zip.file("word/document.xml", xml);
    const bytes = await zip.generateAsync({ type: "arraybuffer" });
    const drive = await client.driveOf((await libraryMap(client)).get(LIB.VORLAGEN)!);
    await client.upload(drive, ["Vertrag"], "Projekteinzelvertrag Einzelperson.docx", bytes);
    const t = await contractTemplateFromSharePoint("PERSON", { client });
    expect(t?.name).toBe("Projekteinzelvertrag Einzelperson.docx");
    // für Gesellschaften passt keine Datei (nur eine Personen-Vorlage) → eingebaute
    expect(await contractTemplateFromSharePoint("GESELLSCHAFT", { client })).toBeNull();
    const out = await text(await renderContract(base, { templateBytes: t!.bytes }));
    expect(out).toContain("Scrum Master VERVE-HAUSVORLAGE");
    expect(out).toContain("Coaching agiler Teams");
    expect(out).toContain("Moderation");
    expect(out).not.toMatch(/\{[a-z_#./]+\}/);
  });
});
