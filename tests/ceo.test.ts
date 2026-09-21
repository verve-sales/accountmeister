import { describe, expect, it } from "vitest";
import { db, schema } from "@/db/client";
import { ForbiddenError } from "@/lib/errors";
import { buildCeoDashboard, buildCeoAccountDetail } from "@/modules/ceo/service";
import { createAccountGoal } from "@/modules/leadership/service";
import { createOpportunity } from "@/modules/opportunities/service";
import { captureObservation } from "@/modules/signals/service";
import { createAction, changeActionStatus } from "@/modules/actions/service";
import { createAccount } from "@/modules/accounts/service";
import { createSetup } from "@/modules/setups/service";
import { actorFor, ensureSeed } from "./helpers";

async function freshAccount(name: string) {
  const david = await actorFor("david");
  const nina = await actorFor("nina");
  const account = await createAccount(david, { name: `${name} ${Date.now().toString(36)} (fiktiv)`, responsibleBdUserId: david.userId });
  const setup = await createSetup(david, { accountId: account.id, name: `${name}-Setup`, contextNote: "Kontext", bdUserId: david.userId });
  await db.insert(schema.setupMemberships).values({ setupId: setup.id, userId: nina.userId, contribution: "ANKER_KONTEXT", canEdit: true });
  return { david, nina, account, setup };
}

describe("Etappe 13: CEO-Dashboard", () => {
  it("nur die Rolle CEO sieht das Gesamtbild", async () => {
    await ensureSeed();
    const david = await actorFor("david");
    const petra = await actorFor("petra");
    await expect(buildCeoDashboard(david)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(buildCeoDashboard(petra)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("verknüpft Accountziel gegen Ist-Stand, Top-Chancen und Zusammenarbeit der letzten Woche je Kunde", async () => {
    const { david, nina, account, setup } = await freshAccount("CEO-Test");
    const petra = await actorFor("petra");
    const clemens = await actorFor("clemens");

    // Ist-Stand: eine dokumentierte Chance mit 2 Positionen in Solution-Architektur
    await createOpportunity(david, { setupId: setup.id, title: "CEO-Test: Architektur-Unterstützung", needDescription: "Kunde sucht Unterstützung in der Zielarchitektur.", roleFamily: "SOLUTION_ARCHITEKTUR", headcount: 2, anticipated: false });

    // Accountziel: 3 Positionen in Solution-Architektur
    const goal = await createAccountGoal(petra, { accountId: account.id, title: "CEO-Test: Ausbau Solution-Architektur", desiredOutcome: "Kapazität in der Zielarchitektur ausbauen.", roleFamily: "SOLUTION_ARCHITEKTUR", targetHeadcount: 3 });

    // Zusammenarbeit: Anker erfasst eine Beobachtung, BD erledigt eine Aktion
    await captureObservation(nina, { setupId: setup.id, observation: "CEO-Test: Beobachtung für die Zusammenarbeit." });
    const action = await createAction(david, { setupId: setup.id, title: "CEO-Test: Aktion", ownerUserId: david.userId, agreedInConversation: "true" });
    await changeActionStatus(david, action.id, { version: action.version, status: "ERLEDIGT", result: "Erledigt." });

    const dashboard = await buildCeoDashboard(clemens, { days: 7 });
    const row = dashboard.accounts.find((a) => a.accountId === account.id);
    expect(row).toBeTruthy();
    expect(row!.accountName).toBe(account.name);

    // Ziel vs. Ist-Stand: 2 von 3 dokumentierten Positionen, nicht erfunden
    const goalRow = row!.goals.find((g) => g.id === goal.id);
    expect(goalRow).toBeTruthy();
    expect(goalRow!.targetHeadcount).toBe(3);
    expect(goalRow!.currentHeadcount).toBe(2);
    expect(goalRow!.roleFamilyLabel).toBeTruthy();

    // Top-Chancen enthalten die angelegte Chance
    expect(row!.topOpportunities.some((o) => o.title === "CEO-Test: Architektur-Unterstützung")).toBe(true);

    // Zusammenarbeit: beide Rollen mit dokumentierter Aktivität
    expect(row!.activity.byRole.ANKER.beobachtungenErfasst).toBe(1);
    expect(row!.activity.byRole.BD.aktionenErfasstOderErledigt).toBe(1);
    expect(row!.activity.activeRoles.slice().sort()).toEqual(["ANKER", "BD"]);
    expect(row!.activity.coefficient).toBeGreaterThan(0);

    // Detailansicht für genau diesen Kunden liefert denselben Stand
    const detail = await buildCeoAccountDetail(clemens, account.id, { days: 7 });
    expect(detail.accountId).toBe(account.id);
    expect(detail.activity.coefficient).toBe(row!.activity.coefficient);
  });

  it("Accountziel ohne dokumentierte Positionen zeigt ehrlich 0 von N, keine erfundene Zahl", async () => {
    const { account } = await freshAccount("CEO-Nullstand-Test");
    const petra = await actorFor("petra");
    const clemens = await actorFor("clemens");
    const goal = await createAccountGoal(petra, { accountId: account.id, title: "CEO-Nullstand-Test: Ziel ohne Ist-Stand", desiredOutcome: "Noch keine Positionen dokumentiert.", roleFamily: "TEST_QS", targetHeadcount: 4 });

    const dashboard = await buildCeoDashboard(clemens, { days: 7 });
    const row = dashboard.accounts.find((a) => a.accountId === account.id)!;
    const goalRow = row.goals.find((g) => g.id === goal.id)!;
    expect(goalRow.currentHeadcount).toBe(0);
    expect(goalRow.targetHeadcount).toBe(4);
    expect(row.topOpportunities).toEqual([]);
  });
});
