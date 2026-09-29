/**
 * Datenstand für die Erklärvideos (nur fiktive Daten). Läuft auf einer eigenen Datenbank:
 *   DATABASE_URL=postgresql://postgres@localhost:5432/verve_video npx tsx docs/video/video-seed.ts
 * Voraussetzung: Datenbank leer und migriert (siehe docs/video/README.md).
 */
import "dotenv/config";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { seed } from "@/db/seed";
import { loadActor } from "@/modules/identity/actor";
import { createAccount } from "@/modules/accounts/service";
import { addMember, createSetup } from "@/modules/setups/service";
import { confirmOpportunity, createOpportunity, changeOpportunityStatus } from "@/modules/opportunities/service";
import { captureObservation } from "@/modules/signals/service";
import { createAction } from "@/modules/actions/service";
import { recordExistingEngagement, saveHealthAnswer } from "@/modules/health/service";
import { completeRunStep, listPlaybooks, setAccountDormant, startPlaybookRun } from "@/modules/playbooks/service";
import { createReview } from "@/modules/reviews/service";
import { createSos } from "@/modules/sos/service";
import { changeGoalStatus, createAccountGoal, createLeadershipReview } from "@/modules/leadership/service";

const iso = (days: number) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

async function main() {
  const s = await seed(db);
  const ws = await db.query.workspaces.findFirst();
  if (!ws) throw new Error("Arbeitsraum fehlt");

  // Sales Operations (fiktiv)
  let sara = await db.query.users.findFirst({ where: eq(schema.users.email, "sara.demo@verve.example") });
  if (!sara) {
    [sara] = await db.insert(schema.users).values({ workspaceId: ws.id, email: "sara.demo@verve.example", displayName: "Sara Demo (Sales Operations)" }).returning();
    await db.insert(schema.roleAssignments).values({ workspaceId: ws.id, userId: sara!.id, role: "SALES_OPS" });
  }
  const david = (await loadActor(s.users.david))!;
  const petra = (await loadActor(s.users.petra))!;
  const nina = (await loadActor(s.users.nina))!;

  // Laufende Einsätze im Plattformteam (einer läuft in 7 Wochen aus → Verlängerungsregel)
  await recordExistingEngagement(david, s.accountId, { setupId: s.setupId, title: "Plattform-Engineering", kind: "VERVE_EXPERTE", headcount: 1, plannedStart: "2026-04-01", plannedEnd: "2027-03-31", evidenceText: "Demo-Bestellung Einsatz A, Laufzeit bis 31.03.2027 (fiktiv)." });
  await recordExistingEngagement(david, s.accountId, { setupId: s.setupId, title: "Testautomatisierung", kind: "VERVE_EXPERTE", headcount: 1, plannedStart: "2026-05-01", plannedEnd: iso(49), evidenceText: "Demo-Bestellung Einsatz B, Laufzeit bis Ende November (fiktiv)." });

  // Zweites Setup: Migrationsteam
  const mig = await createSetup(david, { accountId: s.accountId, name: "Migrationsteam", contextNote: "Das Migrationsteam zieht bis Mitte 2027 die Altanwendungen auf die neue Plattform um. Ansprechpartnerin ist Frau Brandt.", bdUserId: david.userId });
  await addMember(david, mig.id, { userId: nina.userId, contribution: "ANKER_KONTEXT", contributionNote: "Kennt das Team aus dem Plattform-Einsatz." });

  const tm = await createOpportunity(david, { setupId: mig.id, title: "Testmanagement für die Migration", needDescription: "Das Migrationsteam braucht ab Januar eine erfahrene Testmanagerin, die Abnahmetests über alle Wellen koordiniert.", kind: "VERVE_EXPERTE", roleName: "Test Management", headcount: 1, horizon: "Q1 2027", anticipated: true });
  const arch = await createOpportunity(david, { setupId: mig.id, title: "Cloud-Integrationsarchitektur (Freelancer)", needDescription: "Für die Schnittstellen zur neuen Plattform fehlt Spezialwissen in Cloud-Integration.", kind: "FREELANCER_EXPERTE", roleName: "Integrationsarchitektur", headcount: 1, horizon: "Q2 2027", anticipated: true });
  await changeOpportunityStatus(david, arch.id, { version: arch.version, status: "IN_KLAERUNG" });

  // Ausschreibung (bestätigt) mit Vorgehen „Ausschreibung bearbeiten“ – Vorbereitung bei Sales Operations
  const rv0 = await createOpportunity(david, { setupId: s.setupId, title: "Rahmenvertrag IT-Dienstleistungen 2027", needDescription: "Der Konzerneinkauf schreibt den Rahmenvertrag für IT-Dienstleistungen ab 2027 neu aus.", kind: "AUSSCHREIBUNG", horizon: "Q4 2026" });
  const rv = await confirmOpportunity(david, rv0.id, { version: rv0.version, evidenceText: "Ausschreibungsunterlagen am 22.09. vom Konzerneinkauf erhalten (fiktiv)." });
  const pbs = await listPlaybooks(david, { activeOnly: true });
  const tender = pbs.find((p) => p.name === "Ausschreibung bearbeiten");
  if (tender) {
    await startPlaybookRun(david, { playbookId: tender.id, opportunityId: rv.id, salesOpsUserId: sara!.id });
    // Go/No-Go ist entschieden → der nächste Schritt (Bieterfragen) liegt bei Sales Operations
    const run = await db.query.playbookRuns.findFirst({ where: eq(schema.playbookRuns.opportunityId, rv.id) });
    const first = run && (await db.query.playbookRunSteps.findFirst({ where: and(eq(schema.playbookRunSteps.runId, run.id), eq(schema.playbookRunSteps.position, 1)) }));
    if (first) await completeRunStep(david, first.id, { result: "Go: Anforderungen passen zu unseren Standardrollen, Zuschlag nach Qualität (fiktiv)." });
  }

  // Beobachtungen und Aktionen
  await captureObservation(nina, { setupId: mig.id, observation: "Frau Brandt sagte im Jour fixe, dass die erste Migrationswelle im Januar startet und das Testen bisher niemand koordiniert.", relevanceHypothesis: "Passt zur Chance Testmanagement.", sourceTitle: "Jour fixe Migrationsteam (fiktiv)" });
  await createAction(david, { setupId: mig.id, title: "Frau Brandt Profilvorschlag Testmanagement ankündigen", ownerUserId: david.userId, dueDate: iso(5), agreedInConversation: "true", opportunityId: tm.id });
  await createAction(david, { setupId: s.setupId, title: "Verlängerung Testautomatisierung mit Frau Keller besprechen", ownerUserId: david.userId, dueDate: iso(9), agreedInConversation: "true" });

  // Health-Check: Zufriedenheit bekannt, Listung/Risiken fehlen noch → Hinweis auf der Startseite
  await saveHealthAnswer(david, s.accountId, { key: "FEEDBACK", tone: "POSITIV", date: iso(-20), note: "Frau Keller lobt die Testautomatisierung im Lenkungskreis." });

  // Weekly für das Plattformteam
  await createReview(david, { setupId: s.setupId, scheduledFor: iso(3), participantIds: [nina.userId] });

  // Ruhender Altkunde (Principal)
  const alt = await createAccount(david, { name: "Stadtwerke Nordhafen (fiktiv)", orgType: "KONZERN", responsibleBdUserId: david.userId });
  await createSetup(david, { accountId: alt.id, name: "Netzleitstelle", contextNote: "Früherer Einsatz im Projektmanagement bis 2024.", bdUserId: david.userId });
  await setAccountDormant(petra, alt.id, true);

  // Accountziel (Principal) und Zielgespräch CEO/Principal – für das CEO-Video
  const goal = await createAccountGoal(petra, { accountId: s.accountId, title: "Solution-Architektur beim Beispielkonzern ausbauen", desiredOutcome: "Drei Architekturrollen im Konzern besetzt, davon mindestens eine über Freelancer.", roleFamily: "SOLUTION_ARCHITEKTUR", targetHeadcount: 3, horizon: "Q4 2027", successCriterion: "Drei beauftragte Positionen in der Rollenfamilie Solution & Architektur." });
  const clemens = (await loadActor(s.users.clemens))!;
  for (const who of [petra, clemens]) {
    const g = await db.query.goals.findFirst({ where: eq(schema.goals.id, goal.id) });
    await changeGoalStatus(who, goal.id, { version: g!.version, status: "VEREINBART" }); // Principal und CEO stimmen zu
  }
  await createLeadershipReview(clemens, { type: "CEO_PRINCIPAL_ZIELGESPRAECH", scheduledFor: iso(6), participantIds: [petra.userId] });

  // Offenes SOS (Anker) – für das Werbevideo
  await createSos(nina, { accountId: s.accountId, setupId: s.setupId, kind: "EINSATZ_LAEUFT_AUS", title: "Testautomatisierung endet im November", situation: "Der Einsatz endet in sieben Wochen, Frau Keller hat sich zur Verlängerung noch nicht geäußert.", need: "BD soll das Verlängerungsgespräch vorziehen" });

  console.log("Video-Datenstand angelegt.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
