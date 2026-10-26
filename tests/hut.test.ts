import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { assignRole } from "@/modules/governance/service";
import { loadActor } from "@/modules/identity/actor";
import { buildDashboard, loadHat, setHat, viewLabel } from "@/modules/dashboard/service";
import { splitNav } from "@/modules/dashboard/hat";
import { actorFor, ensureSeed } from "./helpers";

describe("Etappe 37: Hut statt Rollen-Sammlung", () => {
  it("H01: Mehrere Rollen → Start im GF-Hut; Wechsel wird je Person gemerkt; fremde Hüte sind nicht wählbar", async () => {
    const s = await ensureSeed();
    const admin = await actorFor("admin");
    const [u] = await db.insert(schema.users).values({ workspaceId: s.workspaceId, email: `gf-${Date.now().toString(36)}@verve.example`, displayName: "Gerd Geschäftsführer (fiktiv)" }).returning();
    for (const role of ["CEO", "PRINCIPAL"] as const) await assignRole(admin, { userId: u!.id, role });
    await assignRole(admin, { userId: u!.id, role: "BD", accountId: s.accountId });
    const gf = (await loadActor(u!.id))!;
    const first = await loadHat(gf, null);
    expect(first.available).toEqual(["BD", "PRINCIPAL", "CEO"]);
    expect(first.hat).toBe("CEO");
    expect(viewLabel.CEO).toBe("Geschäftsführung");
    // Wechsel in den Principal-Hut – gemerkt in der Datenbank, schlägt das Cookie
    expect(await setHat(gf, "PRINCIPAL")).toBe("PRINCIPAL");
    expect((await db.query.users.findFirst({ where: eq(schema.users.id, gf.userId) }))!.preferredHat).toBe("PRINCIPAL");
    expect((await loadHat(gf, "BD")).hat).toBe("PRINCIPAL");
    expect((await buildDashboard(gf, (await loadHat(gf)).hat))!.view).toBe("PRINCIPAL");
    // Coach-Hut hat er nicht → abgelehnt, Hut bleibt
    expect(await setHat(gf, "COACH")).toBeNull();
    expect((await loadHat(gf)).hat).toBe("PRINCIPAL");
    // Einzelrolle: genau ein Hut
    const david = await actorFor("david");
    expect((await loadHat(david)).available).toEqual(["BD"]);
  });

  it("H02: Navigation folgt dem Hut, alles Weitere landet unter „Mehr“ – nichts geht verloren", () => {
    const all = new Set(["start", "arbeit", "kunden", "bds", "einsaetze", "besetzung", "eingang", "ziele"]);
    const ceo = splitNav("CEO", all);
    expect(ceo.main.map((n) => n.label)).toEqual(["Start", "Ziele", "Meine BDs", "Kunden", "Einsätze"]);
    expect(ceo.more.map((n) => n.label).sort()).toEqual(["Besetzung", "Eingang", "Meine Arbeit"]);
    const bd = splitNav("BD", new Set(["start", "arbeit", "kunden", "eingang", "ziele"]));
    expect(bd.main.map((n) => n.href)).toEqual(["/start", "/meine-arbeit", "/kunden", "/eingang"]);
    expect(bd.more.map((n) => n.href)).toEqual(["/ziele"]);
    expect(splitNav(null, new Set(["start", "arbeit", "kunden"])).main).toHaveLength(3);
  });
});
