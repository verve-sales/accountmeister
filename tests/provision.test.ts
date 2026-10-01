import { describe, expect, it } from "vitest";
import { computeDeal, costsFor, legendFor, FREELANCER } from "@/modules/provision/model";
import { provisionAccess } from "@/modules/provision/access";
import { actorFor, ensureSeed } from "./helpers";

const fl = (ek: number, vk: number, days: number, extra: object = {}) => ({ profile: FREELANCER, ek, vk, days, ...extra });

describe("Provisionsrechner (Nachbau Verve_Freelancer_ProvisionV2.xlsx)", () => {
  it("rechnet für Principals exakt wie die Vorlage", () => {
    // Zeile „Steffen“: 720/1026, 55,5 Tage → Nettomarge 25,93 %, Satz 20 %, 2.952,60 + 250 + 1.000
    const a = computeDeal(fl(720, 1026, 55.5), "PRINCIPAL")!;
    expect(a.costs).toBe(2220);
    expect(a.netMargin).toBeCloseTo(14763, 6);
    expect(a.netMarginPct).toBeCloseTo(0.2593, 4);
    expect(a.rate).toBe(0.2);
    expect(a.baseCommission).toBeCloseTo(2952.6, 6);
    expect(a.total).toBeCloseTo(4202.6, 6);
    // „Marvin“: 800/1500, 180 Tage → 44 % → Satz 20 % (unter 45 %)
    expect(computeDeal(fl(800, 1500, 180), "PRINCIPAL")!.rate).toBe(0.2);
    // ab 45 % Nettomarge: 43 %
    const p = computeDeal(fl(500, 1500, 100), "PRINCIPAL")!;
    expect(p.netMarginPct).toBeGreaterThanOrEqual(0.45);
    expect(p.rate).toBe(0.43);
    // „Beispiel 4“: 13,3 % → 10 %, 2.400 Basis; „Preiskampf“: 8,7 % → nur Fees
    expect(computeDeal(fl(1000, 1200, 150), "PRINCIPAL")!.baseCommission).toBeCloseTo(2400, 6);
    expect(computeDeal(fl(800, 920, 150), "PRINCIPAL")!.total).toBe(1250);
  });

  it("BDs und Anker erhalten höchstens 20 % – die 43 % ab 45 % Marge sind Principals vorbehalten", () => {
    const b = computeDeal(fl(720, 1026, 55.5), "BD")!; // 25,9 % → 20 % wie beim Principal
    expect(b.rate).toBe(0.2);
    expect(b.capped).toBe(false);
    const c = computeDeal(fl(500, 1500, 100), "ANKER")!; // > 45 %
    expect(c.rate).toBe(0.2);
    expect(c.capped).toBe(true);
    expect(c.warnings.join(" ")).toMatch(/höchstens 20 %/);
    expect(computeDeal(fl(1000, 1200, 150), "ANKER")!.rate).toBe(0.1);
    expect(legendFor("BD").map((l) => l.text).join("\n")).not.toMatch(/43/);
    expect(legendFor("PRINCIPAL").map((l) => l.text).join("\n")).toMatch(/ab 45 % → 43 %/);
  });

  it("interne Rollen haben feste EKs; Anteile an Finding/Signing Fee sind frei", () => {
    const r = computeDeal({ profile: "ASSOCIATE", ek: 9999, vk: 720, days: 150, findingShare: 50, signingShare: 0 }, "PRINCIPAL")!;
    expect(r.ek).toBe(500); // fest, Eingabe wird ignoriert
    expect(r.netMarginPct).toBeCloseTo(0.25, 6);
    expect(r.findingFee).toBe(125);
    expect(r.signingFee).toBe(0);
    expect(computeDeal({ profile: "CONSULTANT_2", vk: 720, days: 150 }, "BD")!.warnings.join(" ")).toMatch(/Negative Nettomarge/);
    expect(computeDeal(fl(700, 0, 10), "BD")).toBeNull();
    expect(costsFor(120)).toBe(4800);
  });

  it("Zugang: Anker, BD, Principal (und CEO); Principal-Stufen nur für Principal/CEO", async () => {
    await ensureSeed();
    expect(provisionAccess(await actorFor("nina"))).toEqual({ allowed: true, principal: false });
    expect(provisionAccess(await actorFor("david"))).toEqual({ allowed: true, principal: false });
    expect(provisionAccess(await actorFor("petra"))).toEqual({ allowed: true, principal: true });
    expect(provisionAccess(await actorFor("admin")).allowed).toBe(false);
  });
});
