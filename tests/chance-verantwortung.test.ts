import { describe, expect, it } from "vitest";
import { getAccount } from "@/modules/accounts/service";
import { canEditSetup, canViewSetup, loadSetupContext } from "@/modules/identity/authz";
import { createOpportunity, getOpportunityDetail, reassignOpportunityOwner } from "@/modules/opportunities/service";
import { listMySetups } from "@/modules/setups/service";
import { listPlaybooks, listRuns, startPlaybookRun } from "@/modules/playbooks/service";
import { actorFor, ensureSeed } from "./helpers";

describe("Etappe 21b: Verantwortlich für eine Chance = bearbeitend beteiligt; passende Vorgehen auf der Chance", () => {
  it("wer eine Chance übernimmt, darf das Setup sehen und bearbeiten – ohne ausdrückliche Beteiligung", async () => {
    const s = await ensureSeed();
    const david = await actorFor("david");
    const petra = await actorFor("petra");
    const lars = await actorFor("lars"); // BD eines anderen Kunden, im Setup nicht beteiligt
    const before = await loadSetupContext(lars, s.setupId);
    expect(before && canViewSetup(lars, before)).toBe(false);

    const opp = await createOpportunity(david, { setupId: s.setupId, title: "Verlängerung manuelles Testing", needDescription: "Mögliche Fortsetzung des bestehenden manuellen Testeinsatzes im Projekt." });
    await reassignOpportunityOwner(petra, opp.id, { version: opp.version, ownerUserId: lars.userId });

    const after = await loadSetupContext(lars, s.setupId);
    expect(after!.ownsOpportunity).toBe(true);
    expect(canViewSetup(lars, after!)).toBe(true);
    expect(canEditSetup(lars, after!)).toBe(true);
    expect((await getOpportunityDetail(lars, opp.id)).canEdit).toBe(true);
    expect((await listMySetups(lars)).some((x) => x.id === s.setupId)).toBe(true);
    expect((await getAccount(lars, s.accountId)).id).toBe(s.accountId);
  });

  it("Setup-Muster (Verlängerung) lässt sich von der Chance aus starten und hängt an ihr", async () => {
    const s = await ensureSeed();
    const david = await actorFor("david");
    const opp = await createOpportunity(david, { setupId: s.setupId, title: "Verlängerung Testkoordination", needDescription: "Fortsetzung des laufenden Einsatzes im nächsten Jahr." });
    const verl = (await listPlaybooks(david, { scope: "SETUP" })).find((p) => p.code === "VERLAENGERUNG")!;
    const run = await startPlaybookRun(david, { playbookId: verl.id, setupId: s.setupId, opportunityId: opp.id });
    expect(run.opportunityId).toBe(opp.id);
    const onChance = await listRuns(david, { opportunityId: opp.id });
    expect(onChance.map((r) => r.id)).toContain(run.id);
    expect(onChance.find((r) => r.id === run.id)?.opportunityTitle).toBe("Verlängerung Testkoordination");
    await expect(startPlaybookRun(david, { playbookId: verl.id, setupId: s.otherAccountId, opportunityId: opp.id })).rejects.toThrow();
  });
});
