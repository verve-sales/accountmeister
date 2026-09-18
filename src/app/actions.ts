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

async function run(back: string, fn: (actor: Actor) => Promise<string | void>, okMessage: string): Promise<never> {
  const actor = await requireActor();
  let next: string | void;
  try {
    next = await fn(actor);
  } catch (e) {
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
  return run(`/setups/${id}`, async (actor) => {
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
