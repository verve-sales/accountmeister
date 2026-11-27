import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertEngagementTransition, currentPeriod, engagementStatusValues, isOverdueEngagement, type EngStatus } from "@/modules/engagements/service";
import { verifyMocoSignature } from "@/modules/moco/sync";
import { isFreelancerMocoUser, isIgnoredMocoUser, isInternalMocoCompany } from "@/modules/moco/client";
import { suggestCategory } from "@/modules/moco/leads";
import { ALL_LINKS, MAIN_NAV, MORE_GROUPS, splitNav } from "@/modules/dashboard/hat";
import { fmtDate, pl } from "@/lib/labels";

/**
 * e63 Red Team – Regeln, auf die sich die Upload-Logik stützt: Statusübergänge der Einsätze, maßgebliche Periode,
 * Webhook-Prüfung, Moco-Abgrenzung und Navigation. Jede Zelle der Übergangstabelle ist ein eigener Fall.
 */

const ALLOWED: Record<EngStatus, EngStatus[]> = {
  VORBEREITUNG: ["GEPLANT", "AKTIV", "ABGEBROCHEN"],
  GEPLANT: ["AKTIV", "VORBEREITUNG", "ABGEBROCHEN"],
  AKTIV: ["PAUSIERT", "ENDET", "ABGEBROCHEN"],
  PAUSIERT: ["AKTIV", "ENDET", "ABGEBROCHEN"],
  ENDET: ["ABGESCHLOSSEN", "AKTIV"],
  ABGESCHLOSSEN: [],
  ABGEBROCHEN: [],
};
const matrix = engagementStatusValues.flatMap((from) => engagementStatusValues.map((to) => [from, to, ALLOWED[from].includes(to)] as const));

describe("Red Team: Statusübergänge der Einsätze (vollständige Tabelle)", () => {
  it.each(matrix)("%s → %s erlaubt: %s", (from, to, ok) => {
    if (ok) expect(() => assertEngagementTransition(from, to)).not.toThrow();
    else expect(() => assertEngagementTransition(from, to)).toThrow(/nicht vorgesehen/);
  });

  it("Unbekannter Ausgangsstatus wird abgewiesen, nicht durchgelassen", () => {
    expect(() => assertEngagementTransition("GEHACKT", "AKTIV")).toThrow();
  });
});

describe("Red Team: Ende überschritten", () => {
  const today = "2026-11-27";
  it.each([
    ["AKTIV", null, "2026-11-26", true],
    ["AKTIV", null, "2026-11-27", false],
    ["AKTIV", "2026-11-20", "2027-01-31", true],
    ["PAUSIERT", null, "2026-01-01", true],
    ["ENDET", null, "2026-11-01", true],
    ["GEPLANT", null, "2026-01-01", false],
    ["ABGESCHLOSSEN", null, "2026-01-01", false],
    ["AKTIV", null, null, false],
  ])("%s, Ende %s/%s → %s", (status, actualEnd, plannedEnd, out) => {
    expect(isOverdueEngagement({ status: status as string, actualEnd: actualEnd as string | null, plannedEnd: plannedEnd as string | null }, today)).toBe(out);
  });
});

describe("Red Team: maßgebliche Periode", () => {
  const p = (id: string, validFrom: string, kind: string, created: number, supersededById: string | null = null) => ({ id, validFrom, kind, createdAt: new Date(created), supersededById });

  it("leer → keine Periode", () => expect(currentPeriod([])).toBeNull());
  it("jüngstes „gültig ab“ gewinnt", () => expect(currentPeriod([p("a", "2026-01-01", "BESTAETIGT", 1), p("b", "2026-06-01", "BESTAETIGT", 2)])!.id).toBe("b"));
  it("abgelöste Perioden zählen nie", () => expect(currentPeriod([p("a", "2026-01-01", "BESTAETIGT", 1), p("b", "2026-06-01", "BESTAETIGT", 2, "a")])!.id).toBe("a"));
  it("bei gleichem Datum gewinnt die bestätigte", () => expect(currentPeriod([p("a", "2026-06-01", "GEPLANT", 5), p("b", "2026-06-01", "BESTAETIGT", 1)])!.id).toBe("b"));
  it("bei Gleichstand gewinnt die zuletzt angelegte", () => expect(currentPeriod([p("a", "2026-06-01", "BESTAETIGT", 1), p("b", "2026-06-01", "BESTAETIGT", 2)])!.id).toBe("b"));
  it("nur abgelöste → keine", () => expect(currentPeriod([p("a", "2026-06-01", "BESTAETIGT", 1, "x")])).toBeNull());
  it("Eingabe wird nicht umsortiert", () => {
    const list = [p("a", "2026-01-01", "BESTAETIGT", 1), p("b", "2026-06-01", "BESTAETIGT", 2)];
    currentPeriod(list);
    expect(list.map((x) => x.id)).toEqual(["a", "b"]);
  });
});

describe("Red Team: Moco-Webhook-Signatur", () => {
  const secret = "test-geheimnis";
  const body = JSON.stringify({ id: 1, name: "Testprojekt (fiktiv)" });
  const sig = createHmac("sha256", secret).update(body).digest("hex");
  it("gültige Signatur", () => expect(verifyMocoSignature(body, sig, secret)).toBe(true));
  it("Großbuchstaben und Leerzeichen werden toleriert", () => expect(verifyMocoSignature(body, ` ${sig.toUpperCase()} `, secret)).toBe(true));
  it("veränderter Inhalt → abgelehnt", () => expect(verifyMocoSignature(body.replace("1", "2"), sig, secret)).toBe(false));
  it("falsches Geheimnis → abgelehnt", () => expect(verifyMocoSignature(body, sig, "anderes")).toBe(false));
  it("ohne Signatur → abgelehnt", () => expect(verifyMocoSignature(body, null, secret)).toBe(false));
  it("ohne konfiguriertes Geheimnis → immer abgelehnt", () => expect(verifyMocoSignature(body, sig, undefined)).toBe(false));
  it("abgeschnittene Signatur → abgelehnt, ohne Ausnahme", () => expect(verifyMocoSignature(body, sig.slice(0, 10), secret)).toBe(false));
  it("leere Signatur → abgelehnt", () => expect(verifyMocoSignature(body, "", secret)).toBe(false));
});

describe("Red Team: Abgrenzung in Moco", () => {
  it.each([
    ["Verve Consulting", true],
    ["Verve Consulting GmbH", true],
    ["verve consulting gmbh & co", true],
    ["Verve Consulting Akademie", true],
    ["Verveco GmbH", false],
    ["Nordlicht Versicherung AG", false],
    [null, false],
    ["", false],
  ])("intern: %s → %s", (n, out) => expect(isInternalMocoCompany(n as string | null)).toBe(out));

  it.each([
    [{ unit: { name: "Freelancer" }, external: false }, true],
    [{ unit: { name: "Externe Berater" }, external: false }, true],
    [{ unit: { name: "Freiberufler Pool" }, external: false }, true],
    [{ unit: { name: "Partnernetzwerk" }, external: false }, true],
    [{ unit: { name: "Beratung" }, external: true }, true],
    [{ unit: { name: "Beratung" }, external: false }, false],
    [{ unit: null, external: false }, false],
  ])("Freelancer: %j → %s", (u, out) => expect(isFreelancerMocoUser(u)).toBe(out));

  it.each([
    [{ email: "salesagent@verveconsulting.de", firstname: "Sales", lastname: "Agent" }, true],
    [{ email: "SALESAGENT@verveconsulting.de", firstname: "X", lastname: "Y" }, true],
    [{ email: null, firstname: "Accountmeister", lastname: "Technik" }, true],
    [{ email: "max@verve.example", firstname: "Max", lastname: "Mustermann" }, false],
  ])("technisches Konto: %j → %s", (u, out) => expect(isIgnoredMocoUser(u)).toBe(out));
});

describe("Red Team: Moco-Phase für Chancen", () => {
  const cats = [
    { id: 1, name: "Erstkontakt", probability: 10 },
    { id: 2, name: "Bedarf geklärt", probability: 40 },
    { id: 3, name: "Angebot verschickt", probability: 70 },
    { id: 4, name: "Verhandlung", probability: 90 },
  ];
  it.each([
    ["ANTIZIPIERT", 1],
    ["IN_KLAERUNG", 1],
    ["BESTAETIGT", 2],
    ["PROFIL_ANGEBOT_VORGESTELLT", 3],
    ["AUSWAHL_BESTELLUNG", 4],
  ])("%s → Phase %s", (status, id) => expect(suggestCategory(status, cats)!.id).toBe(id));
  it("ohne Phasen in Moco → kein Vorschlag", () => expect(suggestCategory("BESTAETIGT", [])).toBeNull());
});

describe("Red Team: Navigation verliert nichts", () => {
  const all = new Set(Object.keys(ALL_LINKS));
  it("jeder Link steht genau einmal in Hauptreihe oder „Mehr“", () => {
    const keys = [...MAIN_NAV, ...MORE_GROUPS.flatMap((g) => g.keys)];
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(keys)).toEqual(all);
  });
  it.each(["CEO", "PRINCIPAL", "BD", "ANKER", "SALES_OPS", "COACH"] as const)("Hut %s: alle erlaubten Links erreichbar", (hat) => {
    const r = splitNav(hat, all);
    expect(r.main.length + r.more.length).toBe(all.size);
  });
  it("nicht erlaubte Links erscheinen nirgends", () => {
    const r = splitNav("BD", new Set(["start", "kunden"]));
    expect([...r.main, ...r.more].map((l) => l.href)).toEqual(["/start", "/kunden"]);
    expect(r.groups.every((g) => g.links.length === 0)).toBe(true);
  });
});

describe("Red Team: Anzeige", () => {
  it.each([
    [0, "0 Chancen"],
    [1, "1 Chance"],
    [2, "2 Chancen"],
    [-1, "-1 Chancen"],
  ])("pl(%s)", (n, out) => expect(pl(n as number, "Chance", "Chancen")).toBe(out));
  it.each([
    ["2026-11-27", "27.11.2026"],
    ["2026-01-05", "5.1.2026"],
    [null, "–"],
    [undefined, "–"],
  ])("fmtDate(%s) = %s", (d, out) => expect(fmtDate(d as string | null | undefined)).toBe(out));
  it("Mitternacht UTC zeigt in Berlin den richtigen Tag", () => expect(fmtDate("2026-06-30T23:30:00Z")).toBe("1.7.2026"));
});
