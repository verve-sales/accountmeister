import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { getAccount, reassignAccountBd } from "@/modules/accounts/service";
import { addMember, getSetupDetail, reassignSetupBd, removeMember } from "@/modules/setups/service";
import { createOpportunity, getOpportunityDetail, reassignOpportunityOwner } from "@/modules/opportunities/service";
import { canReassignResponsibility } from "@/modules/identity/authz";
import { actorFor, ensureSeed } from "./helpers";

/**
 * Delegation (Briefing-Nachtrag, Etappe 19): "als zugeordneter Principal möchte ich den BD-Manager und
 * Anker jederzeit in der Kunden/Setup/Chance-Seite umstellen können" – bislang unmöglich (responsibleBdUserId
 * und bdUserId waren nur bei Anlage setzbar, Anker-Umstellung war an canEditSetup gebunden, das Principal
 * grundsätzlich nicht erfüllt). Diese Tests decken die neue, schmale Umstellungsberechtigung ab.
 */
describe("Etappe 19: Delegation – Principal stellt BD/Anker/Verantwortlichkeit um", () => {
  it("Principal (workspace-weit) darf die Kundenzuständigkeit umstellen; der neue BD erhält automatisch die kundenbezogene Rolle", async () => {
    const s = await ensureSeed();
    const petra = await actorFor("petra");
    const lars = await actorFor("lars");
    expect(canReassignResponsibility(petra, await getAccount(petra, s.accountId))).toBe(true);

    const before = await getAccount(petra, s.accountId);
    expect(before.responsibleBdUserId).toBe(s.users.david);

    const updated = await reassignAccountBd(petra, s.accountId, { version: before.version, responsibleBdUserId: s.users.lars });
    expect(updated.responsibleBdUserId).toBe(s.users.lars);

    const larsBdRole = await db.query.roleAssignments.findFirst({
      where: and(eq(schema.roleAssignments.userId, s.users.lars), eq(schema.roleAssignments.role, "BD"), eq(schema.roleAssignments.accountId, s.accountId)),
    });
    expect(larsBdRole).toBeTruthy();

    // Bereits zuständige Person erneut zuweisen ist kein sinnvoller Vorgang
    const after = await getAccount(petra, s.accountId);
    await expect(reassignAccountBd(petra, s.accountId, { version: after.version, responsibleBdUserId: s.users.lars })).rejects.toBeInstanceOf(ValidationError);

    // zurücksetzen für nachfolgende Tests
    const afterReset = await getAccount(petra, s.accountId);
    await reassignAccountBd(petra, s.accountId, { version: afterReset.version, responsibleBdUserId: s.users.david });

    // Ein fremder BD (nur auf einem anderen Kunden zuständig) darf hier nichts umstellen
    await expect(reassignAccountBd(lars, s.accountId, { version: (await getAccount(petra, s.accountId)).version, responsibleBdUserId: s.users.lars })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("Principal darf die Setup-Zuständigkeit (BD) sowie Anker-Beteiligungen jederzeit umstellen, ohne selbst Mitglied zu sein", async () => {
    const s = await ensureSeed();
    const petra = await actorFor("petra");
    const nina = await actorFor("nina");

    const before = await getSetupDetail(petra, s.setupId);
    expect(before.setup.bdUserId).toBe(s.users.david);
    expect(before.canEdit).toBe(false); // Principal ist heute weiterhin nicht pauschal bearbeitend beteiligt

    const updatedSetup = await reassignSetupBd(petra, s.setupId, { version: before.setup.version, bdUserId: s.users.lars });
    expect(updatedSetup.bdUserId).toBe(s.users.lars);
    const memberships = await db.query.setupMemberships.findMany({ where: eq(schema.setupMemberships.setupId, s.setupId) });
    expect(memberships.some((m) => m.userId === s.users.lars && m.contribution === "BD_ZUSTAENDIG")).toBe(true);

    // Anker umstellen: Nina wird auf einen anderen Beitrag umgestellt (Upsert über addMember, jetzt auch für Principal erlaubt)
    await addMember(petra, s.setupId, { userId: nina.userId, contribution: "ANKER_RUECKFRAGEN" });
    const afterAnker = await db.query.setupMemberships.findFirst({ where: and(eq(schema.setupMemberships.setupId, s.setupId), eq(schema.setupMemberships.userId, nina.userId)) });
    expect(afterAnker?.contribution).toBe("ANKER_RUECKFRAGEN");

    // Entfernen einer Beteiligung
    await removeMember(petra, s.setupId, nina.userId);
    const removed = await db.query.setupMemberships.findFirst({ where: and(eq(schema.setupMemberships.setupId, s.setupId), eq(schema.setupMemberships.userId, nina.userId)) });
    expect(removed).toBeUndefined();

    // zurücksetzen: BD wieder David, Nina wieder Anker (Kontext)
    const afterReset = await getSetupDetail(petra, s.setupId);
    await reassignSetupBd(petra, s.setupId, { version: afterReset.setup.version, bdUserId: s.users.david });
    await addMember(petra, s.setupId, { userId: nina.userId, contribution: "ANKER_KONTEXT" });
  });

  it("Principal darf die Verantwortlichkeit einer Chance umstellen, ohne dadurch Titel/Beschreibung ändern zu dürfen", async () => {
    const s = await ensureSeed();
    const david = await actorFor("david");
    const petra = await actorFor("petra");
    const opp = await createOpportunity(david, {
      setupId: s.setupId,
      title: `Delegationstest ${Date.now().toString(36)}`,
      needDescription: "Der Kunde möchte die Testkoordination im Migrationsteam verstärken.",
    });
    expect(opp.ownerUserId).toBe(david.userId);

    const updated = await reassignOpportunityOwner(petra, opp.id, { version: opp.version, ownerUserId: (await actorFor("nina")).userId });
    expect(updated.ownerUserId).toBe((await actorFor("nina")).userId);

    // Principal darf laut canEditSetup weiterhin nicht die übrigen Felder der Chance bearbeiten
    const detail = await getOpportunityDetail(petra, opp.id);
    expect(detail.canEdit).toBe(false);
  });

  it("Ohne Principal/CEO/zuständige BD-Rolle bleibt eine Umstellung verboten (kein pauschales Umstellungsrecht)", async () => {
    const s = await ensureSeed();
    const nina = await actorFor("nina"); // Anker, keine Führungsrolle
    const account = await getAccount(await actorFor("petra"), s.accountId);
    expect(canReassignResponsibility(nina, account)).toBe(false);
    await expect(reassignAccountBd(nina, s.accountId, { version: account.version, responsibleBdUserId: nina.userId })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(reassignSetupBd(nina, s.setupId, { version: (await getSetupDetail(await actorFor("petra"), s.setupId)).setup.version, bdUserId: nina.userId })).rejects.toBeInstanceOf(ForbiddenError);
  });
});
