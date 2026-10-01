import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { resetConfigCacheForTests } from "@/lib/config";
import { ConflictError, ForbiddenError, NotFoundError, TransitionError, ValidationError } from "@/lib/errors";
import { loadActor, type Actor } from "@/modules/identity/actor";
import { assignRole } from "@/modules/governance/service";
import { createOpportunity } from "@/modules/opportunities/service";
import { actOnWorkItem } from "@/modules/work/service";
import { addCandidacy, changeCandidacyStatus, changePositionStatus, createPosition, selectCandidacy } from "@/modules/staffing/service";
import { addContractDocument, addPeriod, changeEngagementStatus, getEngagementDetail, listEngagements, procurementCheck, saveProcurementProfile, setContractDocumentStatus, suggestDocType, updateEngagement } from "@/modules/engagements/service";
import { actOnCheckin, createCheckin, ensureCatchups, ensureRenewalDecisions, listMyCheckins, notifyDueCheckins, requestCareHandover, setCareDirect, upsertRenewalDecision } from "@/modules/engagements/care";
import { listNotifications } from "@/modules/notifications/service";
import { plusDaysIso, todayIso } from "@/modules/work/calendar";
import { actorFor, ensureSeed } from "./helpers";

async function makeSalesOps(name = "Olga Ops (Sales Operations)"): Promise<Actor> {
  const s = await ensureSeed();
  const [u] = await db.insert(schema.users).values({ workspaceId: s.workspaceId, email: `ops-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}@verve.example`, displayName: name }).returning();
  await assignRole(await actorFor("admin"), { userId: u!.id, role: "SALES_OPS" });
  return (await loadActor(u!.id))!;
}

const base = { mustHave: "Mindestens fünf Jahre Erfahrung in Java und Spring; Deutsch verhandlungssicher.", desiredStart: "2026-10-01", plannedEnd: "2027-03-31", scopeAmount: 4, scopeUnit: "TAGE_PRO_WOCHE", proposalDue: "2026-10-20", ekMax: "850", vkMin: "1050", rateUnit: "TAG" } as const;

/** Bis zur bestätigten Auswahl – liefert den Einsatz. */
async function selectedEngagement(david: Actor, title: string) {
  const s = await ensureSeed();
  const opp = await createOpportunity(david, { setupId: s.setupId, title, needDescription: `Bedarf: ${title}, fiktiv.`, kind: "FREELANCER_EXPERTE", ownerUserId: david.userId });
  const pos = await createPosition(david, opp.id, { title: "Java-Entwickler:in", ...base });
  await changePositionStatus(david, pos.id, { version: pos.version, status: "OFFEN" });
  const c0 = await addCandidacy(david, pos.id, { newName: `Mara Muster ${Date.now().toString(36)} (fiktiv)`, ekRate: "820", availableFrom: "2026-10-01" });
  const c1 = await changeCandidacyStatus(david, c0.id, { version: c0.version, status: "VORGESCHLAGEN", reason: "direkt qualifiziert" });
  const c2 = await changeCandidacyStatus(david, c1.id, { version: c1.version, status: "FREIGEGEBEN" });
  const sel = await selectCandidacy(david, c2.id, { version: c2.version, confirm: "on", reason: "Kunde kennt die Person" });
  const e = (await db.query.engagements.findFirst({ where: eq(schema.engagements.candidacyId, sel.candidacy.id) }))!;
  return { opp, pos, candidacy: sel.candidacy, engagement: e };
}

describe("Etappe 29 (E2): Einsatz aus Auswahl, Status, Perioden, Vertragslage", () => {
  it("A15: Auswahl erzeugt genau einen Einsatz (idempotent) mit Plan-Periode und BD als Kundenbetreuung", async () => {
    process.env.AI_PROVIDER = "test";
    resetConfigCacheForTests();
    const david = await actorFor("david");
    const { candidacy, engagement: e } = await selectedEngagement(david, "Einsatz Nr. 1");
    expect(e.status).toBe("VORBEREITUNG");
    expect(e.plannedEnd).toBe("2027-03-31");
    // wiederholte Auswahl → kein zweiter Einsatz
    await selectCandidacy(david, candidacy.id, { version: candidacy.version, confirm: "on" });
    const all = await db.query.engagements.findMany({ where: eq(schema.engagements.candidacyId, candidacy.id) });
    expect(all).toHaveLength(1);
    const d = await getEngagementDetail(david, e.id);
    expect(d.periods).toHaveLength(1);
    expect(d.periods[0]!.kind).toBe("PLAN");
    expect(d.periods[0]!.ek).toBe("820.00");
    expect(d.cares.map((c) => c.role)).toEqual(["CUSTOMER_CARE"]);
    expect(d.cares[0]!.userId).toBe(david.userId);
    // Chance/Auftrag unverändert (kein Backfill)
    const orders = await db.query.orders.findMany({ where: eq(schema.orders.opportunityId, e.opportunityId) });
    expect(orders).toHaveLength(0);
  });

  it("geplant nur mit Betreuung und Vertragslage (Profil) oder Ausnahme; aktiv nur mit bestätigtem Start; A22 Perioden-Historie", async () => {
    const david = await actorFor("david");
    const { engagement: e0 } = await selectedEngagement(david, "Einsatz Nr. 2");
    // ohne Profil: unbestimmt → nur mit Ausnahme
    expect((await procurementCheck(e0)).complete).toBeNull();
    await expect(changeEngagementStatus(david, e0.id, { version: e0.version, status: "GEPLANT" })).rejects.toThrow(/Beschaffungsprofil/);
    // Profil anlegen und freigeben: Kunde Bestellung + Freelancer Einzelbeauftragung
    await saveProcurementProfile(david, e0.accountId, { req_KUNDE_BESTELLUNG: "on", req_FREELANCER_EINZELBEAUFTRAGUNG: "on", approve: "on" });
    const chk = await procurementCheck(e0);
    expect(chk.profile).toBe(true);
    expect(chk.complete).toBe(false);
    await expect(changeEngagementStatus(david, e0.id, { version: e0.version, status: "GEPLANT" })).rejects.toThrow(/Vertragslage unvollständig/);
    // Unterlagen: unterschrieben braucht Beleg
    await expect(addContractDocument(david, e0.id, { side: "KUNDE", docType: "BESTELLUNG", title: "PO 4711", signedStatus: "UNTERSCHRIEBEN" }, null)).rejects.toThrow(/Beleg/);
    const po = await addContractDocument(david, e0.id, { side: "KUNDE", docType: "BESTELLUNG", title: "PO 4711", signedStatus: "UNTERSCHRIEBEN", link: "https://ablage.example/po-4711", reference: "4711" }, null);
    expect(po.document.signedStatus).toBe("UNTERSCHRIEBEN");
    const fl = await addContractDocument(david, e0.id, { side: "FREELANCER", docType: "EINZELBEAUFTRAGUNG", title: "Einzelbeauftragung Muster", signedStatus: "VERSENDET" }, null);
    expect((await procurementCheck(e0)).complete).toBe(false);
    await setContractDocumentStatus(david, e0.id, fl.document.id, { version: fl.document.version, signedStatus: "UNTERSCHRIEBEN", link: "https://ablage.example/eb-muster" });
    expect((await procurementCheck(e0)).complete).toBe(true);
    const planned = await changeEngagementStatus(david, e0.id, { version: e0.version, status: "GEPLANT" });
    expect(planned.status).toBe("GEPLANT");
    // aktiv: nicht durch Datum, nur mit bestätigtem Start; Zukunft abgelehnt
    await expect(changeEngagementStatus(david, e0.id, { version: planned.version, status: "AKTIV" })).rejects.toThrow(/Startdatum/);
    await expect(changeEngagementStatus(david, e0.id, { version: planned.version, status: "AKTIV", actualDate: plusDaysIso(todayIso(), 3) })).rejects.toThrow(/erreicht/);
    const active = await changeEngagementStatus(david, e0.id, { version: planned.version, status: "AKTIV", actualDate: todayIso() });
    expect(active.status).toBe("AKTIV");
    expect(active.actualStart).toBe(todayIso());
    // Perioden: bestätigte Periode, Satzänderung erzeugt neuen Stand, alte bleibt; Überlappung ohne Kennzeichnung abgelehnt
    const p1 = await addPeriod(david, e0.id, { kind: "BESTAETIGT", validFrom: "2026-10-01", validTo: "2026-12-31", ek: "820", vk: "1080" });
    await expect(addPeriod(david, e0.id, { kind: "BESTAETIGT", validFrom: "2026-12-01", validTo: "2027-03-31", ek: "840", vk: "1100" })).rejects.toThrow(/überlappt/);
    const p2 = await addPeriod(david, e0.id, { kind: "BESTAETIGT", validFrom: "2027-01-01", validTo: "2027-03-31", ek: "840", vk: "1100", supersedesId: p1.id, source: "Nachtrag 1" });
    const d = await getEngagementDetail(david, e0.id);
    expect(d.periods.filter((p) => p.kind === "BESTAETIGT")).toHaveLength(2);
    expect(d.periods.find((p) => p.id === p1.id)!.supersededById).toBe(p2.id);
    expect(d.periods.find((p) => p.id === p1.id)!.ek).toBe("820.00");
    // Ausnahme-Pfad für einen zweiten Einsatz ohne vollständige Unterlagen
    const { engagement: e1 } = await selectedEngagement(david, "Einsatz Nr. 3");
    const ex = await changeEngagementStatus(david, e1.id, { version: e1.version, status: "GEPLANT", exception: "Rahmenvertrag deckt ab; Bestellung folgt laut Einkauf nächste Woche." });
    expect(ex.procurementException).toMatch(/Rahmenvertrag/);
    // A25 veraltete Version
    await expect(updateEngagement(david, e1.id, { version: 99, title: "Titel neu", plannedEnd: "" })).rejects.toBeInstanceOf(ConflictError);
  });

  it("Dokumenttyp-Vorschlag aus Text; Scan wird nicht ausgewertet (A28)", async () => {
    expect(suggestDocType("Hiermit bestellen wir gemäß Bestellnummer 4711 …")?.docType).toBe("BESTELLUNG");
    expect(suggestDocType("Rahmenvertrag über IT-Dienstleistungen zwischen …")?.docType).toBe("RAHMENVERTRAG");
    expect(suggestDocType("Vertraulichkeitsvereinbarung (NDA)")?.docType).toBe("NDA");
    expect(suggestDocType("Lorem ipsum")).toBeNull();
    const david = await actorFor("david");
    const { engagement: e } = await selectedEngagement(david, "Einsatz Scan");
    const bytes = new TextEncoder().encode("");
    const scan = { name: "scan.txt", type: "text/plain", size: 1, arrayBuffer: async () => bytes.buffer as ArrayBuffer };
    const r = await addContractDocument(david, e.id, { side: "KUNDE", docType: "SONSTIGES", title: "Scan", signedStatus: "ENTWURF" }, { ...scan, size: 5, arrayBuffer: async () => new TextEncoder().encode("     ").buffer as ArrayBuffer });
    expect(r.suggestion?.extractStatus).toBe("LEER");
    expect(r.suggestion?.note).toMatch(/Scan erkannt/);
    expect(r.document.signedStatus).toBe("ENTWURF");
  });
});

describe("Etappe 29 (E2): Betreuung, Check-ins, Verlängerung, Sales-Signal", () => {
  it("A06/A07: Übergabe an Sales Ops aktiviert die Betreuung; Abschluss des Vorgangs beendet sie nicht; Wechsel entzieht die alte Zuordnung", async () => {
    const david = await actorFor("david");
    const ops = await makeSalesOps();
    const ops2 = await makeSalesOps("Otto Ops (Sales Operations)");
    const { engagement: e } = await selectedEngagement(david, "Einsatz Betreuung");
    // Sales Ops ohne Zuordnung sieht nichts
    await expect(getEngagementDetail(ops, e.id)).rejects.toBeInstanceOf(NotFoundError);
    const w = await requestCareHandover(david, e.id, { target: ops.userId, reason: "Account wächst, Betreuung an Sales Ops", contacts: "Frau Keller", commitments: "Verlängerung bis März klären" });
    expect(w.kind).toBe("BETREUUNG");
    await expect(requestCareHandover(david, e.id, { target: ops2.userId, reason: "noch eine" })).rejects.toBeInstanceOf(ConflictError);
    const acc = await actOnWorkItem(ops, w.id, { version: w.version, action: "ANNEHMEN" });
    expect(acc.status).toBe("OFFEN");
    const d = await getEngagementDetail(ops, e.id);
    expect(d.access.care).toBe(true);
    expect(d.access.manage).toBe(false);
    expect(d.cares.filter((c) => !c.toDate).map((c) => c.userId)).toEqual([ops.userId]);
    expect(d.cares.find((c) => c.userId === david.userId)!.toDate).toBeTruthy();
    // Sales Ops hat keine Account-/Statusrechte
    await expect(changeEngagementStatus(ops, e.id, { version: d.view.version, status: "GEPLANT", exception: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    // Vorgang abschließen → Betreuung bleibt
    const done = await actOnWorkItem(ops, w.id, { version: acc.version, action: "ABSCHLIESSEN", result: "Übernommen." });
    expect(done.status).toBe("ERLEDIGT");
    expect((await getEngagementDetail(ops, e.id)).access.care).toBe(true);
    // Wechsel: direkte Umstellung auf Otto entzieht Olga, Davids BD-Rechte bleiben
    await setCareDirect(david, e.id, { role: "CUSTOMER_CARE", userId: ops2.userId, reason: "Urlaubsvertretung dauerhaft" });
    await expect(getEngagementDetail(ops, e.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await getEngagementDetail(ops2, e.id)).access.care).toBe(true);
    expect((await getEngagementDetail(david, e.id)).access.manage).toBe(true);
    // Liste: Betreuungsfilter
    expect((await listEngagements(ops2, "betreuung")).items.map((x) => x.id)).toContain(e.id);
    expect((await listEngagements(await actorFor("nina"))).items).toHaveLength(0);
  });

  it("A20: Catch-up aus tatsächlichem Gespräch; Verschieben simuliert kein Gespräch; Sales-Hinweis wird Signal; A24 Pause beendet Routine", async () => {
    process.env.AI_PROVIDER = "test";
    resetConfigCacheForTests();
    const david = await actorFor("david");
    const { engagement: e0 } = await selectedEngagement(david, "Einsatz Check-in");
    const planned = await changeEngagementStatus(david, e0.id, { version: e0.version, status: "GEPLANT", exception: "Testausnahme für den Durchlauf" });
    const active = await changeEngagementStatus(david, e0.id, { version: planned.version, status: "AKTIV", actualDate: plusDaysIso(todayIso(), -50) });
    // Regel erzeugt genau einen Kunden-Check-in: Start + 42
    expect(await ensureCatchups(david.workspaceId)).toBeGreaterThanOrEqual(1);
    expect(await ensureCatchups(david.workspaceId)).toBe(0);
    let mine = await listMyCheckins(david);
    const ci = mine.find((c) => c.engagementId === e0.id)!;
    expect(ci.dueDate).toBe(plusDaysIso(active.actualStart!, 42));
    expect(ci.overdue).toBe(true);
    // Hinweis einmal je Tag
    const before = (await listNotifications(david)).filter((n) => n.kind === "UEBERFAELLIG" && n.link.includes(e0.id)).length;
    await notifyDueCheckins(david.workspaceId);
    await notifyDueCheckins(david.workspaceId);
    expect((await listNotifications(david)).filter((n) => n.kind === "UEBERFAELLIG" && n.link.includes(e0.id)).length).toBe(before + 1);
    // Verschieben ändert nur die Fälligkeit
    const moved = await actOnCheckin(david, ci.id, { version: ci.version, action: "VERSCHIEBEN", newDueDate: plusDaysIso(todayIso(), 3), reason: "Kunde im Urlaub" });
    expect(moved.status).toBe("FAELLIG");
    expect(moved.heldAt).toBeNull();
    // Erledigen braucht Termin und Ergebnis; erzeugt nächsten Check-in +42 ab Gespräch; Sales-Hinweis → Signal
    await expect(actOnCheckin(david, ci.id, { version: moved.version, action: "ERLEDIGEN", note: "ok" })).rejects.toBeInstanceOf(ValidationError);
    const held = `${todayIso()}T10:00`;
    const done = await actOnCheckin(david, ci.id, { version: moved.version, action: "ERLEDIGEN", heldAt: held, note: "Zufrieden, Team wächst.", participants: "Frau Keller", salesHint: "Der Bereich plant ab Q2 zwei weitere Testautomatisierer." });
    expect(done.status).toBe("ERLEDIGT");
    expect(done.salesSignalId).toBeTruthy();
    const sig = await db.query.signals.findFirst({ where: eq(schema.signals.id, done.salesSignalId!) });
    expect(sig?.observation).toMatch(/Testautomatisierer/);
    mine = await listMyCheckins(david);
    const nextCi = mine.find((c) => c.engagementId === e0.id && c.status === "FAELLIG")!;
    expect(nextCi.dueDate).toBe(plusDaysIso(todayIso(), 42));
    // Freelancer-Check-in separat, keine automatische Pflicht
    const fcl = await createCheckin(david, e0.id, { side: "FREELANCER", dueDate: plusDaysIso(todayIso(), 7) });
    expect(fcl.side).toBe("FREELANCER");
    // Pause: fällige Routine-Check-ins entfallen, Fristen bleiben
    const cur = (await db.query.engagements.findFirst({ where: eq(schema.engagements.id, e0.id) }))!;
    await changeEngagementStatus(david, e0.id, { version: cur.version, status: "PAUSIERT", reason: "Projektstopp", reviewDate: plusDaysIso(todayIso(), 30) });
    const after = await db.query.checkins.findMany({ where: and(eq(schema.checkins.engagementId, e0.id), eq(schema.checkins.status, "FAELLIG")) });
    expect(after).toHaveLength(0);
    expect(await ensureCatchups(david.workspaceId)).toBe(0);
  });

  it("A21/8.3: Verlängerungsentscheidung aus der frühesten Frist; Bestätigung erzeugt neue Periode; Abschluss nur ohne offene Entscheidung", async () => {
    const david = await actorFor("david");
    const { engagement: e0 } = await selectedEngagement(david, "Einsatz Verlängerung");
    const planned = await changeEngagementStatus(david, e0.id, { version: e0.version, status: "GEPLANT", exception: "Testausnahme für den Durchlauf" });
    const active = await changeEngagementStatus(david, e0.id, { version: planned.version, status: "AKTIV", actualDate: todayIso() });
    // Ende in 60 Tagen, Kündigungsfrist in 20 Tagen → Ping längst fällig
    const upd = await updateEngagement(david, e0.id, { version: active.version, title: e0.title, plannedEnd: plusDaysIso(todayIso(), 60), renewalDeadline: plusDaysIso(todayIso(), 20) });
    expect(await ensureRenewalDecisions(david.workspaceId)).toBe(1);
    expect(await ensureRenewalDecisions(david.workspaceId)).toBe(0);
    let d = await getEngagementDetail(david, e0.id);
    expect(d.renewals[0]!.status).toBe("ZU_KLAEREN");
    expect(d.view.pingDate! <= todayIso()).toBe(true);
    // ohne Zeitraum/Konditionen/Vertragsfolge keine Bestätigung
    await expect(upsertRenewalDecision(david, e0.id, { status: "BESTAETIGT" })).rejects.toThrow(/Zeitraum/);
    await upsertRenewalDecision(david, e0.id, { status: "IN_ABSTIMMUNG", availabilityNote: "Freelancer bis Juni verfügbar" });
    await expect(changeEngagementStatus(david, e0.id, { version: upd.version, status: "ENDET", actualDate: todayIso() }).then((x) => changeEngagementStatus(david, e0.id, { version: x.version, status: "ABGESCHLOSSEN" }))).rejects.toThrow(/Verlängerungsentscheidung/);
    const to = plusDaysIso(todayIso(), 150);
    const conf = await upsertRenewalDecision(david, e0.id, { status: "BESTAETIGT", proposedFrom: plusDaysIso(todayIso(), 61), proposedTo: to, ek: "840", vk: "1100", contractFollowUp: "Nachtrag 2 zur Einzelbeauftragung" });
    expect(conf.status).toBe("BESTAETIGT");
    expect(conf.resultPeriodId).toBeTruthy();
    d = await getEngagementDetail(david, e0.id);
    expect(d.view.plannedEnd).toBe(to);
    expect(d.periods.some((p) => p.id === conf.resultPeriodId && p.kind === "BESTAETIGT" && p.ek === "840.00")).toBe(true);
    // Sales Ops darf vorbereiten, nicht bestätigen
    const ops = await makeSalesOps();
    await setCareDirect(david, e0.id, { role: "CUSTOMER_CARE", userId: ops.userId });
    await expect(upsertRenewalDecision(ops, e0.id, { status: "BESTAETIGT", proposedFrom: to, proposedTo: plusDaysIso(to, 30), ek: "1", contractFollowUp: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    expect((await upsertRenewalDecision(ops, e0.id, { status: "ZU_KLAEREN", availabilityNote: "neue Runde" })).status).toBe("ZU_KLAEREN");
    void TransitionError;
  });
});

describe("Etappe 29 (E2): Hilfe", () => {
  it("beantwortet Bedienfragen zur Einsatzakte", async () => {
    const { searchHelp } = await import("@/modules/help/knowledge");
    expect(searchHelp("Wie übergebe ich die Betreuung eines Einsatzes an Sales Operations?")[0]?.section.id).toBe("einsatz");
    expect(searchHelp("Wann ist der nächste Check-in beim Kunden fällig?")[0]?.section.id).toBe("checkin");
    expect(searchHelp("Was braucht ein Einsatz, um geplant zu sein?").map((x) => x.section.id)).toContain("einsatz");
  });
});
