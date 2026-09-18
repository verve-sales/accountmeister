"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { DomainError } from "@/lib/errors";
import { getCurrentActor, getSession } from "@/modules/identity/session";
import { resolveDevLoginUser } from "@/modules/identity/dev-login";
import type { Actor } from "@/modules/identity/actor";
import { createSetup, updateSetup, addMember } from "@/modules/setups/service";
import { captureObservation, changeSignalStatus, takeOverSignal } from "@/modules/signals/service";
import { createHandover, respondToHandover } from "@/modules/handovers/service";
import { changeActionStatus, createAction } from "@/modules/actions/service";
import { createAccount } from "@/modules/accounts/service";
import { createPerson, setPersonFunction, setRelationship } from "@/modules/people/service";
import { addAccessPlanStep, changeAccessPlanStatus, createAccessPlan } from "@/modules/accesspaths/service";
import { addDecision, confirmReview, correctReview, createReview, saveReviewDraft } from "@/modules/reviews/service";
import { changePriority, createPriority, saveAccountPlanSnapshot } from "@/modules/accountplan/service";
import { changeArtifactStatus, createDraft, saveNewVersion } from "@/modules/artifacts/service";

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
  redirect(url.pathname + url.search);
}

/** Kein Fehler, sondern ein Hinweis, der die Erfolgsmeldung ersetzt (z. B. „Zustimmung gespeichert, noch nicht vereinbart“). */
class PendingInfo extends Error {}

async function run(back: string, fn: (actor: Actor) => Promise<string | void>, okMessage: string): Promise<never> {
  const actor = await requireActor();
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

export async function devLoginAction(fd: FormData) {
  const userId = String(fd.get("userId") ?? "");
  const user = await resolveDevLoginUser(userId);
  if (!user) withFeedback("/anmelden", "fehler", "Nutzer nicht gefunden.");
  const session = await getSession();
  session.userId = user.id;
  session.mode = "development";
  await session.save();
  redirect("/meine-arbeit");
}

export async function logoutAction() {
  const session = await getSession();
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

// --- Hinweise ---------------------------------------------------------------

export async function captureObservationAction(fd: FormData) {
  const data = formToObject(fd);
  const id = data.setupId ?? "";
  return run(data.reviewId ? `/weeklys/${data.reviewId}` : `/setups/${id}`, async (actor) => {
    await captureObservation(actor, data);
  }, "Beobachtung erfasst und als Hinweis (Neu) gespeichert.");
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
  }, "Hinweis-Status geändert.");
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
