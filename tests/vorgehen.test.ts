import { describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { changeActionStatus } from "@/modules/actions/service";
import {
  addPlaybookStep,
  completeRunStep,
  createPlaybook,
  ensureDefaultPlaybooks,
  listDormantAccounts,
  listPlaybooks,
  listRuns,
  movePlaybookStep,
  pauseRun,
  playbookStats,
  reassignRunOwner,
  removePlaybookStep,
  resumeRun,
  setAccountDormant,
  skipRunStep,
  startPlaybookRun,
} from "@/modules/playbooks/service";
import { ALTKUNDEN_CODE } from "@/modules/playbooks/defaults";
import { actorFor, ensureSeed } from "./helpers";

async function runSteps(runId: string) {
  return db.query.playbookRunSteps.findMany({ where: eq(schema.playbookRunSteps.runId, runId), orderBy: [asc(schema.playbookRunSteps.position)] });
}
async function action(id: string | null) {
  return id ? db.query.actions.findFirst({ where: eq(schema.actions.id, id) }) : undefined;
}

describe("Etappe 20: Vorgehensmuster (Altkunden-Reaktivierung u. a.)", () => {
  it("legt die Standardmuster einmalig an (idempotent)", async () => {
    const s = await ensureSeed();
    const petra = await actorFor("petra");
    await ensureDefaultPlaybooks(s.workspaceId);
    await ensureDefaultPlaybooks(s.workspaceId);
    const all = await listPlaybooks(petra);
    expect(all.filter((p) => p.code === ALTKUNDEN_CODE)).toHaveLength(1);
    expect(all.map((p) => p.code).sort()).toEqual(["ALTKUNDEN_REAKTIVIERUNG", "AUSSCHREIBUNG", "ERSTGESPRAECH", "VERLAENGERUNG"]);
    const alt = all.find((p) => p.code === ALTKUNDEN_CODE)!;
    expect(alt.scope).toBe("ACCOUNT");
    expect(alt.steps.map((x) => x.position)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(alt.steps[1]!.title).toMatch(/Ergebnisrückblick/);
  });

  it("Reaktivierung: ruhender Kunde → Vorgehen mit neuem Setup, Vorhaben „Reaktivieren“, Schritt für Schritt als Aktion", async () => {
    const s = await ensureSeed();
    const petra = await actorFor("petra");
    const david = await actorFor("david");
    const lars = await actorFor("lars");
    const admin = await actorFor("admin");
    const alt = (await listPlaybooks(petra)).find((p) => p.code === ALTKUNDEN_CODE)!;

    await setAccountDormant(petra, s.accountId, true);
    expect((await listDormantAccounts(petra)).some((x) => x.account.id === s.accountId)).toBe(true);

    // Betriebsverwaltung ohne fachliche Rolle darf kein Vorgehen starten
    await expect(startPlaybookRun(admin, { playbookId: alt.id, accountId: s.accountId, newSetupName: "Reaktivierung Test" })).rejects.toBeInstanceOf(ForbiddenError);
    // Ohne Setup-Wahl und ohne Namen geht es nicht
    await expect(startPlaybookRun(petra, { playbookId: alt.id, accountId: s.accountId })).rejects.toBeInstanceOf(ValidationError);

    const run = await startPlaybookRun(petra, { playbookId: alt.id, accountId: s.accountId, newSetupName: "Reaktivierung 2026" });
    expect(run.ownerUserId).toBe(david.userId); // zuständiger BD übernimmt standardmäßig
    const account = await db.query.accounts.findFirst({ where: eq(schema.accounts.id, s.accountId) });
    expect(account?.status).toBe("ACTIVE");
    const setup = await db.query.projectSetups.findFirst({ where: eq(schema.projectSetups.id, run.setupId) });
    expect(setup?.name).toBe("Reaktivierung 2026");
    expect(setup?.bdUserId).toBe(david.userId);
    const prio = await db.query.accountPriorities.findFirst({ where: and(eq(schema.accountPriorities.accountId, s.accountId), eq(schema.accountPriorities.kind, "REAKTIVIEREN")) });
    expect(prio?.setupId).toBe(run.setupId);

    // Doppelstart am selben Setup wird verhindert
    await expect(startPlaybookRun(petra, { playbookId: alt.id, accountId: s.accountId, setupId: run.setupId })).rejects.toBeInstanceOf(ValidationError);

    let steps = await runSteps(run.id);
    expect(steps.map((x) => x.status)).toEqual(["OFFEN", "WARTET", "WARTET", "WARTET", "WARTET", "WARTET"]);
    const a1 = await action(steps[0]!.actionId);
    expect(a1?.ownerUserId).toBe(david.userId);
    expect(a1?.status).toBe("VORGESCHLAGEN"); // Petra hat vorgeschlagen, David nimmt an
    expect(a1?.title).toContain("Schritt 1/6");
    expect(a1?.dueDate).toBeTruthy();

    // Schritt 1: David erledigt die Aktion ganz normal (z. B. in „Meine Arbeit“) → Vorgehen rückt vor
    await changeActionStatus(david, a1!.id, { version: a1!.version, status: "ANGENOMMEN" });
    const a1b = await action(a1!.id);
    await changeActionStatus(david, a1!.id, { version: a1b!.version, status: "ERLEDIGT", result: "Frau Keller ist noch da, neuer Bereichsleiter Einkauf." });
    steps = await runSteps(run.id);
    expect(steps[0]!.status).toBe("ERLEDIGT");
    expect(steps[0]!.result).toMatch(/Frau Keller/);
    expect(steps[1]!.status).toBe("OFFEN");

    // Schritt 2: ohne Ergebnis nicht erledigbar; Petra überspringt begründet
    await expect(completeRunStep(david, steps[1]!.id, { result: "" })).rejects.toBeInstanceOf(ValidationError);
    await skipRunStep(petra, steps[1]!.id, { reason: "Referenz liegt aus 2025 bereits vor." });
    steps = await runSteps(run.id);
    expect(steps[1]!.status).toBe("UEBERSPRUNGEN");
    expect((await action(steps[1]!.actionId))?.status).toBe("VERWORFEN");
    expect(steps[2]!.status).toBe("OFFEN");

    // Delegation: Petra stellt die Verantwortung auf Lars um – der offene Schritt wandert mit
    const r1 = (await db.query.playbookRuns.findFirst({ where: eq(schema.playbookRuns.id, run.id) }))!;
    await reassignRunOwner(petra, run.id, { version: r1.version, ownerUserId: lars.userId });
    steps = await runSteps(run.id);
    const a3 = await action(steps[2]!.actionId);
    expect(a3?.ownerUserId).toBe(lars.userId);
    expect(a3?.status).toBe("VORGESCHLAGEN");

    // Zurückstellen und wieder aufnehmen: offener Schritt wird neu als Aktion angelegt
    const r2 = (await db.query.playbookRuns.findFirst({ where: eq(schema.playbookRuns.id, run.id) }))!;
    await pauseRun(petra, run.id, { version: r2.version, reason: "Kunde im Umbau, Wiedervorlage im Frühjahr." });
    steps = await runSteps(run.id);
    expect(steps[2]!.status).toBe("WARTET");
    expect((await action(a3!.id))?.status).toBe("VERWORFEN");
    const r3 = (await db.query.playbookRuns.findFirst({ where: eq(schema.playbookRuns.id, run.id) }))!;
    expect(r3.status).toBe("ZURUECKGESTELLT");
    await resumeRun(petra, run.id, { version: r3.version });
    steps = await runSteps(run.id);
    expect(steps[2]!.status).toBe("OFFEN");
    expect(steps[2]!.actionId).not.toBe(a3!.id);

    // Restliche Schritte direkt im Vorgehen erledigen → abgeschlossen
    for (let i = 2; i < 6; i++) {
      steps = await runSteps(run.id);
      await completeRunStep(lars, steps[i]!.id, { result: `Ergebnis Schritt ${i + 1} dokumentiert.` });
    }
    const done = (await db.query.playbookRuns.findFirst({ where: eq(schema.playbookRuns.id, run.id) }))!;
    expect(done.status).toBe("ABGESCHLOSSEN");

    const views = await listRuns(petra, { accountId: s.accountId });
    expect(views.find((v) => v.id === run.id)?.steps).toHaveLength(6);
    const stats = (await playbookStats(petra)).get(alt.id)!;
    expect(stats.runs.ABGESCHLOSSEN).toBe(1);
    expect(stats.steps.get(2)?.uebersprungen).toBe(1);
  });

  it("Muster pflegen nur Principal/CEO/Verwaltung; Schritte ergänzen, verschieben, entfernen", async () => {
    const david = await actorFor("david");
    const petra = await actorFor("petra");
    await expect(createPlaybook(david, { name: "Mein Muster", scope: "SETUP" })).rejects.toBeInstanceOf(ForbiddenError);
    const p = await createPlaybook(petra, { name: "Konferenz-Nachfassen", scope: "SETUP", description: "Nach Messen und Konferenzen" });
    const s1 = await addPlaybookStep(petra, p.id, { title: "Kontakte sichten", dueInDays: "3" });
    const s2 = await addPlaybookStep(petra, p.id, { title: "Nachfassen per Mail", meddpicc: "Champion" });
    await movePlaybookStep(petra, s2.id, "up");
    let mine = (await listPlaybooks(petra)).find((x) => x.id === p.id)!;
    expect(mine.steps.map((x) => x.title)).toEqual(["Nachfassen per Mail", "Kontakte sichten"]);
    await removePlaybookStep(petra, s2.id);
    mine = (await listPlaybooks(petra)).find((x) => x.id === p.id)!;
    expect(mine.steps.map((x) => [x.position, x.id])).toEqual([[1, s1.id]]);
  });
});
