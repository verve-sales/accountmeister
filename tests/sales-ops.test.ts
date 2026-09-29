import { describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { loadActor, type Actor } from "@/modules/identity/actor";
import { canEditSetup, canViewSetup, canViewSource, loadSetupContext } from "@/modules/identity/authz";
import { assignRole } from "@/modules/governance/service";
import { changeOpportunityStatus, confirmOpportunity, createOpportunity, reassignOpportunityOwner } from "@/modules/opportunities/service";
import { reassignSetupBd } from "@/modules/setups/service";
import { createPerson } from "@/modules/people/service";
import { createSupportRequest } from "@/modules/leadership/service";
import { availableViews } from "@/modules/dashboard/service";
import { completeRunStep, listPlaybooks, reassignRunOwner, startPlaybookRun } from "@/modules/playbooks/service";
import { ALTKUNDEN_CODE } from "@/modules/playbooks/defaults";
import { actorFor, ensureSeed } from "./helpers";

async function makeSalesOps(): Promise<Actor> {
  const s = await ensureSeed();
  const [u] = await db.insert(schema.users).values({ workspaceId: s.workspaceId, email: `ops-${Date.now().toString(36)}@verve.example`, displayName: "Sofia Ops (Sales Operations)" }).returning();
  const admin = await actorFor("admin");
  await assignRole(admin, { userId: u!.id, role: "SALES_OPS" });
  return (await loadActor(u!.id))!;
}

describe("Etappe 22: Sales Operations – vorbereiten, pflegen, nachhalten; entscheiden bleibt beim BD", () => {
  it("nur arbeitsraumweit vergebbar; sieht und bearbeitet Setups, pflegt Personen, eigene Startsicht", async () => {
    const s = await ensureSeed();
    const admin = await actorFor("admin");
    const ops = await makeSalesOps();
    await expect(assignRole(admin, { userId: ops.userId, role: "SALES_OPS", accountId: s.accountId })).rejects.toBeInstanceOf(ValidationError);
    const ctx = (await loadSetupContext(ops, s.setupId))!;
    expect(canViewSetup(ops, ctx)).toBe(true);
    expect(canEditSetup(ops, ctx)).toBe(true);
    const src = await db.query.sources.findFirst({ where: eq(schema.sources.setupId, s.setupId) });
    if (src && src.accessClass === "SETUP" && !src.isLocked) expect(canViewSource(ops, src, ctx)).toBe(true);
    const person = await createPerson(ops, { accountId: s.accountId, displayName: "Herr Neumann (fiktiv)", functionTitle: "Einkauf" });
    expect(person.id).toBeTruthy();
    expect(await availableViews(ops)).toEqual(["SALES_OPS"]);
  });

  it("legt Chancen an (Verantwortung beim BD), darf aber weder bestätigen noch Status setzen noch Verantwortung übernehmen", async () => {
    const s = await ensureSeed();
    const ops = await makeSalesOps();
    const petra = await actorFor("petra");
    const opp = await createOpportunity(ops, { setupId: s.setupId, title: "Weitere Testerin", needDescription: "Aus dem Protokoll: zusätzliche Testerin im Migrationsteam gesucht." });
    expect(opp.ownerUserId).toBe(s.users.david);
    await expect(confirmOpportunity(ops, opp.id, { version: opp.version, evidenceText: "Frau Keller hat es bestätigt, Mail vom 1.10." })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(changeOpportunityStatus(ops, opp.id, { version: opp.version, status: "BEENDET", reason: "passt nicht" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(reassignOpportunityOwner(petra, opp.id, { version: opp.version, ownerUserId: ops.userId })).rejects.toBeInstanceOf(ValidationError);
    const setup = await db.query.projectSetups.findFirst({ where: eq(schema.projectSetups.id, s.setupId) });
    await expect(reassignSetupBd(petra, s.setupId, { version: setup!.version, bdUserId: ops.userId })).rejects.toBeInstanceOf(ValidationError);
  });

  it("Vorgehen: Vorbereitungsschritte landen bei Sales Operations, Gesprächsschritte beim BD", async () => {
    const s = await ensureSeed();
    const petra = await actorFor("petra");
    const lars = await actorFor("lars");
    // eindeutig zuordnen: genau diese Person als Sales Operations wählen
    const ops = await makeSalesOps();
    const alt = (await listPlaybooks(petra)).find((p) => p.code === ALTKUNDEN_CODE)!;
    expect(alt.steps[0]!.assignee).toBe("SALES_OPS");
    const run = await startPlaybookRun(petra, { playbookId: alt.id, accountId: s.accountId, newSetupName: `Reaktivierung Ops ${Date.now().toString(36)}`, salesOpsUserId: ops.userId });
    expect(run.salesOpsUserId).toBe(ops.userId);
    const steps = () => db.query.playbookRunSteps.findMany({ where: eq(schema.playbookRunSteps.runId, run.id), orderBy: [asc(schema.playbookRunSteps.position)] });
    const a1 = await db.query.actions.findFirst({ where: eq(schema.actions.id, (await steps())[0]!.actionId!) });
    expect(a1?.ownerUserId).toBe(ops.userId);

    // Verantwortung umstellen verschiebt den Vorbereitungsschritt nicht
    await reassignRunOwner(petra, run.id, { version: run.version, ownerUserId: lars.userId });
    expect((await db.query.actions.findFirst({ where: eq(schema.actions.id, a1!.id) }))?.ownerUserId).toBe(ops.userId);

    // Sales Operations erledigt die Vorbereitung → nächster Schritt geht an die verantwortliche Person
    await completeRunStep(ops, (await steps())[0]!.id, { result: "Recherche aktualisiert; Frau Keller weiter da, Anlass: Plattform-Umbau." });
    const a2 = await db.query.actions.findFirst({ where: eq(schema.actions.id, (await steps())[1]!.actionId!) });
    expect(a2?.ownerUserId).toBe(lars.userId);
  });

  it("Unterstützungsaufträge gehen auch an Sales Operations – an einen BD weiterhin nicht", async () => {
    const s = await ensureSeed();
    const david = await actorFor("david");
    const ops = await makeSalesOps();
    const r = await createSupportRequest(david, { addresseeUserId: ops.userId, setupId: s.setupId, task: "Einseiter zum früheren Projekt bis Freitag vorbereiten" });
    expect(r.addresseeUserId).toBe(ops.userId);
    await expect(createSupportRequest(david, { addresseeUserId: s.users.lars, setupId: s.setupId, task: "Bitte Profil prüfen und rückmelden" })).rejects.toBeInstanceOf(ValidationError);
  });
});
