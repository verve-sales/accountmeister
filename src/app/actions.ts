"use server";

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { DomainError } from "@/lib/errors";
import { getCurrentActor, getSession, touchSession } from "@/modules/identity/session";
import { headers } from "next/headers";
import { checkRateLimit, LIMITS } from "@/lib/ratelimit";
import { resolveDevLoginUser } from "@/modules/identity/dev-login";
import type { Actor } from "@/modules/identity/actor";
import { createSetup, updateSetup, addMember, removeMember, reassignSetupBd } from "@/modules/setups/service";
import { captureObservation, changeSignalStatus, takeOverSignal } from "@/modules/signals/service";
import { createHandover, respondToHandover } from "@/modules/handovers/service";
import { changeActionStatus, createAction } from "@/modules/actions/service";
import { createAccount, reassignAccountBd } from "@/modules/accounts/service";
import { proposeStepDrafts } from "@/modules/playbooks/assistant";
import { updateFocus } from "@/modules/focus/service";
import { recordExistingEngagement, saveHealthAnswer, updateOrderDates } from "@/modules/health/service";
import { addPlaybookStep, completeRunStep, createPlaybook, movePlaybookStep, pauseRun, reassignRunOwner, removePlaybookStep, resumeRun, setAccountDormant, skipRunStep, startPlaybookRun, updatePlaybook, updatePlaybookStep } from "@/modules/playbooks/service";
import { archiveAccount, deleteAccountPermanently, restoreAccount } from "@/modules/accounts/deletion";
import { formToStrategyInput, saveStrategy } from "@/modules/strategy/service";
import { formToOpportunityAdviceInput, saveOpportunityAdvice } from "@/modules/opportunities/advisor";
import { formToBuyingCenterAdviceInput, saveBuyingCenterAdvice } from "@/modules/opportunities/buyingCenterAdvisor";
import { addRole, setRoleActive } from "@/modules/roles/catalog";
import { createPerson, setPersonFunction, setPersonLinkedIn, setRelationship } from "@/modules/people/service";
import { addAccessPlanStep, changeAccessPlanStatus, createAccessPlan } from "@/modules/accesspaths/service";
import { addDecision, confirmReview, correctReview, createReview, saveReviewDraft } from "@/modules/reviews/service";
import { changePriority, createPriority, saveAccountPlanSnapshot } from "@/modules/accountplan/service";
import { changeArtifactStatus, createDraft, saveNewVersion } from "@/modules/artifacts/service";
import { acceptSuggestion, giveFeedback, smartDump, structureReviewNote, structureSource } from "@/modules/suggestions/service";
import { connectMailbox, revokeMailbox } from "@/modules/integrations/service";
import { refreshCompanyResearch } from "@/modules/research/service";
import { confirmImport, decideMerge, importMailboxItem, importProtocol, validateFileName } from "@/modules/imports/service";
import { assignRole, createUserAccess, eraseSourceContent, lockSource, purgeExpiredLogs, pseudonymizePerson, revokeRole, setUserStatus } from "@/modules/governance/service";
import { addParticipation, addStartRequirement, cancelOrder, changeOfferStatus, changeOpportunityStatus, confirmOpportunity, confirmOrder, createOffer, createOpportunity, createOrder, createProfileReference, markOrderEvidenceIncomplete, markReady, markStarted, presentOffer, reassignOpportunityOwner, removeParticipation, saveMeddpicc, setRequirementStatus, updateOpportunity } from "@/modules/opportunities/service";
import { uploadDocument } from "@/modules/documents/service";
import { applyIntake, discardIntake, formToApplyInput, startIntake } from "@/modules/intake/service";
import { saveTaskSetting, testConnection } from "@/modules/ai/settings";
import { answerInterview, discardInterview, finishInterview, startInterview } from "@/modules/interviews/service";
import { upsertAssessment } from "@/modules/people/assessments";
import { attachContractDocument, createInitiative, linkChanceToInitiative, setContractLink, setInitiativeStatus, setOrderConsultant, updateProcurement } from "@/modules/agenda/service";
import { changeSosStatus, createSos } from "@/modules/sos/service";
import { actOnWorkItem, createWorkItem, reassignWorkItem, setWatching, toggleChecklistItem, updateWorkItem } from "@/modules/work/service";
import { addAbsence, createTeam, removeAbsence, removeTeamMember, saveServiceType, setTeamMember } from "@/modules/work/teams";
import { addComment, deleteComment, editComment } from "@/modules/comments/service";
import { markRead, openNotification, saveMyPrefs } from "@/modules/notifications/service";
import { addCandidacy, changeCandidacyStatus, changePositionStatus, copyPosition, createPosition, quickFill, recordCustomerFeedback, recordInterview, recordPresentation, requestSearch, selectCandidacy, updateCandidacy, updateFreelancer, updatePosition } from "@/modules/staffing/service";
import { applyIntake as applyStaffingIntake, createIntake as createStaffingIntake, generateAdDraft, saveAdDraft } from "@/modules/staffing/ai";
import { getConfig } from "@/lib/config";
import { addContractDocument, addPeriod, changeEngagementStatus, linkContractDocument, saveProcurementProfile, setContractDocumentStatus, updateEngagement } from "@/modules/engagements/service";
import { actOnCheckin, createCheckin, requestCareHandover, setCareDirect, upsertRenewalDecision } from "@/modules/engagements/care";
import { addConfidentialNote, addGoalContribution, addLeadershipDecision, changeGoalStatus, confirmLeadershipReview, createGoal, createLeadershipReview, createSupportRequest, respondToSupportRequest, saveLeadershipDraft, updateGoal } from "@/modules/leadership/service";

/**
 * Alle Formulare laufen über diese Aktionen. Jede Aktion lädt den Akteur frisch,
 * ruft den geprüften Service auf und meldet Fehler verständlich an die aufrufende Seite zurück.
 */

function formToObject(fd: FormData): Record<string, string> {
  const obj: Record<string, string> = {};
  for (const [k, v] of fd.entries()) if (typeof v === "string") obj[k] = v;
  return obj;
}

async function requireActor(): Promise<Actor> {
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  return actor;
}

function withFeedback(target: string, kind: "fehler" | "ok", message: string): never {
  const url = new URL(target, "http://local");
  url.searchParams.set(kind, message);
  redirect(url.pathname + url.search + url.hash);
}

/** Kein Fehler, sondern ein Beobachtung, der die Erfolgsmeldung ersetzt (z. B. „Zustimmung gespeichert, noch nicht vereinbart“). */
class PendingInfo extends Error {}

async function run(back: string, fn: (actor: Actor) => Promise<string | void>, okMessage: string): Promise<never> {
  const actor = await requireActor();
  const rl = checkRateLimit(`write:${actor.userId}`, LIMITS.write.limit, LIMITS.write.windowMs);
  if (!rl.allowed) withFeedback(back, "fehler", `Zu viele Änderungen in kurzer Zeit. Bitte in ${rl.retryAfterSeconds} Sekunden erneut versuchen.`);
  await touchSession();
  let next: string | void;
  try {
    next = await fn(actor);
  } catch (e) {
    if (e instanceof PendingInfo) {
      revalidatePath("/", "layout");
      withFeedback(back, "ok", e.message);
    }
    const msg = e instanceof DomainError ? e.message : "Unerwarteter Fehler. Die Änderung wurde nicht gespeichert.";
    if (!(e instanceof DomainError)) console.error(e);
    withFeedback(back, "fehler", msg);
  }
  revalidatePath("/", "layout");
  withFeedback(next ?? back, "ok", okMessage);
}

// --- Anmeldung -------------------------------------------------------------

async function clientKey(): Promise<string> {
  const h = await headers();
  return (h.get("x-forwarded-for") ?? h.get("x-real-ip") ?? "lokal").split(",")[0]!.trim();
}

export async function devLoginAction(fd: FormData) {
  const rl = checkRateLimit(`login:${await clientKey()}`, LIMITS.login.limit, LIMITS.login.windowMs);
  if (!rl.allowed) withFeedback("/anmelden", "fehler", `Zu viele Anmeldeversuche. Bitte in ${rl.retryAfterSeconds} Sekunden erneut versuchen.`);
  const userId = String(fd.get("userId") ?? "");
  const user = await resolveDevLoginUser(userId);
  if (!user) withFeedback("/anmelden", "fehler", "Nutzer nicht gefunden.");
  const session = await getSession();
  session.userId = user.id;
  session.mode = "development";
  session.issuedAt = Date.now();
  session.lastSeenAt = Date.now();
  await session.save();
  redirect("/start");
}

export async function logoutAction() {
  const session = await getSession();
  if (session.mode === "oidc") redirect("/api/auth/logout");
  session.destroy();
  redirect("/anmelden");
}

// --- Kunden / Setups ------------------------------------------------------

export async function createAccountAction(fd: FormData) {
  const data = formToObject(fd);
  return run("/kunden", async (actor) => {
    const a = await createAccount(actor, { ...data, responsibleBdUserId: data.responsibleBdUserId || null });
    return `/kunden/${a.id}`;
  }, "Kunde angelegt.");
}

export async function reassignAccountBdAction(fd: FormData) {
  const data = formToObject(fd);
  const id = data.accountId ?? "";
  return run(`/kunden/${id}`, async (actor) => {
    await reassignAccountBd(actor, id, data);
  }, "Kundenzuständigkeit umgestellt.");
}

// --- Strategiefaden ------------------------------------------------------------

export async function saveStrategyAction(fd: FormData) {
  const data = formToObject(fd);
  const id = data.setupId ?? "";
  return run(`/setups/${id}/strategie`, async (actor) => {
    await saveStrategy(actor, formToStrategyInput(data));
  }, "Fassung gespeichert.");
}

// --- Chancen-Berater (Etappe 15) -------------------------------------------

export async function saveOpportunityAdviceAction(fd: FormData) {
  const data = formToObject(fd);
  const id = data.opportunityId ?? "";
  return run(`/bedarfe/${id}`, async (actor) => {
    await saveOpportunityAdvice(actor, formToOpportunityAdviceInput(data));
  }, "Fassung gespeichert.");
}

// --- Buying-Center-Berater (Etappe 17) --------------------------------------

export async function saveBuyingCenterAdviceAction(fd: FormData) {
  const data = formToObject(fd);
  const id = data.opportunityId ?? "";
  return run(`/bedarfe/${id}`, async (actor) => {
    await saveBuyingCenterAdvice(actor, formToBuyingCenterAdviceInput(data));
  }, "Fassung gespeichert.");
}

// --- Verwaltung → Rollen ---------------------------------------------------------

export async function addRoleAction(fd: FormData) {
  const data = formToObject(fd);
  return run("/verwaltung/rollen", async (actor) => {
    await addRole(actor, data);
  }, "Rolle ergänzt.");
}

export async function setRoleActiveAction(fd: FormData) {
  const data = formToObject(fd);
  return run("/verwaltung/rollen", async (actor) => {
    await setRoleActive(actor, data.roleId ?? "", data.active === "true");
  }, "Rolle aktualisiert.");
}

// --- Start / Dashboard -------------------------------------------------------

/** Sichtwechsel auf der Startseite: nur eine Brille, keine Rechteänderung; Wahl wird im Cookie gemerkt. */
export async function setDashboardViewAction(fd: FormData) {
  await requireActor();
  const view = String(fd.get("view") ?? "");
  if (["BD", "ANKER", "PRINCIPAL", "CEO"].includes(view)) {
    const store = await cookies();
    store.set("am_sicht", view, { path: "/", httpOnly: true, sameSite: "lax", maxAge: 60 * 60 * 24 * 90 });
  }
  redirect("/start");
}

export async function archiveAccountAction(fd: FormData) {
  const data = formToObject(fd);
  const id = data.accountId ?? "";
  return run(`/kunden/${id}`, async (actor) => {
    await archiveAccount(actor, id);
  }, "Kunde archiviert. Alles bleibt erhalten; endgültiges Löschen ist jetzt möglich.");
}

export async function restoreAccountAction(fd: FormData) {
  const data = formToObject(fd);
  const id = data.accountId ?? "";
  return run(`/kunden/${id}`, async (actor) => {
    await restoreAccount(actor, id);
  }, "Kunde wiederhergestellt.");
}

export async function deleteAccountAction(fd: FormData) {
  const data = formToObject(fd);
  const id = data.accountId ?? "";
  return run(`/kunden/${id}/loeschen`, async (actor) => {
    await deleteAccountPermanently(actor, data);
    return "/kunden";
  }, "Kunde endgültig gelöscht – mit allen Setups, Ansprechpartnern, Quellen und Vorschlägen. Der Vorgang steht mit Begründung im Prüfprotokoll.");
}

export async function createSetupAction(fd: FormData) {
  const data = formToObject(fd);
  return run(`/kunden/${data.accountId}`, async (actor) => {
    const s = await createSetup(actor, data);
    return `/setups/${s.id}`;
  }, "Setup angelegt. Angaben dürfen schrittweise ergänzt werden.");
}

export async function updateSetupAction(fd: FormData) {
  const data = formToObject(fd);
  const id = data.setupId ?? "";
  return run(`/setups/${id}`, async (actor) => {
    await updateSetup(actor, id, data);
  }, "Setup aktualisiert.");
}

export async function addMemberAction(fd: FormData) {
  const data = formToObject(fd);
  const id = data.setupId ?? "";
  return run(`/setups/${id}`, async (actor) => {
    await addMember(actor, id, data);
  }, "Beteiligung gespeichert.");
}

export async function removeMemberAction(fd: FormData) {
  const data = formToObject(fd);
  const id = data.setupId ?? "";
  return run(`/setups/${id}`, async (actor) => {
    await removeMember(actor, id, data.userId ?? "");
  }, "Beteiligung entfernt.");
}

export async function reassignSetupBdAction(fd: FormData) {
  const data = formToObject(fd);
  const id = data.setupId ?? "";
  return run(`/setups/${id}`, async (actor) => {
    await reassignSetupBd(actor, id, data);
  }, "Setup-Zuständigkeit umgestellt.");
}

// --- Beobachtungen ---------------------------------------------------------------

export async function captureObservationAction(fd: FormData) {
  const data = formToObject(fd);
  const id = data.setupId ?? "";
  return run(data.reviewId ? `/weeklys/${data.reviewId}` : `/setups/${id}`, async (actor) => {
    await captureObservation(actor, data);
  }, "Beobachtung erfasst und als Beobachtung (Neu) gespeichert.");
}

export async function takeOverSignalAction(fd: FormData) {
  const data = formToObject(fd);
  return run(data.back ?? "/meine-arbeit", async (actor) => {
    await takeOverSignal(actor, data.signalId ?? "", Number(data.version));
  }, "Prüfung übernommen.");
}

export async function changeSignalStatusAction(fd: FormData) {
  const data = formToObject(fd);
  return run(data.back ?? "/meine-arbeit", async (actor) => {
    await changeSignalStatus(actor, data.signalId ?? "", data);
  }, "Beobachtung-Status geändert.");
}

// --- Übergaben --------------------------------------------------------------

export async function createHandoverAction(fd: FormData) {
  const data = formToObject(fd);
  return run(data.back ?? "/meine-arbeit", async (actor) => {
    await createHandover(actor, data);
  }, "Übergabe angefragt. Bis zur Annahme bleibt die bisherige Zuständigkeit sichtbar.");
}

export async function respondHandoverAction(fd: FormData) {
  const data = formToObject(fd);
  return run(data.back ?? "/meine-arbeit", async (actor) => {
    await respondToHandover(actor, data.handoverId ?? "", data);
  }, "Rückmeldung zur Übergabe gespeichert.");
}

// --- Aktionen ---------------------------------------------------------------

export async function createActionAction(fd: FormData) {
  const data = formToObject(fd);
  return run(data.back ?? `/setups/${data.setupId}`, async (actor) => {
    await createAction(actor, data);
  }, "Aktion gespeichert.");
}

export async function changeActionStatusAction(fd: FormData) {
  const data = formToObject(fd);
  return run(data.back ?? "/meine-arbeit", async (actor) => {
    await changeActionStatus(actor, data.actionId ?? "", data);
  }, "Aktions-Status geändert.");
}

// --- Personen & Zugang ------------------------------------------------------

export async function createPersonAction(fd: FormData) {
  const data = formToObject(fd);
  return run(data.back ?? `/kunden/${data.accountId}`, async (actor) => {
    await createPerson(actor, data);
  }, "Person angelegt.");
}

export async function setPersonLinkedInAction(fd: FormData) {
  const data = formToObject(fd);
  return run(data.back ?? "/kunden", async (actor) => {
    await setPersonLinkedIn(actor, data);
  }, "LinkedIn-Profil aktualisiert.");
}

export async function setPersonFunctionAction(fd: FormData) {
  const data = formToObject(fd);
  return run(data.back ?? "/kunden", async (actor) => {
    await setPersonFunction(actor, data);
  }, "Funktion aktualisiert; die bisherige Funktion wurde zeitlich abgeschlossen.");
}

export async function setRelationshipAction(fd: FormData) {
  const data = formToObject(fd);
  return run(data.back ?? "/kunden", async (actor) => {
    await setRelationship(actor, data);
  }, "Beziehungsstand gespeichert.");
}

export async function createAccessPlanAction(fd: FormData) {
  const data = formToObject(fd);
  return run(data.back ?? `/setups/${data.setupId}/personen`, async (actor) => {
    await createAccessPlan(actor, data);
  }, "Kontaktweg angelegt (Entwurf). Bitte Schritte mit Belegen ergänzen.");
}

export async function addAccessPlanStepAction(fd: FormData) {
  const data = formToObject(fd);
  return run(data.back ?? "/kunden", async (actor) => {
    await addAccessPlanStep(actor, data);
  }, "Schritt ergänzt.");
}

export async function changeAccessPlanStatusAction(fd: FormData) {
  const data = formToObject(fd);
  return run(data.back ?? "/kunden", async (actor) => {
    await changeAccessPlanStatus(actor, data.accessPlanId ?? "", data);
  }, "Status des Kontaktwegs geändert.");
}

// --- Weeklys ------------------------------------------------------------------

export async function createReviewAction(fd: FormData) {
  const data = formToObject(fd);
  const participantIds = fd.getAll("participantIds").filter((v): v is string => typeof v === "string");
  return run(data.back ?? "/weeklys", async (actor) => {
    const r = await createReview(actor, { ...data, participantIds });
    return `/weeklys/${r.id}`;
  }, "Weekly angelegt.");
}

export async function saveReviewDraftAction(fd: FormData) {
  const data = formToObject(fd);
  const id = data.reviewId ?? "";
  return run(`/weeklys/${id}`, async (actor) => {
    await saveReviewDraft(actor, id, data);
  }, data.toStatus === "BESTAETIGUNG_OFFEN" ? "Entwurf gespeichert – Ergebnisvorschau zur Bestätigung." : "Notiz als Entwurf gespeichert.");
}

export async function addDecisionAction(fd: FormData) {
  const data = formToObject(fd);
  return run(`/weeklys/${data.reviewId}`, async (actor) => {
    await addDecision(actor, data);
  }, "Entscheidung festgehalten.");
}

export async function confirmReviewAction(fd: FormData) {
  const data = formToObject(fd);
  const id = data.reviewId ?? "";
  return run(`/weeklys/${id}`, async (actor) => {
    await confirmReview(actor, id, data);
  }, "Weekly bestätigt. Der Stand ist jetzt versioniert; Aufgaben erscheinen in den persönlichen Ansichten.");
}

export async function correctReviewAction(fd: FormData) {
  const data = formToObject(fd);
  const id = data.reviewId ?? "";
  return run(`/weeklys/${id}`, async (actor) => {
    await correctReview(actor, id, data);
  }, "Korrekturversion gespeichert; die vorherige Version bleibt nachvollziehbar.");
}

// --- Accountplan ---------------------------------------------------------------

export async function createPriorityAction(fd: FormData) {
  const data = formToObject(fd);
  return run(`/kunden/${data.accountId}`, async (actor) => {
    await createPriority(actor, data);
  }, "Vorhaben als Vorschlag aufgenommen.");
}

export async function changePriorityAction(fd: FormData) {
  const data = formToObject(fd);
  return run(data.back ?? "/kunden", async (actor) => {
    const r = await changePriority(actor, data.priorityId ?? "", data);
    if (r.pendingAgreement) throw new PendingInfo("Ihre Zustimmung ist gespeichert. „Vereinbart“ wird das Vorhaben, sobald BD und Principal zugestimmt haben.");
  }, "Priorität aktualisiert.");
}

export async function saveAccountPlanSnapshotAction(fd: FormData) {
  const data = formToObject(fd);
  return run(`/kunden/${data.accountId}`, async (actor) => {
    const s = await saveAccountPlanSnapshot(actor, data);
    return `/kunden/${data.accountId}/staende/${s.id}`;
  }, "Stand des Accountplans gespeichert.");
}

// --- Artefakte -------------------------------------------------------------------

export async function createArtifactDraftAction(fd: FormData) {
  const data = formToObject(fd);
  return run(`/setups/${data.setupId}/artefakte`, async (actor) => {
    const v = await createDraft(actor, data);
    return `/artefakte/${v.id}`;
  }, "Entwurf angelegt. Vorbefüllte Inhalte sind Vorschläge aus vorhandenen Daten – bitte prüfen.");
}

export async function saveArtifactVersionAction(fd: FormData) {
  const data = formToObject(fd);
  const content: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) if (k.startsWith("section:")) content[k.slice(8)] = v;
  const sourceIds = fd.getAll("sourceIds").filter((v): v is string => typeof v === "string");
  return run(`/artefakte/${data.versionId}`, async (actor) => {
    const v = await saveNewVersion(actor, { versionId: data.versionId, title: data.title, content, audience: data.audience || undefined, sourceIds });
    return `/artefakte/${v.id}`;
  }, "Neue Version gespeichert.");
}

export async function changeArtifactStatusAction(fd: FormData) {
  const data = formToObject(fd);
  return run(`/artefakte/${data.versionId}`, async (actor) => {
    await changeArtifactStatus(actor, data);
  }, data.status === "FREIGEGEBEN" ? "Freigegeben. Das ist kein Versand und kein Vorstellungsereignis – Kopieren bleibt Ihre Handlung." : "Status geändert.");
}

// --- KI-Vorschläge -------------------------------------------------------------

export async function structureNoteAction(fd: FormData) {
  const data = formToObject(fd);
  const id = data.reviewId ?? "";
  return run(`/weeklys/${id}`, async (actor) => {
    const r = await structureReviewNote(actor, id);
    if (r.repeated) throw new PendingInfo("Diese Notiz wurde bereits strukturiert; es wurden keine neuen Vorschläge erzeugt.");
    if (r.created === 0) throw new PendingInfo(r.noSuggestionReason || `Keine neuen Vorschläge (${r.skipped} bereits bekannt, ${r.rejected ?? 0} zurückgewiesen).`);
    throw new PendingInfo(`${r.created} Vorschlag/Vorschläge erzeugt (${r.skipped} bereits bekannt, ${r.rejected ?? 0} zurückgewiesen). Bitte prüfen – nichts wurde automatisch übernommen.`);
  }, "");
}

export async function acceptSuggestionAction(fd: FormData) {
  const data = formToObject(fd);
  return run(data.back ?? "/meine-arbeit", async (actor) => {
    await acceptSuggestion(actor, data.suggestionId ?? "", data);
  }, "Vorschlag angenommen – das Objekt wurde im ungeprüften Zustand angelegt.");
}

export async function suggestionFeedbackAction(fd: FormData) {
  const data = formToObject(fd);
  return run(data.back ?? "/meine-arbeit", async (actor) => {
    await giveFeedback(actor, data.suggestionId ?? "", data);
  }, "Rückmeldung gespeichert.");
}

// --- Quellenanbindung / Import -------------------------------------------------

export async function connectMailboxAction(fd: FormData) {
  const data = formToObject(fd);
  return run("/einstellungen", async (actor) => {
    await connectMailbox(actor, { fixture: data.mode !== "echt" });
  }, "Postfach verbunden (Fixture-Modus – fiktive Testquellen, kein echter Abruf).");
}

export async function revokeMailboxAction() {
  return run("/einstellungen", async (actor) => {
    await revokeMailbox(actor);
  }, "Verbindung widerrufen; Zugangsdaten gelöscht.");
}

// --- Öffentliche Unternehmensrecherche (Etappe 16) -------------------------

export async function refreshCompanyResearchAction(fd: FormData) {
  const data = formToObject(fd);
  const id = data.accountId ?? "";
  return run(`/kunden/${id}`, async (actor) => {
    await refreshCompanyResearch(actor, id);
  }, "Recherche aktualisiert (Fixture-Daten, kein echter Internetzugriff).");
}

export async function importProtocolAction(fd: FormData) {
  const data = formToObject(fd);
  const file = fd.get("file");
  let text = data.text ?? "";
  let fileName = "";
  if (file instanceof File && file.size > 0) {
    if (file.size > 2_000_000) withFeedback("/eingang", "fehler", "Datei ist größer als 2 MB.");
    fileName = file.name;
    try {
      validateFileName(fileName);
    } catch (e) {
      withFeedback("/eingang", "fehler", e instanceof DomainError ? e.message : "Dateityp nicht zulässig.");
    }
    text = await file.text();
  }
  return run("/eingang", async (actor) => {
    const r = await importProtocol(actor, { ...data, text, fileName });
    if (r.repeated) throw new PendingInfo("Diese Quelle war bereits importiert – kein zweiter Import.");
    if (r.newVersion) throw new PendingInfo("Quelle war bekannt; geänderter Inhalt wurde als neue Version gespeichert.");
    const n = r.structured?.created ?? 0;
    throw new PendingInfo(`Quelle übernommen${r.structured ? ` und ausgewertet: ${n} Vorschlag/Vorschläge zur Prüfung` : ""}. Bitte Prüfliste und Vorschläge im Setup ansehen.`);
  }, "");
}

export async function importMailboxItemAction(fd: FormData) {
  const data = formToObject(fd);
  return run("/eingang", async (actor) => {
    const r = await importMailboxItem(actor, data);
    if (r.repeated) throw new PendingInfo("Dieses Objekt war bereits importiert – kein zweiter Import.");
    throw new PendingInfo(`„${r.job.title}“ übernommen${r.structured ? ` und ausgewertet: ${r.structured.created} Vorschlag/Vorschläge` : ""}. Warnungen: ${r.job.warnings.length}.`);
  }, "");
}

export async function decideMergeAction(fd: FormData) {
  const data = formToObject(fd);
  return run("/eingang", async (actor) => {
    await decideMerge(actor, data);
  }, "Zuordnung entschieden.");
}

export async function confirmImportAction(fd: FormData) {
  const data = formToObject(fd);
  return run("/eingang", async (actor) => {
    await confirmImport(actor, data);
  }, "Import bestätigt und protokolliert.");
}

// --- Führungsebenen ------------------------------------------------------------

export async function createSupportRequestAction(fd: FormData) {
  const data = formToObject(fd);
  return run(data.back ?? "/meine-arbeit", async (actor) => {
    await createSupportRequest(actor, data);
  }, "Unterstützungsauftrag angefragt. Die operative Fallverantwortung bleibt beim BD.");
}

export async function respondSupportRequestAction(fd: FormData) {
  const data = formToObject(fd);
  return run(data.back ?? "/meine-arbeit", async (actor) => {
    await respondToSupportRequest(actor, data.requestId ?? "", data);
  }, "Rückmeldung zum Unterstützungsauftrag gespeichert.");
}

export async function createLeadershipReviewAction(fd: FormData) {
  const data = formToObject(fd);
  const participantIds = fd.getAll("participantIds").filter((v): v is string => typeof v === "string");
  return run("/ziele", async (actor) => {
    const r = await createLeadershipReview(actor, { ...data, participantIds });
    return `/fuehrung/${r.id}`;
  }, "Review angelegt.");
}

export async function saveLeadershipDraftAction(fd: FormData) {
  const data = formToObject(fd);
  return run(`/fuehrung/${data.reviewId}`, async (actor) => {
    await saveLeadershipDraft(actor, data.reviewId ?? "", { version: Number(data.version), noteDraft: data.noteDraft ?? "" });
  }, "Notiz als Entwurf gespeichert.");
}

export async function addLeadershipDecisionAction(fd: FormData) {
  const data = formToObject(fd);
  return run(`/fuehrung/${data.reviewId}`, async (actor) => {
    await addLeadershipDecision(actor, { reviewId: data.reviewId ?? "", content: data.content ?? "", scope: data.scope, rationale: data.rationale });
  }, "Entscheidung festgehalten.");
}

export async function confirmLeadershipReviewAction(fd: FormData) {
  const data = formToObject(fd);
  return run(`/fuehrung/${data.reviewId}`, async (actor) => {
    await confirmLeadershipReview(actor, data.reviewId ?? "", { version: Number(data.version) });
  }, "Review bestätigt und versioniert.");
}

export async function addConfidentialNoteAction(fd: FormData) {
  const data = formToObject(fd);
  const audienceUserIds = fd.getAll("audienceUserIds").filter((v): v is string => typeof v === "string");
  return run(`/fuehrung/${data.reviewId}`, async (actor) => {
    await addConfidentialNote(actor, { ...data, audienceUserIds });
  }, "Vertrauliche Notiz gespeichert – nur für den gewählten Empfängerkreis sichtbar.");
}

export async function createGoalAction(fd: FormData) {
  const data = formToObject(fd);
  return run("/ziele", async (actor) => {
    const g = await createGoal(actor, data);
    return `/ziele/${g.id}`;
  }, "Ziel als Entwurf angelegt (Version 1).");
}

export async function updateGoalAction(fd: FormData) {
  const data = formToObject(fd);
  return run(`/ziele/${data.goalId}`, async (actor) => {
    await updateGoal(actor, data.goalId ?? "", data);
  }, "Neue Zielversion gespeichert.");
}

export async function changeGoalStatusAction(fd: FormData) {
  const data = formToObject(fd);
  return run(`/ziele/${data.goalId}`, async (actor) => {
    const r = await changeGoalStatus(actor, data.goalId ?? "", { version: Number(data.version), status: data.status as never });
    if (r.pendingAgreement) throw new PendingInfo("Ihre Zustimmung ist gespeichert. „Vereinbart“ wird das Ziel, sobald CEO und Principal zugestimmt haben.");
  }, "Zielstatus geändert.");
}

export async function addGoalContributionAction(fd: FormData) {
  const data = formToObject(fd);
  return run(data.back ?? `/ziele/${data.goalId}`, async (actor) => {
    await addGoalContribution(actor, data);
  }, "Zielbeitrag festgehalten.");
}

// --- Chancen, Angebote, Aufträge (Etappe 5) -----------------------------------------

export async function createOpportunityAction(fd: FormData) {
  const data = formToObject(fd);
  return run(data.back ?? `/setups/${data.setupId}`, async (actor) => {
    const o = await createOpportunity(actor, data);
    return `/bedarfe/${o.id}`;
  }, "Chance angelegt.");
}

export async function updateOpportunityAction(fd: FormData) {
  const data = formToObject(fd);
  return run(`/bedarfe/${data.opportunityId}`, async (actor) => {
    await updateOpportunity(actor, data.opportunityId ?? "", data);
  }, "Chance aktualisiert.");
}

export async function reassignOpportunityOwnerAction(fd: FormData) {
  const data = formToObject(fd);
  return run(`/bedarfe/${data.opportunityId}`, async (actor) => {
    await reassignOpportunityOwner(actor, data.opportunityId ?? "", data);
  }, "Verantwortlichkeit umgestellt.");
}

export async function saveMeddpiccAction(fd: FormData) {
  const data = formToObject(fd);
  const { opportunityId, version, ...fields } = data;
  return run(`/bedarfe/${opportunityId}`, async (actor) => {
    await saveMeddpicc(actor, opportunityId ?? "", { version: Number(version), fields });
  }, "Qualifizierungshilfe gespeichert – ohne Bewertung, nur dokumentiert.");
}

export async function confirmOpportunityAction(fd: FormData) {
  const data = formToObject(fd);
  return run(`/bedarfe/${data.opportunityId}`, async (actor) => {
    await confirmOpportunity(actor, data.opportunityId ?? "", data);
  }, "Chance bestätigt – mit Quelle und Zeitpunkt dokumentiert.");
}

export async function changeOpportunityStatusAction(fd: FormData) {
  const data = formToObject(fd);
  return run(`/bedarfe/${data.opportunityId}`, async (actor) => {
    await changeOpportunityStatus(actor, data.opportunityId ?? "", { version: Number(data.version), status: data.status as never, reason: data.reason });
  }, "Status der Chance geändert.");
}

export async function addParticipationAction(fd: FormData) {
  const data = formToObject(fd);
  return run(`/bedarfe/${data.opportunityId}`, async (actor) => {
    await addParticipation(actor, data);
  }, "Rolle im Buyingcenter festgehalten.");
}

export async function removeParticipationAction(fd: FormData) {
  const data = formToObject(fd);
  return run(`/bedarfe/${data.opportunityId}`, async (actor) => {
    await removeParticipation(actor, data.participationId ?? "");
  }, "Rolle entfernt.");
}

export async function createProfileReferenceAction(fd: FormData) {
  const data = formToObject(fd);
  return run(data.back ?? "/einstellungen", async (actor) => {
    await createProfileReference(actor, data);
  }, "Profilreferenz angelegt (nur Verweis, kein Profilinhalt).");
}

export async function createOfferAction(fd: FormData) {
  const data = formToObject(fd);
  const profileReferenceIds = fd.getAll("profileReferenceIds").filter((v): v is string => typeof v === "string");
  return run(`/bedarfe/${data.opportunityId}`, async (actor) => {
    await createOffer(actor, { ...data, profileReferenceIds });
  }, "Angebot als Entwurf angelegt. Ein Entwurf gilt nicht als vorgestellt.");
}

export async function presentOfferAction(fd: FormData) {
  const data = formToObject(fd);
  return run(`/bedarfe/${data.opportunityId}`, async (actor) => {
    await presentOffer(actor, data.offerId ?? "", data);
  }, "Vorstellungsereignis bestätigt und belegt.");
}

export async function changeOfferStatusAction(fd: FormData) {
  const data = formToObject(fd);
  return run(`/bedarfe/${data.opportunityId}`, async (actor) => {
    await changeOfferStatus(actor, data.offerId ?? "", { version: Number(data.version), status: data.status as never, note: data.note });
  }, data.status === "AKZEPTIERT" ? "Rückmeldung festgehalten. Ein akzeptiertes Angebot ist noch kein Auftrag." : "Angebotsstatus geändert.");
}

export async function createOrderAction(fd: FormData) {
  const data = formToObject(fd);
  return run(`/bedarfe/${data.opportunityId}`, async (actor) => {
    await createOrder(actor, data);
  }, "Auftrag in Vorbereitung angelegt.");
}

export async function confirmOrderAction(fd: FormData) {
  const data = formToObject(fd);
  return run(`/bedarfe/${data.opportunityId}`, async (actor) => {
    await confirmOrder(actor, data.orderId ?? "", data);
  }, "Beauftragung bestätigt.");
}

export async function orderEvidenceIncompleteAction(fd: FormData) {
  const data = formToObject(fd);
  return run(`/bedarfe/${data.opportunityId}`, async (actor) => {
    await markOrderEvidenceIncomplete(actor, data.orderId ?? "", { version: Number(data.version), note: data.note ?? "" });
  }, "Fehlender Nachweis festgehalten.");
}

export async function cancelOrderAction(fd: FormData) {
  const data = formToObject(fd);
  return run(`/bedarfe/${data.opportunityId}`, async (actor) => {
    await cancelOrder(actor, data.orderId ?? "", { version: Number(data.version), reason: data.reason ?? "" });
  }, "Auftrag beendet/storniert.");
}

export async function addStartRequirementAction(fd: FormData) {
  const data = formToObject(fd);
  return run(`/bedarfe/${data.opportunityId}`, async (actor) => {
    await addStartRequirement(actor, data);
  }, "Startvoraussetzung erfasst.");
}

export async function setRequirementStatusAction(fd: FormData) {
  const data = formToObject(fd);
  return run(`/bedarfe/${data.opportunityId}`, async (actor) => {
    await setRequirementStatus(actor, data.requirementId ?? "", data);
  }, "Stand der Startvoraussetzung gespeichert.");
}

export async function markReadyAction(fd: FormData) {
  const data = formToObject(fd);
  return run(`/bedarfe/${data.opportunityId}`, async (actor) => {
    await markReady(actor, data.orderId ?? "", { version: Number(data.version) });
  }, "Einsatz startbereit – alle erfassten Startvoraussetzungen sind bestätigt oder begründet nicht anwendbar.");
}

export async function markStartedAction(fd: FormData) {
  const data = formToObject(fd);
  return run(`/bedarfe/${data.opportunityId}`, async (actor) => {
    await markStarted(actor, data.orderId ?? "", { version: Number(data.version), startedAt: data.startedAt, note: data.note });
  }, "Start als bestätigtes Ereignis festgehalten.");
}

// --- Governance: Sperren/Löschen, Verwaltung (Etappe 5 Teil B) -----------------------

export async function lockSourceAction(fd: FormData) {
  const data = formToObject(fd);
  return run(data.back ?? `/quellen/${data.sourceId}`, async (actor) => {
    const r = await lockSource(actor, data.sourceId ?? "", data);
    throw new PendingInfo(`Quelle gesperrt. Zur erneuten Prüfung markiert: ${r.suggestionsSuperseded} Vorschläge, ${r.artifactVersionsSuperseded} Artefaktfassungen, ${r.assertionsSuperseded} Aussagen.`);
  }, "Quelle gesperrt.");
}

export async function eraseSourceAction(fd: FormData) {
  const data = formToObject(fd);
  return run(data.back ?? `/quellen/${data.sourceId}`, async (actor) => {
    await eraseSourceContent(actor, data.sourceId ?? "", data);
  }, "Inhalt der Quelle entfernt; Metadaten und Protokoll bleiben.");
}

export async function pseudonymizePersonAction(fd: FormData) {
  const data = formToObject(fd);
  return run("/verwaltung/fristen", async (actor) => {
    await pseudonymizePerson(actor, data);
  }, "Ansprechpartner gelöscht (Stammdaten pseudonymisiert).");
}

export async function purgeExpiredLogsAction() {
  return run("/verwaltung/fristen", async (actor) => {
    const r = await purgeExpiredLogs(actor);
    throw new PendingInfo(`Gelöscht: ${r.auditEvents} Protokolleinträge, ${r.aiJobs} KI-Auftragsprotokolle.`);
  }, "Abgelaufene Protokolleinträge gelöscht.");
}

export async function assignRoleAction(fd: FormData) {
  const data = formToObject(fd);
  return run("/verwaltung", async (actor) => {
    await assignRole(actor, data);
  }, "Rolle zugewiesen.");
}

export async function revokeRoleAction(fd: FormData) {
  const data = formToObject(fd);
  return run("/verwaltung", async (actor) => {
    await revokeRole(actor, data.roleAssignmentId ?? "");
  }, "Rolle entzogen.");
}

export async function setUserStatusAction(fd: FormData) {
  const data = formToObject(fd);
  return run("/verwaltung", async (actor) => {
    await setUserStatus(actor, data.userId ?? "", data.status === "INACTIVE" ? "INACTIVE" : "ACTIVE");
  }, "Zugangsstatus geändert.");
}

export async function createUserAccessAction(fd: FormData) {
  const data = formToObject(fd);
  return run("/verwaltung", async (actor) => {
    await createUserAccess(actor, data);
  }, "Zugang angelegt. Die Person kann sich jetzt mit ihrem Microsoft-365-Konto anmelden; bitte Rollen zuweisen.");
}

// --- Etappe 6: Dokumente, Kundenanlage aus Dokument, KI-Konfiguration ---------

function fileFrom(fd: FormData, name: string): File | null {
  const f = fd.get(name);
  return f instanceof File && f.size > 0 ? f : null;
}

export async function uploadDocumentAction(fd: FormData) {
  const data = formToObject(fd);
  const back = `/setups/${data.setupId ?? ""}`;
  return run(back, async (actor) => {
    const r = await uploadDocument(actor, data, fileFrom(fd, "file"));
    if (r.extract.status !== "OK") throw new PendingInfo(`Dokument gespeichert. ${r.extract.note ?? ""}`.trim());
    return `/quellen/${r.sourceId}`;
  }, "Dokument als Quelle gespeichert. Text wurde extrahiert.");
}

export async function smartDumpAction(fd: FormData) {
  const data = formToObject(fd);
  return run("/start", async (actor) => {
    const r = await smartDump(actor, data);
    if (r.repeated) throw new PendingInfo("Dieser Text wurde schon einmal so eingefügt; es wurden keine neuen Vorschläge erzeugt.");
    if (r.created === 0) throw new PendingInfo(r.noSuggestionReason ? `Gespeichert, aber keine Vorschläge: ${r.noSuggestionReason}` : `Gespeichert, aber keine neuen Vorschläge (${r.skipped} bereits vorhanden, ${r.rejected} zurückgewiesen).`);
    return `/setups/${data.setupId ?? ""}`;
  }, "Text gespeichert und Vorschläge erzeugt – bitte im Setup prüfen.");
}

export async function structureSourceAction(fd: FormData) {
  const data = formToObject(fd);
  const back = data.back ?? `/quellen/${data.sourceId ?? ""}`;
  return run(back, async (actor) => {
    const r = await structureSource(actor, data.sourceId ?? "");
    if (r.repeated) throw new PendingInfo("Diese Quelle wurde mit diesem Stand bereits strukturiert; es wurden keine neuen Vorschläge erzeugt.");
    if (r.created === 0) throw new PendingInfo(r.noSuggestionReason ? `Keine Vorschläge: ${r.noSuggestionReason}` : `Keine neuen Vorschläge (${r.skipped} bereits vorhanden, ${r.rejected} zurückgewiesen).`);
    return `/setups/${data.setupId ?? ""}`;
  }, "Vorschläge aus der Quelle erzeugt – bitte im Setup prüfen.");
}

export async function startIntakeAction(fd: FormData) {
  const data = formToObject(fd);
  return run("/kunden/anlage/neu", async (actor) => {
    const p = await startIntake(actor, data, fileFrom(fd, "file"));
    return `/kunden/anlage/${p.id}`;
  }, "Dokument gelesen. Bitte den Vorschlag prüfen und übernehmen.");
}

export async function applyIntakeAction(fd: FormData) {
  const data = formToObject(fd);
  const id = data.proposalId ?? "";
  return run(`/kunden/anlage/${id}`, async (actor) => {
    const r = await applyIntake(actor, id, formToApplyInput(data));
    const summary = `${r.created.persons} Personen, ${r.created.signals} Signale, ${r.created.needs} Chancen, ${r.created.actions + r.created.contacts + r.created.questions} Vorschläge`;
    if (r.problems.length > 0) throw new PendingInfo(`Übernommen (${summary}). Nicht übernommen: ${r.problems.join(" · ")}`);
    return `/setups/${r.setupId}`;
  }, "Übernommen – alles im ungeprüften Zustand; Folgeaktivitäten und Kontaktaufnahmen stehen als Vorschläge bereit.");
}

export async function discardIntakeAction(fd: FormData) {
  const data = formToObject(fd);
  return run("/kunden", async (actor) => {
    await discardIntake(actor, data.proposalId ?? "");
  }, "Anlagevorschlag verworfen. Das Dokument bleibt als persönliche Quelle erhalten.");
}

export async function saveAiTaskSettingAction(fd: FormData) {
  const data = formToObject(fd);
  return run("/verwaltung/ki", async (actor) => {
    await saveTaskSetting(actor, data);
  }, "Einstellung gespeichert.");
}

export async function testAiConnectionAction() {
  return run("/verwaltung/ki", async (actor) => {
    const r = await testConnection(actor);
    throw new PendingInfo(`Verbindung in Ordnung – ${r.detail}`);
  }, "");
}

// --- Etappe 7: Interview, Personenbewertung ----------------------------------

export async function startInterviewAction(fd: FormData) {
  const data = formToObject(fd);
  const back = data.setupId ? `/setups/${data.setupId}` : "/kunden";
  return run(back, async (actor) => {
    const iv = await startInterview(actor, data);
    return `/interviews/${iv.id}`;
  }, "Interview gestartet. Antworten Sie in eigenen Worten – Diktierfunktion (Windows-Taste + H) funktioniert im Textfeld.");
}

export async function answerInterviewAction(fd: FormData) {
  const data = formToObject(fd);
  const id = data.interviewId ?? "";
  return run(`/interviews/${id}`, async (actor) => {
    const r = await answerInterview(actor, data);
    if (r.done) throw new PendingInfo("Alle Themen sind abgedeckt – Sie können das Interview abschließen oder weitere Angaben ergänzen.");
  }, "Antwort gespeichert.");
}

export async function finishInterviewAction(fd: FormData) {
  const data = formToObject(fd);
  const id = data.interviewId ?? "";
  return run(`/interviews/${id}`, async (actor) => {
    const r = await finishInterview(actor, id);
    return `/kunden/anlage/${r.proposal.id}`;
  }, "Interview ausgewertet. Bitte den Vorschlag prüfen und übernehmen.");
}

export async function discardInterviewAction(fd: FormData) {
  const data = formToObject(fd);
  return run(data.back ?? "/kunden", async (actor) => {
    await discardInterview(actor, data.interviewId ?? "");
  }, "Interview verworfen.");
}

export async function saveAssessmentAction(fd: FormData) {
  const data = formToObject(fd);
  return run(data.back ?? `/setups/${data.setupId ?? ""}/personen`, async (actor) => {
    await upsertAssessment(actor, data);
  }, "Einschätzung gespeichert.");
}

// --- Vorgehensmuster (Etappe 20) ---------------------------------------------

/** Rücksprung: explizit übergebenes „back“, sonst die Musterübersicht. Nur interne Pfade. */
function backOf(data: Record<string, string | undefined>, fallback: string): string {
  const b = data.back ?? "";
  return b.startsWith("/") && !b.startsWith("//") ? b : fallback;
}

export async function startPlaybookRunAction(fd: FormData) {
  const data = formToObject(fd);
  const back = backOf(data, "/vorgehen");
  return run(back, async (actor) => {
    const r = await startPlaybookRun(actor, data);
    // Bei neuem Setup direkt dorthin, wo das Vorgehen läuft
    return data.newSetupName && !data.setupId ? `/setups/${r.setupId}` : back;
  }, "Vorgehen gestartet. Der erste Schritt liegt als Aktion bei der verantwortlichen Person.");
}

export async function completeRunStepAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, "/vorgehen"), async (actor) => {
    await completeRunStep(actor, data.runStepId ?? "", data);
  }, "Schritt erledigt – der nächste Schritt ist angelegt.");
}

export async function skipRunStepAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, "/vorgehen"), async (actor) => {
    await skipRunStep(actor, data.runStepId ?? "", data);
  }, "Schritt übersprungen (Begründung ist dokumentiert).");
}

export async function pauseRunAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, "/vorgehen"), async (actor) => {
    await pauseRun(actor, data.runId ?? "", data);
  }, "Vorgehen zurückgestellt.");
}

export async function resumeRunAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, "/vorgehen"), async (actor) => {
    await resumeRun(actor, data.runId ?? "", { version: data.version ?? "0" });
  }, "Vorgehen wieder aufgenommen.");
}

export async function reassignRunOwnerAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, "/vorgehen"), async (actor) => {
    await reassignRunOwner(actor, data.runId ?? "", data);
  }, "Verantwortung für das Vorgehen umgestellt.");
}

export async function setAccountDormantAction(fd: FormData) {
  const data = formToObject(fd);
  const id = data.accountId ?? "";
  return run(backOf(data, `/kunden/${id}`), async (actor) => {
    await setAccountDormant(actor, id, data.dormant === "true");
  }, data.dormant === "true" ? "Kunde als ruhend markiert." : "Kunde wieder als aktiv geführt.");
}

export async function createPlaybookAction(fd: FormData) {
  const data = formToObject(fd);
  return run("/vorgehen", async (actor) => {
    const p = await createPlaybook(actor, data);
    return `/vorgehen/${p.id}`;
  }, "Vorgehensmuster angelegt – jetzt Schritte ergänzen.");
}

export async function updatePlaybookAction(fd: FormData) {
  const data = formToObject(fd);
  const id = data.playbookId ?? "";
  return run(`/vorgehen/${id}`, async (actor) => {
    await updatePlaybook(actor, id, data);
  }, "Vorgehensmuster gespeichert.");
}

export async function addPlaybookStepAction(fd: FormData) {
  const data = formToObject(fd);
  const id = data.playbookId ?? "";
  return run(`/vorgehen/${id}`, async (actor) => {
    await addPlaybookStep(actor, id, data);
  }, "Schritt ergänzt.");
}

export async function updatePlaybookStepAction(fd: FormData) {
  const data = formToObject(fd);
  return run(`/vorgehen/${data.playbookId ?? ""}`, async (actor) => {
    await updatePlaybookStep(actor, data.stepId ?? "", data);
  }, "Schritt gespeichert.");
}

export async function removePlaybookStepAction(fd: FormData) {
  const data = formToObject(fd);
  return run(`/vorgehen/${data.playbookId ?? ""}`, async (actor) => {
    await removePlaybookStep(actor, data.stepId ?? "");
  }, "Schritt entfernt.");
}

export async function movePlaybookStepAction(fd: FormData) {
  const data = formToObject(fd);
  return run(`/vorgehen/${data.playbookId ?? ""}`, async (actor) => {
    await movePlaybookStep(actor, data.stepId ?? "", data.direction === "up" ? "up" : "down");
  }, "Reihenfolge geändert.");
}

export async function draftRunStepAction(fd: FormData) {
  const data = formToObject(fd);
  const back = backOf(data, "/vorgehen");
  return run(back, async (actor) => {
    await proposeStepDrafts(actor, data.runStepId ?? "");
    return `${back.split("#")[0]}#vorgehen`;
  }, "Entwürfe erstellt – bitte prüfen und Platzhalter ergänzen.");
}

// --- Strategischer Fokus (Etappe 21) -------------------------------------------

export async function updateFocusAction(fd: FormData) {
  const data = formToObject(fd);
  return run("/vorgehen", async (actor) => {
    await updateFocus(actor, data);
    return "/vorgehen#fokus";
  }, "Strategischer Fokus gespeichert – gilt ab sofort für alle KI-Agenten und Standardaufgaben.");
}

// --- Kunden-Health-Check (Etappe 23) -------------------------------------------

export async function saveHealthAnswerAction(fd: FormData) {
  const data = formToObject(fd);
  const id = data.accountId ?? "";
  const items = fd.getAll("items").filter((x): x is string => typeof x === "string");
  return run(`/kunden/${id}/health`, async (actor) => {
    await saveHealthAnswer(actor, id, { ...data, items });
  }, "Antwort gespeichert – nächste Frage.");
}

export async function updateOrderDatesAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, "/kunden"), async (actor) => {
    await updateOrderDates(actor, data.orderId ?? "", data);
  }, "Einsatzdaten gespeichert – die Verlängerungsregel richtet sich danach.");
}

export async function recordExistingEngagementAction(fd: FormData) {
  const data = formToObject(fd);
  const id = data.accountId ?? "";
  return run(`/kunden/${id}/health`, async (actor) => {
    await recordExistingEngagement(actor, id, data);
  }, "Laufender Einsatz nachgetragen.");
}

// --- Kundenagenda, Beschaffungsweg, Berater, SOS (Etappe 26) -------------------

export async function createInitiativeAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, `/kunden/${data.accountId ?? ""}`), async (actor) => {
    await createInitiative(actor, data);
  }, "In die Kundenagenda aufgenommen.");
}

export async function setInitiativeStatusAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, "/kunden"), async (actor) => {
    await setInitiativeStatus(actor, data.initiativeId ?? "", data);
  }, "Kundenagenda aktualisiert.");
}

export async function linkChanceInitiativeAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, `/bedarfe/${data.opportunityId ?? ""}`), async (actor) => {
    await linkChanceToInitiative(actor, data.opportunityId ?? "", data.initiativeId || null);
  }, "Zuordnung zur Kundeninitiative gespeichert.");
}

export async function updateProcurementAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, `/kunden/${data.accountId ?? ""}`), async (actor) => {
    await updateProcurement(actor, data.accountId ?? "", data);
  }, "Beschaffungsweg gespeichert.");
}

export async function setOrderConsultantAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, "/kunden"), async (actor) => {
    await setOrderConsultant(actor, data.orderId ?? "", data);
  }, "Berater im Einsatz gespeichert.");
}

export async function createSosAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, `/kunden/${data.accountId ?? ""}`), async (actor) => {
    await createSos(actor, data);
  }, "SOS ausgelöst – BD und Principal sehen es sofort auf der Startseite.");
}

export async function changeSosStatusAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, "/start"), async (actor) => {
    await changeSosStatus(actor, data.sosId ?? "", data);
  }, "SOS aktualisiert.");
}

// --- Vertrag am Einsatz (Feedback Pilot) --------------------------------------

export async function setContractLinkAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, "/kunden"), async (actor) => {
    await setContractLink(actor, data.orderId ?? "", data);
  }, "Verweis auf Vertrag/Bestellung gespeichert.");
}

export async function attachContractAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, "/kunden"), async (actor) => {
    await attachContractDocument(actor, data.orderId ?? "", fileFrom(fd, "file"));
  }, "Vertrag/Bestellung hochgeladen – sichtbar für das Kundenteam (BD, Principal, Sales Operations, Beteiligte).");
}

// --- Kollaborationskern (Etappe 27) ------------------------------------------

export async function createWorkItemAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, "/meine-arbeit"), async (actor) => {
    const w = await createWorkItem(actor, data);
    if (data.open === "1") return `/vorgaenge/${w.id}`;
  }, "Vorgang angelegt.");
}

export async function workItemAction(fd: FormData) {
  const data = formToObject(fd);
  const labels: Record<string, string> = {
    ANNEHMEN: "Angenommen.",
    UEBERNEHMEN: "Übernommen – der Vorgang liegt jetzt bei dir.",
    ABLEHNEN: "Abgelehnt – die Auftraggeber:in ist informiert.",
    STARTEN: "In Arbeit.",
    FORTSETZEN: "Weiter in Arbeit.",
    BLOCKIEREN: "Als blockiert markiert.",
    ABSCHLIESSEN: "Abgeschlossen.",
    ABNEHMEN: "Abgenommen – erledigt.",
    ZURUECKGEBEN: "Zur Nacharbeit zurückgegeben.",
    VERWERFEN: "Verworfen.",
    ERNEUT_ANFRAGEN: "Erneut angefragt.",
  };
  return run(backOf(data, `/vorgaenge/${data.workItemId ?? ""}`), async (actor) => {
    const u = await actOnWorkItem(actor, data.workItemId ?? "", data);
    if (data.action === "ABSCHLIESSEN" && u.status === "ZUR_PRUEFUNG") throw new PendingInfo("Ergebnis übergeben – liegt jetzt zur Prüfung bei der Auftraggeber:in.");
  }, labels[data.action ?? ""] ?? "Gespeichert.");
}

export async function reassignWorkItemAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, `/vorgaenge/${data.workItemId ?? ""}`), async (actor) => {
    await reassignWorkItem(actor, data.workItemId ?? "", data);
  }, "Umverteilt.");
}

export async function updateWorkItemAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, `/vorgaenge/${data.workItemId ?? ""}`), async (actor) => {
    await updateWorkItem(actor, data.workItemId ?? "", data);
  }, "Gespeichert.");
}

export async function toggleChecklistAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, `/vorgaenge/${data.workItemId ?? ""}`), async (actor) => {
    await toggleChecklistItem(actor, data.workItemId ?? "", data);
  }, "Checkliste aktualisiert.");
}

export async function watchWorkItemAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, `/vorgaenge/${data.workItemId ?? ""}`), async (actor) => {
    await setWatching(actor, data.workItemId ?? "", data.watch === "1");
  }, data.watch === "1" ? "Du beobachtest diesen Vorgang." : "Du beobachtest diesen Vorgang nicht mehr.");
}

export async function addCommentAction(fd: FormData) {
  const data = formToObject(fd);
  const back = backOf(data, "/start");
  return run(back, async (actor) => {
    const r = await addComment(actor, data);
    if (r.skipped.length) throw new PendingInfo(`Kommentar gespeichert. Nicht erwähnt, weil ohne Zugriff: ${r.skipped.join(", ")}.`);
  }, "Kommentar gespeichert.");
}

export async function editCommentAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, "/start"), async (actor) => {
    await editComment(actor, data.commentId ?? "", data);
  }, "Kommentar geändert.");
}

export async function deleteCommentAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, "/start"), async (actor) => {
    await deleteComment(actor, data.commentId ?? "");
  }, "Kommentar gelöscht.");
}

export async function openNotificationAction(fd: FormData) {
  const data = formToObject(fd);
  const actor = await requireActor();
  const target = await openNotification(actor, data.notificationId ?? "");
  revalidatePath("/", "layout");
  redirect(target);
}

export async function markNotificationsReadAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, "/benachrichtigungen"), async (actor) => {
    await markRead(actor, data.notificationId || null);
  }, "Als gelesen markiert.");
}

export async function saveNotificationPrefsAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, "/einstellungen"), async (actor) => {
    await saveMyPrefs(actor, data);
  }, "Benachrichtigungen gespeichert.");
}

export async function addAbsenceAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, "/einstellungen"), async (actor) => {
    await addAbsence(actor, data);
  }, "Abwesenheit eingetragen – neue Anfragen gehen in dieser Zeit an deine Vertretung.");
}

export async function removeAbsenceAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, "/einstellungen"), async (actor) => {
    await removeAbsence(actor, data.absenceId ?? "");
  }, "Abwesenheit entfernt.");
}

export async function createTeamAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, "/verwaltung/teams"), async (actor) => {
    await createTeam(actor, data);
  }, "Team angelegt.");
}

export async function setTeamMemberAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, "/verwaltung/teams"), async (actor) => {
    if (data.remove === "1") await removeTeamMember(actor, data.teamId ?? "", data.userId ?? "");
    else await setTeamMember(actor, data.teamId ?? "", data);
  }, "Team aktualisiert.");
}

export async function saveServiceTypeAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, "/verwaltung/teams"), async (actor) => {
    await saveServiceType(actor, data.teamId ?? "", data);
  }, "Anfrageart gespeichert.");
}

// --- Besetzung (Etappe 28, E1) ------------------------------------------------

function requireStaffingFlag() {
  if (getConfig().FEATURE_BESETZUNG !== "true") throw new DomainError("FEATURE_OFF", "Der Bereich Besetzung ist in dieser Umgebung nicht eingeschaltet.", 404);
}

export async function createPositionAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, `/bedarfe/${data.opportunityId ?? ""}#besetzung`), async (actor) => {
    requireStaffingFlag();
    const p = await createPosition(actor, data.opportunityId ?? "", data);
    if (data.open === "1") return `/besetzung/${p.id}`;
  }, "Position als Entwurf angelegt – Mindestangaben prüfen und auf „offen“ setzen.");
}

export async function quickFillAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, `/bedarfe/${data.opportunityId ?? ""}#besetzung`), async (actor) => {
    requireStaffingFlag();
    const r = await quickFill(actor, data.opportunityId ?? "", data);
    return `/einsaetze/${r.engagement.id}`;
  }, "Besetzt – die Einsatzakte ist angelegt. Start, Betreuung und Unterlagen pflegst du hier; ein offener Suchauftrag wurde erledigt.");
}

export async function updatePositionAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, `/besetzung/${data.positionId ?? ""}`), async (actor) => {
    requireStaffingFlag();
    await updatePosition(actor, data.positionId ?? "", data);
  }, "Position gespeichert.");
}

export async function changePositionStatusAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, `/besetzung/${data.positionId ?? ""}`), async (actor) => {
    requireStaffingFlag();
    await changePositionStatus(actor, data.positionId ?? "", data);
  }, data.status === "OFFEN" ? "Position ist offen – jetzt kann ein Suchauftrag erteilt werden." : "Status geändert.");
}

export async function copyPositionAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, `/besetzung/${data.positionId ?? ""}`), async (actor) => {
    requireStaffingFlag();
    const p = await copyPosition(actor, data.positionId ?? "");
    return `/besetzung/${p.id}`;
  }, "Position kopiert (Entwurf).");
}

export async function requestSearchAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, `/besetzung/${data.positionId ?? ""}`), async (actor) => {
    requireStaffingFlag();
    await requestSearch(actor, data.positionId ?? "", data);
  }, "Suchauftrag an Sales Operations gestellt – wartet auf Übernahme.");
}

export async function addCandidacyAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, `/besetzung/${data.positionId ?? ""}#kandidaturen`), async (actor) => {
    requireStaffingFlag();
    await addCandidacy(actor, data.positionId ?? "", data);
  }, "Kandidatur angelegt.");
}

export async function updateCandidacyAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, "/besetzung"), async (actor) => {
    requireStaffingFlag();
    await updateCandidacy(actor, data.candidacyId ?? "", data);
  }, "Kandidatur gespeichert.");
}

export async function changeCandidacyStatusAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, "/besetzung"), async (actor) => {
    requireStaffingFlag();
    await changeCandidacyStatus(actor, data.candidacyId ?? "", data);
  }, "Status der Kandidatur geändert.");
}

export async function recordPresentationAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, "/besetzung"), async (actor) => {
    requireStaffingFlag();
    await recordPresentation(actor, data.candidacyId ?? "", data);
  }, "Vorstellung dokumentiert.");
}

export async function recordInterviewAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, "/besetzung"), async (actor) => {
    requireStaffingFlag();
    await recordInterview(actor, data.candidacyId ?? "", data);
  }, "Interview dokumentiert.");
}

export async function recordFeedbackAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, "/besetzung"), async (actor) => {
    requireStaffingFlag();
    await recordCustomerFeedback(actor, data.candidacyId ?? "", data);
  }, "Kundenrückmeldung festgehalten.");
}

export async function selectCandidacyAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, "/besetzung"), async (actor) => {
    requireStaffingFlag();
    const r = await selectCandidacy(actor, data.candidacyId ?? "", data);
    if (r.already) throw new PendingInfo("Diese Auswahl war bereits bestätigt – nichts geändert.");
  }, "Auswahl bestätigt – die Position ist besetzt. Weiter im Abschluss der Chance (Angebot/Auftrag).");
}

export async function updateFreelancerAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, `/besetzung/freelancer/${data.freelancerId ?? ""}`), async (actor) => {
    requireStaffingFlag();
    await updateFreelancer(actor, data.freelancerId ?? "", data);
  }, "Stammdaten gespeichert.");
}

export async function generateAdDraftAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, `/besetzung/${data.positionId ?? ""}#ausschreibung`), async (actor) => {
    requireStaffingFlag();
    await generateAdDraft(actor, data.positionId ?? "", data);
  }, "Ausschreibungsentwurf erstellt – bitte prüfen, ggf. bearbeiten und freigeben.");
}

export async function saveAdDraftAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, `/besetzung/${data.positionId ?? ""}#ausschreibung`), async (actor) => {
    requireStaffingFlag();
    await saveAdDraft(actor, data.positionId ?? "", data);
  }, data.approve ? "Ausschreibungstext freigegeben – Veröffentlichen bleibt ein manueller Schritt (Text kopieren)." : data.withdraw ? "Freigabe zurückgenommen." : "Entwurf gespeichert.");
}

export async function createStaffingIntakeAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, `/bedarfe/${data.opportunityId ?? ""}#besetzung`), async (actor) => {
    requireStaffingFlag();
    const r = await createStaffingIntake(actor, data.opportunityId ?? "", data);
    return `/besetzung/eingang/${r.id}`;
  }, "Text aufgenommen – bitte die Vorschläge prüfen.");
}

export async function applyStaffingIntakeAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, `/besetzung/eingang/${data.intakeId ?? ""}`), async (actor) => {
    requireStaffingFlag();
    await applyStaffingIntake(actor, data.intakeId ?? "", data);
    return `/bedarfe/${data.opportunityId ?? ""}#besetzung`;
  }, data.decision === "VERWERFEN" ? "Texteingang verworfen." : "Positionen als Entwurf übernommen.");
}

// --- Einsatz und Betreuung (Etappe 29, E2) --------------------------------------

export async function updateEngagementAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, `/einsaetze/${data.engagementId ?? ""}`), async (actor) => {
    requireStaffingFlag();
    await updateEngagement(actor, data.engagementId ?? "", data);
  }, "Einsatz gespeichert.");
}

export async function changeEngagementStatusAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, `/einsaetze/${data.engagementId ?? ""}`), async (actor) => {
    requireStaffingFlag();
    await changeEngagementStatus(actor, data.engagementId ?? "", data);
  }, "Einsatzstatus geändert.");
}

export async function addPeriodAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, `/einsaetze/${data.engagementId ?? ""}#konditionen`), async (actor) => {
    requireStaffingFlag();
    await addPeriod(actor, data.engagementId ?? "", data);
  }, "Periode angelegt – der bisherige Stand bleibt erhalten.");
}

export async function saveProcurementProfileAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, `/kunden/${data.accountId ?? ""}#beschaffungsprofil`), async (actor) => {
    requireStaffingFlag();
    await saveProcurementProfile(actor, data.accountId ?? "", data);
  }, data.approve ? "Beschaffungsprofil freigegeben." : "Beschaffungsprofil gespeichert (noch nicht freigegeben).");
}

export async function addContractDocumentAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, `/einsaetze/${data.engagementId ?? ""}#vertraege`), async (actor) => {
    requireStaffingFlag();
    const r = await addContractDocument(actor, data.engagementId ?? "", data, fileFrom(fd, "file"));
    if (r.suggestion?.docType && r.suggestion.docType !== data.docType) throw new PendingInfo(`Unterlage gespeichert. Hinweis aus dem Dokumenttext: Es sieht nach „${r.suggestion.docType}“ aus („${r.suggestion.evidence.slice(0, 80)}…“) – bitte Typ prüfen.`);
    if (r.suggestion?.extractStatus === "LEER") throw new PendingInfo("Unterlage gespeichert. Scan erkannt – der Inhalt wurde nicht ausgewertet; Angaben bitte manuell prüfen.");
  }, "Unterlage gespeichert.");
}

export async function setContractDocumentStatusAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, `/einsaetze/${data.engagementId ?? ""}#vertraege`), async (actor) => {
    requireStaffingFlag();
    await setContractDocumentStatus(actor, data.engagementId ?? "", data.documentId ?? "", data);
  }, "Vertragsstatus gesetzt.");
}

export async function linkContractDocumentAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, `/einsaetze/${data.engagementId ?? ""}#vertraege`), async (actor) => {
    requireStaffingFlag();
    await linkContractDocument(actor, data.engagementId ?? "", data.documentId ?? "");
  }, "Unterlage verknüpft.");
}

export async function requestCareHandoverAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, `/einsaetze/${data.engagementId ?? ""}#betreuung`), async (actor) => {
    requireStaffingFlag();
    await requestCareHandover(actor, data.engagementId ?? "", data);
  }, "Betreuungsübergabe angefragt – die Zuordnung wird mit der Annahme wirksam.");
}

export async function setCareDirectAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, `/einsaetze/${data.engagementId ?? ""}#betreuung`), async (actor) => {
    requireStaffingFlag();
    await setCareDirect(actor, data.engagementId ?? "", data);
  }, "Betreuung umgestellt.");
}

export async function createCheckinAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, `/einsaetze/${data.engagementId ?? ""}#checkins`), async (actor) => {
    requireStaffingFlag();
    await createCheckin(actor, data.engagementId ?? "", data);
  }, "Check-in angelegt.");
}

export async function checkinAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, "/meine-arbeit#checkins"), async (actor) => {
    requireStaffingFlag();
    const r = await actOnCheckin(actor, data.checkinId ?? "", data);
    if (data.action === "ERLEDIGEN" && data.salesHint && !r.salesSignalId) throw new PendingInfo("Check-in erledigt. Der Sales-Hinweis konnte nicht als Signal angelegt werden (kein Bearbeitungsrecht am Setup) – der BD wurde benachrichtigt.");
  }, data.action === "ERLEDIGEN" ? "Check-in erledigt – der nächste Kunden-Check-in ist in 42 Tagen fällig." : "Check-in aktualisiert.");
}

export async function renewalDecisionAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, `/einsaetze/${data.engagementId ?? ""}#verlaengerung`), async (actor) => {
    requireStaffingFlag();
    await upsertRenewalDecision(actor, data.engagementId ?? "", data);
  }, data.status === "BESTAETIGT" ? "Verlängerung bestätigt – neue Periode angelegt, Einsatzende angepasst." : "Verlängerungsstand gespeichert.");
}

// --- Moco-Anbindung (Etappe 31) -----------------------------------------------

export async function mocoPreviewAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, "/moco"), async (actor) => {
    const { buildImportPreview } = await import("@/modules/moco/import");
    const imp = await buildImportPreview(actor);
    return `/moco/import/${imp.id}`;
  }, "Vorschau aus Moco geladen – bitte Zeile für Zeile prüfen und dann übernehmen.");
}

export async function mocoSaveDecisionsAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, `/moco/import/${data.importId ?? ""}`), async (actor) => {
    const { decisionsFromForm, saveDecisions } = await import("@/modules/moco/import");
    await saveDecisions(actor, data.importId ?? "", decisionsFromForm(data));
  }, "Entscheidungen gespeichert.");
}

export async function mocoApplyImportAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, `/moco/import/${data.importId ?? ""}`), async (actor) => {
    const { applyImport, decisionsFromForm } = await import("@/modules/moco/import");
    const r = await applyImport(actor, data.importId ?? "", decisionsFromForm(data));
    if (r.errors.length) throw new PendingInfo(`Übernommen: ${r.created.einsaetze} Einsätze, ${r.created.setups} Setups, ${r.created.kunden} Kunden, ${r.created.nutzer} Zugänge, ${r.created.freelancer} Freelancer, ${r.created.verknuepft} Verknüpfungen – ${r.errors.length} Zeile(n) mit Fehler (siehe Ergebnis).`);
  }, "Import übernommen.");
}

export async function mocoDiscardImportAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, "/moco"), async (actor) => {
    const { discardImport } = await import("@/modules/moco/import");
    await discardImport(actor, data.importId ?? "");
  }, "Vorschau verworfen.");
}

export async function mocoSyncNowAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, "/moco"), async (actor) => {
    const { canRunMocoImport } = await import("@/modules/moco/import");
    if (!canRunMocoImport(actor)) throw new DomainError("FORBIDDEN", "Den Abgleich stoßen CEO oder Principal an.", 403);
    const { runJob } = await import("@/modules/notifications/worker");
    const { runMocoSync } = await import("@/modules/moco/sync");
    let counts: Record<string, number> = {};
    await runJob("moco-sync", async () => (counts = (await runMocoSync({ since: data.since || undefined })) as unknown as Record<string, number>));
    throw new PendingInfo(`Abgleich gelaufen: ${counts.projekteGeprueft ?? 0} Projekte geprüft, ${counts.hinweise ?? 0} neue Hinweise, ${counts.neueNutzer ?? 0} neue Zugänge, ${counts.neueFreelancer ?? 0} neue Freelancer.`);
  }, "Abgleich gelaufen.");
}

export async function mocoHintAction(fd: FormData) {
  const data = formToObject(fd);
  return run(backOf(data, "/moco"), async (actor) => {
    const { resolveHint } = await import("@/modules/moco/sync");
    await resolveHint(actor, data.hintId ?? "", data.decision === "VERWERFEN" ? "VERWERFEN" : "UEBERNEHMEN");
  }, data.decision === "VERWERFEN" ? "Hinweis verworfen." : "Hinweis übernommen.");
}

export async function mocoRepairFreelancersAction(fd: FormData) {
  const data = formToObject(fd);
  const ids = fd.getAll("userId").map(String).filter(Boolean);
  return run(backOf(data, "/moco"), async (actor) => {
    const { repairFreelancers } = await import("@/modules/moco/import");
    if (!ids.length) throw new DomainError("VALIDATION", "Keine Person ausgewählt.", 400);
    const r = await repairFreelancers(actor, ids);
    throw new PendingInfo(`${r.converted} Person(en) in den Freelancer-Pool überführt, ${r.movedEngagements} Einsatz/Einsätze umgehängt.`);
  }, "Korrektur ausgeführt.");
}
