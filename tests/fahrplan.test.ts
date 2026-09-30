import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { ensureRenewalRuns } from "@/modules/health/renewal";
import { getHealth, recordExistingEngagement, renewalPingDate, renewalRoadmaps } from "@/modules/health/service";
import { setContractLink } from "@/modules/agenda/service";
import { canViewSource, loadSetupContext } from "@/modules/identity/authz";
import { actorFor, ensureSeed } from "./helpers";

const iso = (days: number) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

describe("Pilot-Feedback: Fahrplan Verlängerung, Vertrag am Einsatz, Belege optional", () => {
  it("Ping 3 Monate vor Ende (bzw. 30 Tage vor der Frist)", () => {
    expect(renewalPingDate({ plannedEnd: "2027-03-31", renewalDeadline: null })).toBe("2026-12-31");
    expect(renewalPingDate({ plannedEnd: "2027-03-31", renewalDeadline: "2026-12-15" })).toBe("2026-11-15");
    expect(renewalPingDate({ plannedEnd: null, renewalDeadline: null })).toBeNull();
  });

  it("Einsatz mit 80 Tagen Restlaufzeit: BD bekommt genau einen Ping, der Fahrplan zeigt ihn als nächsten Schritt", async () => {
    const s = await ensureSeed();
    const david = await actorFor("david");
    const order = await recordExistingEngagement(david, s.accountId, { setupId: s.setupId, title: `Fahrplan-Einsatz ${Date.now().toString(36)}`, plannedEnd: iso(80) }); // ohne Beleg
    expect(order.evidenceSourceId).toBeNull();
    await ensureRenewalRuns(david);
    await ensureRenewalRuns(david);
    const tasks = await db.query.standardTasks.findMany({ where: eq(schema.standardTasks.key, `renewal-ping:order:${order.id}`) });
    expect(tasks).toHaveLength(1);
    const action = await db.query.actions.findFirst({ where: eq(schema.actions.id, tasks[0]!.actionId!) });
    expect(action?.title).toMatch(/Verlängerung ansprechen/);
    expect(action?.ownerUserId).toBe(david.userId);
    // Noch kein Vorgehen: Auslöser (8 Wochen) liegt in der Zukunft
    expect(await db.query.standardTasks.findFirst({ where: eq(schema.standardTasks.key, `renewal:order:${order.id}`) })).toBeUndefined();

    const h = await getHealth(david, s.accountId);
    const e = h.engagements.find((x) => x.orderId === order.id)!;
    const map = await renewalRoadmaps([e]);
    const ms = map.get(order.id)!;
    expect(ms.map((m) => m.key)).toEqual(["PING", "START", "WIRKUNG", "BEDARF", "ANGEBOT", "ESKALATION", "ENDE"].filter((k) => ms.some((m) => m.key === k)));
    expect(ms.find((m) => m.key === "PING")!.state).toBe("UEBERFAELLIG"); // fällig seit 10 Tagen, noch nicht erledigt
    expect(ms.find((m) => m.key === "START")!.state).toBe("SPAETER");
    expect(ms.find((m) => m.key === "WIRKUNG")!.state).toBe("SPAETER");
  });

  it("Vertrag am Einsatz: Verweis speichern; der zuständige BD sieht Setup-Quellen (Verträge) seines Kunden", async () => {
    const s = await ensureSeed();
    const david = await actorFor("david");
    const order = await recordExistingEngagement(david, s.accountId, { setupId: s.setupId, title: `Vertragseinsatz ${Date.now().toString(36)}`, plannedEnd: iso(200), evidenceText: "Rahmenvertrag 2026, Abruf 7" });
    const u = await setContractLink(david, order.id, { version: order.version, contractLink: "https://crm.example/vertrag/4711" });
    expect(u.contractLink).toBe("https://crm.example/vertrag/4711");
    // Eine Quelle der Klasse SETUP, die jemand anderes angelegt hat, ist für den zuständigen BD sichtbar
    const nina = await actorFor("nina");
    const [src] = await db.insert(schema.sources).values({ workspaceId: nina.workspaceId, setupId: s.setupId, type: "DOKUMENT", title: "Bestellung (fiktiv)", body: "…", origin: "Upload", sourceTime: new Date(), ownerUserId: nina.userId, accessClass: "SETUP" }).returning();
    const ctx = await loadSetupContext(david, s.setupId);
    expect(canViewSource(david, src!, ctx)).toBe(true);
    const lars = await actorFor("lars");
    expect(canViewSource(lars, src!, await loadSetupContext(lars, s.setupId))).toBe(false);
  });
});
