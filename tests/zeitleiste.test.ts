import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { createAction, listMyOpenActions, planAction } from "@/modules/actions/service";
import { plusDaysIso, todayIso } from "@/modules/work/calendar";
import { actorFor, ensureSeed } from "./helpers";

describe("e50: Aufgaben mit Datum und Priorität", () => {
  it("Z01: jede neue Aufgabe hat ein Datum (Standard in einer Woche) und eine Priorität; Datum/Priorität lassen sich ändern; hohe Priorität zuerst", async () => {
    const s = await ensureSeed();
    const david = await actorFor("david");
    const a = await createAction(david, { setupId: s.setupId, title: `Z01 ohne Datum ${Date.now()}`, ownerUserId: david.userId });
    expect(a.dueDate).toBe(plusDaysIso(todayIso(), 7));
    expect(a.priority).toBe("NORMAL");
    const b = await createAction(david, { setupId: s.setupId, title: `Z01 dringend ${Date.now()}`, ownerUserId: david.userId, dueDate: plusDaysIso(todayIso(), 20), priority: "HOCH" });
    expect(b.priority).toBe("HOCH");
    await planAction(david, a.id, { dueDate: plusDaysIso(todayIso(), 2), priority: "NIEDRIG" });
    expect((await db.query.actions.findFirst({ where: eq(schema.actions.id, a.id) }))).toMatchObject({ dueDate: plusDaysIso(todayIso(), 2), priority: "NIEDRIG" });
    const mine = await listMyOpenActions(david);
    expect(mine.findIndex((x) => x.id === b.id)).toBeLessThan(mine.findIndex((x) => x.id === a.id));
    await expect(planAction(david, a.id, { dueDate: "", priority: "HOCH" })).rejects.toThrow(/Datum/);
    await expect(planAction(await actorFor("lars"), a.id, { dueDate: todayIso(), priority: "HOCH" })).rejects.toThrow();
  });

  it("Z02: Team-Sicht je Rolle – GF sieht alle offenen Aufgaben mit Namen, BD nicht", async () => {
    const s = await ensureSeed();
    const david = await actorFor("david");
    const ceo = await actorFor("clemens");
    const { canSeeTeamTimeline, teamTimeline } = await import("@/modules/tasks/timeline");
    const a = await createAction(david, { setupId: s.setupId, title: `Z02 Team ${Date.now()}`, ownerUserId: david.userId, priority: "HOCH" });
    expect(canSeeTeamTimeline(david, "BD")).toBe(false);
    expect(await teamTimeline(david, "BD")).toEqual([]);
    expect(canSeeTeamTimeline(ceo, "CEO")).toBe(true);
    const t = (await teamTimeline(ceo, "CEO")).find((x) => x.key === `a-${a.id}`)!;
    expect(t).toMatchObject({ priority: "HOCH", kind: "AUFGABE" });
    expect(t.context).toMatch(/David Demo/);
  });
});
