import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { resetConfigCacheForTests } from "@/lib/config";
import { ForbiddenError } from "@/lib/errors";
import { buildPortfolio, leaveDecision, portfolioAccount } from "@/modules/portfolio/service";
import { listMyWork } from "@/modules/work/service";
import { viewAccountCounts } from "@/modules/dashboard/service";
import { actorFor, ensureSeed } from "./helpers";

describe("Etappe 33 (Use Case 5): Meine BDs – durch Kunden gehen, Entscheidung hinterlassen", () => {
  it("P01: Principal sieht Kunden je BD mit Team, Einsätzen, Chancen, Ampel; Kurzfassung mit Blättern; Hinweis wird Vorgang beim BD; Anker/BD ohne Zugriff", async () => {
    process.env.AI_PROVIDER = "test";
    resetConfigCacheForTests();
    const s = await ensureSeed();
    const petra = await actorFor("petra");
    const david = await actorFor("david");
    const { byBd, rows } = await buildPortfolio(petra);
    expect(rows.some((r) => r.accountId === s.accountId)).toBe(true);
    const row = rows.find((r) => r.accountId === s.accountId)!;
    expect(row.bdName).toMatch(/David/);
    expect(byBd.some((g) => g.rows.some((r) => r.accountId === s.accountId))).toBe(true);
    expect(["SATTELFEST", "WACKELIG", "GEFAEHRDET", "UNKLAR"]).toContain(row.health.level);
    const page = await portfolioAccount(petra, s.accountId);
    expect(page.position.total).toBe(rows.length);
    expect(page.row.accountId).toBe(s.accountId);
    await expect(buildPortfolio(await actorFor("nina"))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(buildPortfolio(david)).rejects.toBeInstanceOf(ForbiddenError);
    // Entscheidung → Vorgang beim BD, mit Kundenbezug, auf dessen Startliste
    const w = await leaveDecision(petra, s.accountId, { text: `Verlängerung UX bis Freitag klären ${Date.now()}`, dueDate: "2026-12-01", priority: "HOCH" });
    expect(w.assigneeUserId).toBe(david.userId);
    expect(w.subjectType).toBe("KUNDE");
    expect(w.subjectId).toBe(s.accountId);
    const mine = await listMyWork(david);
    expect(mine.assigned.some((x) => x.id === w.id)).toBe(true);
    const again = await portfolioAccount(petra, s.accountId);
    expect(again.hints.some((h) => h.id === w.id)).toBe(true);
    const stored = await db.query.workItems.findFirst({ where: eq(schema.workItems.id, w.id) });
    expect(stored?.priority).toBe("HOCH");
    // Sichtzähler für den Umschalter
    const counts = await viewAccountCounts(petra);
    expect(counts.find((c) => c.view === "PRINCIPAL")?.accounts).toBeGreaterThanOrEqual(1);
  });
});
