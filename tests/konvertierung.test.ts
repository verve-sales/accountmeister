import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import JSZip from "jszip";
import { db, schema } from "@/db/client";
import { resetConfigCacheForTests } from "@/lib/config";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { createOpportunity, changeOpportunityStatus } from "@/modules/opportunities/service";
import { createPosition, quickFill, requireFreelancer } from "@/modules/staffing/service";
import { setContractDocumentStatus } from "@/modules/engagements/service";
import { renderContract, type ContractData } from "@/modules/conversion/contract";
import { contractDefaults, generateFreelancerContract } from "@/modules/conversion/contractService";
import { ensureBackofficeTeam, getFreelancerProfile, saveFreelancerProfile } from "@/modules/conversion/profile";
import { cancelConversion, getConversion, listConversions, listRunningConversions, markClarified, recordCommit, recordOrder, saveOffer, startConversion } from "@/modules/conversion/service";
import { acknowledgeHandover, getHandover, listHandovers, remindOpenHandovers } from "@/modules/conversion/handover";
import { plusDaysIso, todayIso } from "@/modules/work/calendar";
import { actorFor, ensureSeed } from "./helpers";

function env() {
  process.env.FEATURE_BESETZUNG = "true";
  resetConfigCacheForTests();
}

const base: ContractData = {
  variant: "PERSON", rolle: "Scrum Master", leistungsbereich: "der Software- und Integrationsentwicklung", aufgaben: ["Coaching agiler Teams", "Moderation der Events & Impediments"],
  auftragnehmer_name: "Frieda Frei (fiktiv)", auftragnehmer_strasse: "Musterweg 1", auftragnehmer_plz_ort: "12345 Beispielstadt", steuernummer: "000/000/00000",
  endkunde: "Beispielkonzern AG (fiktiv)", endkunde_ort: "Düsseldorf", beginn: "01.01.2027", ende: "30.06.2027", kontingent_tage: "110", stunden_je_projekttag: "8", bedingung_frist: "15.01.2027",
  einsatzort: "Düsseldorf", stundensatz: "75,00", zahlungsziel_tage: "30", kuendigungsfrist_tage: "14", ort: "Düsseldorf", datum: "10.12.2026",
};

async function docText(buf: Buffer) {
  const zip = await JSZip.loadAsync(buf);
  const x = await zip.file("word/document.xml")!.async("string");
  return { xml: x, text: x.replace(/<\/w:p>/g, "\n").replace(/<[^>]+>/g, "") , files: Object.keys(zip.files) };
}

async function setupCase(label: string) {
  const s = await ensureSeed();
  const david = await actorFor("david");
  const opp = await createOpportunity(david, { setupId: s.setupId, title: `${label} ${Date.now().toString(36)}`, needDescription: "Testbedarf für den Konvertierungsvorgang.", kind: "FREELANCER_EXPERTE" });
  return { s, david, opp };
}

describe("Etappe 51: Konvertierungsvorgang, Freelancer-Profil, Vertrag aus Vorlage, Übergabe ans Backoffice", () => {
  it("K01: Vertrag aus der Vorlage – beide Fassungen gefüllt, Aufgaben wiederholt, keine Platzhalter und keine Unterschriftsbilder übrig; fehlende Angabe wird benannt", async () => {
    const p = await docText(await renderContract(base));
    expect(p.text).toContain("Freiberufliche Projektmitarbeit – Scrum Master");
    expect(p.text).toContain("Frieda Frei (fiktiv)");
    expect(p.text).toContain("Steuernummer: 000/000/00000");
    expect(p.text).toContain("Coaching agiler Teams");
    expect(p.text).toContain("Moderation der Events &amp; Impediments");
    expect(p.xml).toContain("Events &amp; Impediments");
    expect(p.text).toContain("110 Projekttage; ein Projekttag entspricht 8 Stunden");
    expect(p.text).toContain("aufschiebenden Bedingung");
    expect(p.text).toContain("nicht bis zum 15.01.2027");
    expect(p.text).toContain("75,00 EUR pro tatsächlich geleisteter Stunde");
    expect(p.text).not.toMatch(/\{[a-z_#/.]+\}/);
    // nur das Logo und eine leere Fläche – keine Unterschrift in der Vorlage
    expect(p.files.filter((f) => f.startsWith("word/media/")).sort()).toEqual(["word/media/image1.jpeg", "word/media/image2.jpeg"]);
    const g = await docText(await renderContract({ ...base, variant: "GESELLSCHAFT", auftragnehmer_firma: "Beispiel IPM GmbH (fiktiv)", vertreter_name: "Gero Geschäft (fiktiv)", vertreter_funktion: "den Geschäftsführer" }));
    expect(g.text).toContain("Beispiel IPM GmbH (fiktiv)");
    expect(g.text).toContain("vertreten durch den Geschäftsführer Gero Geschäft (fiktiv)");
    expect(g.text).not.toContain("Steuernummer");
    await expect(renderContract({ ...base, auftragnehmer_strasse: "" })).rejects.toThrow(/Straße des Auftragnehmers/);
  });

  it("K02: Freelancer-Profil – Konditionen nur für Berechtigte, Aufruf protokolliert, außerhalb des Profils nie mitgegeben", async () => {
    env();
    const { s, david, opp } = await setupCase("Profil K02");
    const q = await quickFill(david, opp.id, { title: "Tester:in", resourceKind: "FREELANCER", newName: `Paula Profil ${Date.now().toString(36)} (fiktiv)`, ekRate: "640", vkRate: "900", desiredStart: todayIso(), plannedEnd: plusDaysIso(todayIso(), 90) });
    const fid = q.engagement.freelancerId!;
    const f0 = (await db.query.freelancers.findFirst({ where: eq(schema.freelancers.id, fid) }))!;
    const ceo = await actorFor("clemens");
    await saveFreelancerProfile(ceo, fid, { version: f0.version, legalForm: "PERSON", street: "Musterweg 2", postalCity: "12345 Beispielstadt", residence: "Beispielstadt", roles: "Testmanagement", ekRate: "80", ekUnit: "STUNDE", paymentTermDays: "30", taxNumber: "000/111/22222", invoiceNote: "Rechnung per Mail" });
    // BD des Einsatzes: Konditionen ja, Vertragliches nein
    const forBd = await getFreelancerProfile(david, fid);
    expect(forBd.showConditions).toBe(true);
    expect(forBd.freelancer.ekRate).toBe("80.00");
    expect(forBd.showContractual).toBe(false);
    expect(forBd.freelancer.taxNumber).toBeNull();
    expect(forBd.projects.map((p) => p.engagementId)).toContain(q.engagement.id);
    const audits = await db.query.auditEvents.findMany({ where: and(eq(schema.auditEvents.objectId, fid), eq(schema.auditEvents.action, "freelancer.conditions_viewed")) });
    expect(audits.some((a) => a.actorUserId === s.users.david)).toBe(true);
    // Principal ohne Einsatz bei diesem Freelancer: Profil ja, Konditionen nein; Speichern von Konditionen abgewiesen
    const petra = await actorFor("petra");
    const forP = await getFreelancerProfile(petra, fid);
    expect(forP.showConditions).toBe(false);
    expect(forP.freelancer.ekRate).toBeNull();
    expect(forP.rateHistory).toHaveLength(0);
    await expect(saveFreelancerProfile(petra, fid, { version: forP.freelancer.version, ekRate: "10" })).rejects.toBeInstanceOf(ForbiddenError);
    await saveFreelancerProfile(petra, fid, { version: forP.freelancer.version, legalForm: "PERSON", street: "Musterweg 2", postalCity: "12345 Beispielstadt", languages: "Deutsch, Englisch" });
    const after = (await db.query.freelancers.findFirst({ where: eq(schema.freelancers.id, fid) }))!;
    expect(after.ekRate).toBe("80.00"); // unberührt
    expect(after.languages).toBe("Deutsch, Englisch");
    // außerhalb des Profils: geschützte Felder leer
    expect((await requireFreelancer(ceo, fid)).ekRate).toBeNull();
    expect((await requireFreelancer(ceo, fid)).taxNumber).toBeNull();
  });

  it("K03: Vorgang von der Anfrage bis zur quittierten Übergabe – Schritte, Vertrag als Entwurf am Einsatz, Hinweis ohne Konditionen, Quittung mit Moco-Projekt", async () => {
    env();
    const { s, david, opp } = await setupCase("Vorgang K03");
    const nina = await actorFor("nina");
    await expect(startConversion(await actorFor("lars"), opp.id)).rejects.toThrow();
    const c = await startConversion(david, opp.id);
    expect((await startConversion(david, opp.id)).id).toBe(c.id);
    let v = (await getConversion(david, opp.id))!;
    expect(v.steps.map((x) => x.state)).toEqual(["ERLEDIGT", "AKTUELL", "OFFEN", "OFFEN", "ENTFAELLT", "OFFEN"]);
    await markClarified(david, c.id);
    const q = await quickFill(david, opp.id, { title: "Scrum Master", resourceKind: "FREELANCER", newName: `Selma Scrum ${Date.now().toString(36)} (fiktiv)`, ekRate: "600", vkRate: "960", desiredStart: plusDaysIso(todayIso(), 14), plannedEnd: plusDaysIso(todayIso(), 200), tasks: "Coaching agiler Teams\nModeration agiler Events" });
    v = (await getConversion(david, opp.id))!;
    expect(v.steps.find((x) => x.key === "BESETZUNG")!.state).toBe("ERLEDIGT");
    expect(v.steps.find((x) => x.key === "VERTRAG")!.state).toBe("OFFEN");
    await expect(saveOffer(david, c.id, { sent: "1" })).rejects.toThrow(/Angebotsnummer/);
    await expect(recordCommit(david, c.id, "Zusage von Frau Keller")).rejects.toThrow(/abgegeben/);
    await saveOffer(david, c.id, { offerNumber: "A2611-007", sent: "1" });
    await recordCommit(david, c.id, "Frau Keller hat am Telefon zugesagt: 960 EUR, Start in zwei Wochen.");
    // Vertrag: Profil unvollständig → benannt; danach erzeugt und als Entwurf am Einsatz
    const fid = q.engagement.freelancerId!;
    const d0 = await contractDefaults(david, q.engagement.id);
    expect(d0.missingProfile).toEqual(expect.arrayContaining(["Straße", "PLZ und Ort", "Steuernummer"]));
    expect(d0.aufgaben).toContain("Coaching agiler Teams");
    expect(d0.stundensatz).toBe("75,00"); // 600 je Tag ÷ 8
    const input = { rolle: d0.rolle, leistungsbereich: d0.leistungsbereich, aufgaben: d0.aufgaben, endkunde: d0.endkunde, endkundeOrt: "Düsseldorf", beginn: d0.beginn, ende: d0.ende, kontingentTage: "110", stundenJeProjekttag: "8", bedingungFrist: d0.bedingungFrist, einsatzort: "Düsseldorf", stundensatz: d0.stundensatz, zahlungszielTage: "30", kuendigungsfristTage: "14", ort: "Düsseldorf", datum: todayIso() };
    await expect(generateFreelancerContract(david, q.engagement.id, input)).rejects.toThrow(/Straße des Auftragnehmers/);
    const ceo = await actorFor("clemens");
    const f = (await db.query.freelancers.findFirst({ where: eq(schema.freelancers.id, fid) }))!;
    await saveFreelancerProfile(ceo, fid, { version: f.version, legalForm: "PERSON", street: "Musterweg 3", postalCity: "12345 Beispielstadt", taxNumber: "000/222/33333", ekRate: "75", ekUnit: "STUNDE", invoiceNote: "IBAN auf der Rechnung" });
    await expect(generateFreelancerContract(nina, q.engagement.id, input)).rejects.toThrow();
    const gen = await generateFreelancerContract(david, q.engagement.id, input);
    expect(gen.fileName).toMatch(/^\d{4}-\d{2}-\d{2}_Projekteinzelvertrag_Beispielkonzern-AG-fiktiv_fiktiv|Projekteinzelvertrag_/);
    expect(gen.document.signedStatus).toBe("ENTWURF");
    expect(gen.document.side).toBe("FREELANCER");
    expect(gen.document.sourceId).toBeTruthy();
    v = (await getConversion(david, opp.id))!;
    expect(v.positions[0]!.contractStatus).toBe("ENTWURF");
    expect(v.steps.find((x) => x.key === "VERTRAG")!.state).toBe("AKTUELL");
    await setContractDocumentStatus(david, q.engagement.id, gen.document.id, { version: gen.document.version, signedStatus: "VERSENDET" });
    v = (await getConversion(david, opp.id))!;
    expect(v.steps.find((x) => x.key === "VERTRAG")!.state).toBe("ERLEDIGT"); // versendet genügt zum Weitergehen
    // Beauftragung → Übergabe
    const team = await ensureBackofficeTeam(s.workspaceId);
    await db.insert(schema.teamMembers).values({ teamId: team.id, userId: s.users.admin, role: "MITGLIED" }).onConflictDoNothing();
    await expect(recordOrder(david, c.id, {})).rejects.toThrow(/Bestellnummer/);
    const r = await recordOrder(david, c.id, { orderReference: "4500123456", orderLink: "https://beispiel.example/bestellung" });
    expect(r.kind).toBe("BEAUFTRAGT");
    expect(r.handoverIds).toHaveLength(1);
    expect((await db.query.opportunities.findFirst({ where: eq(schema.opportunities.id, opp.id) }))?.status).toBe("BEAUFTRAGT");
    const admin = await actorFor("admin");
    const note = (await db.query.notifications.findMany({ where: eq(schema.notifications.userId, s.users.admin) })).find((n) => n.link === `/uebergaben/${r.handoverIds[0]}`)!;
    expect(note.title).toMatch(/Angebot in Moco in ein Projekt umwandeln/);
    expect(note.title).not.toMatch(/75|600|960/); // Hinweis ohne Konditionen
    const hv = await getHandover(admin, r.handoverIds[0]!);
    expect(hv.payload).toMatchObject({ bestellnummer: "4500123456", angebotsnummer: "A2611-007", personArt: "FREELANCER", freelancerRechnungsdaten: "IBAN auf der Rechnung" });
    expect(hv.payload.ek).toBeTruthy();
    expect((await listHandovers(admin)).some((x) => x.id === hv.handover.id)).toBe(true);
    await expect(getHandover(nina, r.handoverIds[0]!)).rejects.toThrow();
    await expect(acknowledgeHandover(david, hv.handover.id, { mocoProjectId: "7001" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(acknowledgeHandover(admin, hv.handover.id, {})).rejects.toBeInstanceOf(ValidationError);
    v = (await getConversion(david, opp.id))!;
    expect(v.steps.find((x) => x.key === "BEAUFTRAGUNG")!.state).toBe("AKTUELL");
    await acknowledgeHandover(admin, hv.handover.id, { mocoProjectId: "7001", note: "Projekt angelegt" });
    expect((await db.query.engagements.findFirst({ where: eq(schema.engagements.id, q.engagement.id) }))?.mocoProjectId).toBe(7001);
    v = (await getConversion(david, opp.id))!;
    expect(v.steps.every((x) => x.state === "ERLEDIGT")).toBe(true);
    expect(v.conversion.status).toBe("ABGESCHLOSSEN");
    expect((await db.query.notifications.findMany({ where: eq(schema.notifications.userId, s.users.david) })).some((n) => /Backoffice hat quittiert/.test(n.title))).toBe(true);
  });

  it("K04: Start mit Zusage per Mail – vorläufige Übergabe, später „Bestellung nachgereicht“; offene Übergaben werden erinnert", async () => {
    env();
    const { s, david, opp } = await setupCase("Vorgang K04");
    const c = await startConversion(david, opp.id);
    await markClarified(david, c.id);
    const q = await quickFill(david, opp.id, { title: "Business Analystin", resourceKind: "INTERN", internalUserId: s.users.nina, desiredStart: todayIso(), plannedEnd: plusDaysIso(todayIso(), 120), vkRate: "1100" });
    await saveOffer(david, c.id, { offerNumber: "A2611-008", sent: "1" });
    await recordCommit(david, c.id, "Zusage per Mail von Herrn Beispiel am Montag.");
    let v = (await getConversion(david, opp.id))!;
    expect(v.steps.find((x) => x.key === "VERTRAG")!.state).toBe("ENTFAELLT");
    await expect(recordOrder(david, c.id, { provisional: "1" })).rejects.toThrow(/Zusage-Mail/);
    const r1 = await recordOrder(david, c.id, { provisional: "1", evidence: "Mail von Herrn Beispiel vom Montag: Start sofort, Bestellung folgt." });
    expect(r1.kind).toBe("VORLAEUFIG");
    const admin = await actorFor("admin");
    await acknowledgeHandover(admin, r1.handoverIds[0]!, { mocoProjectId: "7002" });
    v = (await getConversion(david, opp.id))!;
    expect(v.conversion.status).toBe("LAUFEND"); // Bestellung fehlt noch
    expect(v.steps.find((x) => x.key === "BEAUFTRAGUNG")!.note).toMatch(/Bestellung offen/);
    const r2 = await recordOrder(david, c.id, { orderReference: "4500999" });
    expect(r2.kind).toBe("BESTELLUNG_NACHGEREICHT");
    // Erinnerung nach zwei Tagen
    await db.update(schema.backofficeHandovers).set({ createdAt: new Date(Date.now() - 3 * 86400000) }).where(eq(schema.backofficeHandovers.id, r2.handoverIds[0]!));
    expect(await remindOpenHandovers()).toBeGreaterThanOrEqual(1);
    expect(await remindOpenHandovers()).toBe(0);
    await acknowledgeHandover(admin, r2.handoverIds[0]!, {});
    expect((await getConversion(david, opp.id))!.conversion.status).toBe("ABGESCHLOSSEN");
    expect(q.engagement.id).toBeTruthy();
  });

  it("K05: Abbruch jederzeit; geschlossene Chance beendet den Vorgang von selbst", async () => {
    env();
    const { david, opp } = await setupCase("Vorgang K05");
    const c = await startConversion(david, opp.id);
    await expect(cancelConversion(david, c.id, "")).rejects.toBeInstanceOf(ValidationError);
    await cancelConversion(david, c.id, "Kunde hat das Vorhaben gestoppt");
    expect((await getConversion(david, opp.id))!.conversion.status).toBe("ABGEBROCHEN");
    await expect(markClarified(david, c.id)).rejects.toThrow(/beendet/);
    const two = await setupCase("Vorgang K05b");
    const c2 = await startConversion(two.david, two.opp.id);
    const o = (await db.query.opportunities.findFirst({ where: eq(schema.opportunities.id, two.opp.id) }))!;
    await changeOpportunityStatus(await actorFor("petra"), two.opp.id, { version: o.version, status: "BEENDET", reason: "Bedarf entfallen" });
    const v = (await getConversion(two.david, two.opp.id))!;
    expect(v.conversion.id).toBe(c2.id);
    expect(v.conversion.status).toBe("ABGEBROCHEN");
    expect(v.conversion.endedReason).toBe("Chance geschlossen");
  });
  it("K06: je Position ein eigener Vorgang – zwei besetzt und einzeln beauftragt, die dritte bleibt in der Besetzung; Abbruch und Neustart nur für eine Position", async () => {
    env();
    const { s, david, opp } = await setupCase("Vorgang K06");
    const c0 = await startConversion(david, opp.id);
    await markClarified(david, c0.id);
    const fill = (n: string) => quickFill(david, opp.id, { title: "Scrum Master", resourceKind: "FREELANCER", newName: `${n} ${Date.now().toString(36)} (fiktiv)`, ekRate: "600", vkRate: "960", desiredStart: plusDaysIso(todayIso(), 14), plannedEnd: plusDaysIso(todayIso(), 200) });
    const q1 = await fill("Mara Eins");
    const q2 = await fill("Timo Zwei");
    const open = await createPosition(david, opp.id, { title: "Scrum Master", resourceKind: "FREELANCER" });
    let all = await listConversions(david, opp.id);
    expect(all).toHaveLength(3);
    expect(all[0]!.conversion.id).toBe(c0.id); // der erste Vorgang geht auf die erste Position über
    expect(all.map((v) => v.position?.id)).toEqual([q1.engagement.positionId, q2.engagement.positionId, open.id]);
    expect(all.every((v) => v.conversion.clarifiedAt)).toBe(true); // Klärung wird vererbt
    expect(all.map((v) => v.steps.find((x) => x.state === "AKTUELL")!.key)).toEqual(["ANGEBOT", "ANGEBOT", "BESETZUNG"]);
    expect(all[0]!.label).toMatch(/Scrum Master – Mara Eins/);
    expect(all[2]!.label).toMatch(/noch offen/);
    // erste Person: Angebot, Zusage, Bestellung → genau eine Übergabe, nur für ihren Einsatz
    const [a, b, c] = all.map((v) => v.conversion.id) as [string, string, string];
    await saveOffer(david, a, { offerNumber: "A2611-020", sent: "1" });
    await recordCommit(david, a, "Zusage für Mara Eins am Telefon.");
    all = await listConversions(david, opp.id);
    expect(all[1]!.siblingOffer?.number).toBe("A2611-020"); // Vorschlag, nicht gespeichert
    expect(all[1]!.conversion.offerNumber).toBeNull();
    const team = await ensureBackofficeTeam(s.workspaceId);
    await db.insert(schema.teamMembers).values({ teamId: team.id, userId: s.users.admin, role: "MITGLIED" }).onConflictDoNothing();
    const r1 = await recordOrder(david, a, { orderReference: "4500000001" });
    expect(r1.handoverIds).toHaveLength(1);
    expect((await getHandover(await actorFor("admin"), r1.handoverIds[0]!)).handover.engagementId).toBe(q1.engagement.id);
    await expect(recordOrder(david, b, { orderReference: "4500000002" })).rejects.toThrow(/Zusage/);
    await expect(recordOrder(david, c, { orderReference: "4500000003" })).rejects.toThrow(/Zusage/);
    // zweite Person mit eigener Bestellnummer → eigener Auftrag
    await saveOffer(david, b, { offerNumber: "A2611-020", sent: "1" });
    await recordCommit(david, b, "Zusage für Timo Zwei per Mail.");
    await recordOrder(david, b, { orderReference: "4500000002" });
    const e1 = (await db.query.engagements.findFirst({ where: eq(schema.engagements.id, q1.engagement.id) }))!;
    const e2 = (await db.query.engagements.findFirst({ where: eq(schema.engagements.id, q2.engagement.id) }))!;
    expect(e1.orderId).toBeTruthy();
    expect(e2.orderId).toBeTruthy();
    expect(e1.orderId).not.toBe(e2.orderId);
    await acknowledgeHandover(await actorFor("admin"), r1.handoverIds[0]!, { mocoProjectId: "7061" });
    all = await listConversions(david, opp.id);
    expect(all.map((v) => v.conversion.status)).toEqual(["ABGESCHLOSSEN", "LAUFEND", "LAUFEND"]);
    expect((await getConversion(david, opp.id))!.conversion.id).toBe(b); // Standard: der erste laufende
    expect((await listRunningConversions(david)).filter((x) => x.opportunityId === opp.id).map((x) => x.id).sort()).toEqual([b, c].sort());
    // dritte Position: Abbruch nur dieses Vorgangs, Neustart für die Position
    await cancelConversion(david, c, "Kunde sucht den dritten Platz später");
    all = await listConversions(david, opp.id);
    expect(all.map((v) => v.conversion.status)).toEqual(["ABGESCHLOSSEN", "LAUFEND", "ABGEBROCHEN"]);
    const again = await startConversion(david, opp.id, open.id);
    expect(again.id).not.toBe(c);
    all = await listConversions(david, opp.id);
    expect(all).toHaveLength(3);
    expect(all[2]!.conversion.id).toBe(again.id);
    expect(all[2]!.conversion.status).toBe("LAUFEND");
  });
});
