import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db/client";
import type { SetupContext } from "@/modules/identity/authz";
import { canEditSetup, canViewSetup, loadSetupContext } from "@/modules/identity/authz";
import { ConflictError, ForbiddenError, NotFoundError, TransitionError, ValidationError } from "@/lib/errors";
import { getConfig } from "@/lib/config";
import { feedbackReasonLabel } from "@/lib/labels";
import { recordAudit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/identity/actor";
import { getAIProvider } from "@/modules/ai";
import { INTAKE_PROMPT_VERSION, type AIProvider } from "@/modules/ai/provider";
import { resolveTaskOptions } from "@/modules/ai/settings";
import { intakeItemSchema, intakeOutputSchema, type AssistantItem, type IntakeItem } from "@/modules/ai/schemas";
import { listVisibleAccounts } from "@/modules/accounts/service";
import { parseRelativeDue, todayIso } from "@/modules/work/calendar";
import { parseDueHint } from "@/modules/agenda/service";

/**
 * Eingangs-Auswertung (Etappe 36) – der „Gamechanger“: Mail, Notiz oder Protokoll rein, Karten raus.
 *
 *   Text → Kunde/Setup erkennen (Absender, Adressen, Namen, Einsätze) → Lagebild mit Kürzeln (Chancen C1…,
 *   Einsätze E1…, offene Aktionen A1…, offene Fragen Q1…, Personen P1…) → KI-Karten → Beleg- und Kürzelprüfung
 *   → Vorschläge (Typ KARTE) → ein Klick je Karte.
 *
 * Die KI legt nichts an. Jede Karte trägt die wörtliche Textstelle. Kürzel werden serverseitig aufgelöst –
 * ein unbekanntes Kürzel macht die Karte ungültig, statt etwas Falsches zu ändern.
 */

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const ws = (t: string) => t.replace(/[\s ​]+/g, " ").replace(/[„“”"]/g, '"').replace(/[‚‘’']/g, "'").replace(/[–—]/g, "-").trim();
const norm = (s: string) => s.toLowerCase().replace(/\(.*?\)/g, " ").replace(/^(frau|herr|fr\.|hr\.)\s+/, "").replace(/[^a-zäöüß0-9@.\s-]/g, " ").replace(/\s+/g, " ").trim();
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export type Participant = { name: string; email?: string };

// ---------------------------------------------------------------------------
// 1) Kunde und Setup erkennen
// ---------------------------------------------------------------------------

export type Route = {
  ctx: SetupContext | null;
  account: typeof schema.accounts.$inferSelect | null;
  reason: string;
  confident: boolean;
  /** über eine Kunden-Kennung (Domäne/Kürzel) zugeordnet – dann eindeutig, die KI überstimmt das nicht */
  byKey?: boolean;
  /** fremde, als Kennung taugliche Mail-Domänen im Eingang (zum Lernen bei Neu-/Umzuordnung) */
  domains?: string[];
};

/** Allgemeine Wörter, die in Kundennamen vorkommen, aber nichts über den Kunden sagen (z. B. „Agent Platforms“). */
const GENERIC_NAME_WORDS = new Set(["gmbh", "gruppe", "group", "holding", "versicherung", "versicherungen", "bank", "fiktiv", "financial", "services", "service", "solutions", "consulting", "digital", "platform", "platforms", "plattform", "agent", "agents", "systems", "system", "software", "technology", "technologies", "partner", "partners", "international", "deutschland", "germany", "europe", "data", "cloud", "global", "management", "kreditbank", "leasing", "insurance"]);

/** Kunde/Setup aus Absender, E-Mail-Domänen, Kunden-, Personen- und Einsatznamen im Text erkennen – nur sichtbare Kunden. */
export async function routeText(actor: Actor, text: string, participants: Participant[] = [], hintSetupId?: string): Promise<Route> {
  if (hintSetupId) {
    const ctx = await loadSetupContext(actor, hintSetupId);
    if (!ctx || !canViewSetup(actor, ctx)) throw new NotFoundError("Setup");
    return { ctx, account: ctx.account, reason: "gewähltes Setup", confident: true };
  }
  const accounts = (await listVisibleAccounts(actor)).filter((a) => a.status !== "ARCHIVED");
  if (!accounts.length) return { ctx: null, account: null, reason: "keine sichtbaren Kunden", confident: false };
  const ids = accounts.map((a) => a.id);
  const [persons, engs, users] = await Promise.all([
    db.query.persons.findMany({ where: inArray(schema.persons.accountId, ids) }),
    db.query.engagements.findMany({ where: and(inArray(schema.engagements.accountId, ids), inArray(schema.engagements.status, ["GEPLANT", "AKTIV", "PAUSIERT", "ENDET"])) }),
    db.query.users.findMany({ where: eq(schema.users.workspaceId, actor.workspaceId), columns: { id: true, displayName: true, email: true } }),
  ]);
  const ownDomains = new Set(users.map((u) => u.email.split("@")[1]?.toLowerCase()).filter((d): d is string => !!d));
  const { keyDomainOf, domainMatches } = await import("@/modules/accounts/keys");
  const flat = ` ${norm(text)} `;
  const score = new Map<string, { n: number; why: string[] }>();
  const add = (accountId: string | null, n: number, why: string) => {
    if (!accountId || !ids.includes(accountId)) return;
    const s = score.get(accountId) ?? { n: 0, why: [] };
    s.n += n;
    if (!s.why.includes(why)) s.why.push(why);
    score.set(accountId, s);
  };
  // E-Mail-Adressen: aus Beteiligten und aus dem Text
  const emails = new Set<string>([...participants.map((p) => (p.email ?? "").toLowerCase()).filter(Boolean), ...[...text.matchAll(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g)].map((m) => m[0].toLowerCase())]);
  const foreign = [...emails].filter((e) => !ownDomains.has(e.split("@")[1] ?? ""));
  const keyDomains = [...new Set(foreign.map((e) => keyDomainOf(e, ownDomains)).filter((d): d is string => !!d))];
  // 0) Kunden-Kennungen: Domäne oder Kürzel – eindeutig, schlägt alle Namensheuristiken
  const keyHits = new Map<string, string>();
  for (const a of accounts) {
    const d = keyDomains.find((x) => a.mailDomains.some((k) => domainMatches(x, k)));
    if (d) keyHits.set(a.id, `Kennung: Domäne ${d}`);
    else {
      const alias = a.aliases.find((al) => { const n = norm(al); return n.length >= 2 && flat.includes(` ${n} `); });
      if (alias) keyHits.set(a.id, `Kennung: Kürzel „${alias}“`);
    }
  }
  const domainKeyHits = [...keyHits.entries()].filter(([, why]) => why.startsWith("Kennung: Domäne"));
  const decisive = domainKeyHits.length === 1 ? domainKeyHits : domainKeyHits.length === 0 && keyHits.size === 1 ? [...keyHits.entries()] : [];
  if (decisive.length === 1) {
    const [accId, why] = decisive[0]!;
    const account = accounts.find((a) => a.id === accId)!;
    const ctx = await pickSetup(actor, account.id, flat, engs, (e) => (e.freelancerId ? null : users.find((u) => u.id === e.internalUserId)?.displayName ?? null));
    return { ctx, account, reason: why, confident: true, byKey: true, domains: keyDomains };
  }
  for (const e of foreign) {
    for (const p of persons) if (p.email?.toLowerCase() === e) add(p.accountId, 10, `Absender/Adresse ${e} ist bekannt`);
    const dom = e.split("@")[1] ?? "";
    for (const p of persons) if (p.email && p.email.toLowerCase().endsWith(`@${dom}`)) add(p.accountId, 5, `Domäne ${dom}`);
  }
  // Kundenname im Text: ganzes Wort; als Wortteil nur ab 6 Zeichen (z. B. „BarmeniaGothaer“ ↔ „Gothaer“); allgemeine Wörter zählen nicht
  for (const a of accounts) {
    const words = norm(a.name).split(" ").filter((w) => w.length >= 4 && !GENERIC_NAME_WORDS.has(w));
    if (words.some((w) => flat.includes(` ${w} `) || (w.length >= 6 && flat.includes(w)))) add(a.id, 6, `Kundenname „${a.name}“ im Text`);
    for (const d of keyDomains) if (words.some((w) => w.length >= 5 && d.split(".").some((part) => part === w || (w.length >= 6 && part.includes(w))))) add(a.id, 6, `Domäne ${d}`);
  }
  // Personen (eindeutiger Nachname) und Einsatzpersonen
  for (const p of persons) {
    const last = norm(p.displayName).split(" ").pop() ?? "";
    if (last.length >= 4 && flat.includes(` ${last} `) && persons.filter((x) => (norm(x.displayName).split(" ").pop() ?? "") === last).length === 1) add(p.accountId, 3, `Person ${p.displayName.replace(/\(.*?\)/g, "").trim()}`);
  }
  const fls = await db.query.freelancers.findMany({ where: inArray(schema.freelancers.id, [...engs.map((e) => e.freelancerId).filter((x): x is string => !!x), "-"]), columns: { id: true, displayName: true } });
  const engPerson = (e: (typeof engs)[number]) => (e.freelancerId ? fls.find((f) => f.id === e.freelancerId)?.displayName : users.find((u) => u.id === e.internalUserId)?.displayName) ?? "";
  for (const e of engs) {
    const last = norm(engPerson(e)).split(" ").pop() ?? "";
    if (last.length >= 4 && flat.includes(` ${last} `)) add(e.accountId, 4, `Einsatz ${engPerson(e).replace(/\(.*?\)/g, "").trim()}`);
  }
  const ranked = [...score.entries()].sort((a, b) => b[1].n - a[1].n);
  if (!ranked.length) return { ctx: null, account: null, reason: "kein bekannter Kunde erkannt", confident: false, domains: keyDomains };
  const [bestId, best] = ranked[0]!;
  const second = ranked[1]?.[1].n ?? 0;
  const account = accounts.find((a) => a.id === bestId)!;
  // Sicher nur mit Adress-/Domänenbezug oder sehr deutlichem Vorsprung; reine Namensähnlichkeit bleibt unsicher
  const confident = best.n >= 5 && best.n >= second * 2 && best.why.some((w) => /Adresse|Domäne|Einsatz/.test(w));
  // Setup: Einsatz-/Namens-Treffer, sonst einziges bzw. zuletzt aktives bearbeitbares Setup
  const setups = await db.query.projectSetups.findMany({ where: eq(schema.projectSetups.accountId, account.id), orderBy: desc(schema.projectSetups.updatedAt) });
  const editable: SetupContext[] = [];
  for (const s of setups.filter((x) => x.status !== "ARCHIVIERT")) {
    const c = await loadSetupContext(actor, s.id);
    if (c && canViewSetup(actor, c) && canEditSetup(actor, c)) editable.push(c);
  }
  const engHit = engs.find((e) => e.accountId === account.id && (() => { const last = norm(engPerson(e)).split(" ").pop() ?? ""; return last.length >= 4 && flat.includes(` ${last} `); })());
  const byName = editable.find((c) => norm(c.setup.name).length >= 4 && flat.includes(norm(c.setup.name)));
  const ctx = (engHit && editable.find((c) => c.setup.id === engHit.setupId)) || byName || editable[0] || null;
  return { ctx, account, reason: best.why.slice(0, 3).join(" · "), confident, domains: keyDomains };
}

/** Setup für einen über Kennung erkannten Kunden: Einsatz- oder Setupname im Text, sonst zuletzt aktives bearbeitbares Setup. */
async function pickSetup(actor: Actor, accountId: string, flat: string, engs: (typeof schema.engagements.$inferSelect)[], internalName: (e: typeof schema.engagements.$inferSelect) => string | null): Promise<SetupContext | null> {
  const setups = await db.query.projectSetups.findMany({ where: eq(schema.projectSetups.accountId, accountId), orderBy: desc(schema.projectSetups.updatedAt) });
  const editable: SetupContext[] = [];
  for (const s of setups.filter((x) => x.status !== "ARCHIVIERT")) {
    const c = await loadSetupContext(actor, s.id);
    if (c && canViewSetup(actor, c) && canEditSetup(actor, c)) editable.push(c);
  }
  const mine = engs.filter((e) => e.accountId === accountId);
  const fls = mine.some((e) => e.freelancerId) ? await db.query.freelancers.findMany({ where: inArray(schema.freelancers.id, mine.map((e) => e.freelancerId).filter((x): x is string => !!x)), columns: { id: true, displayName: true } }) : [];
  const hit = mine.find((e) => {
    const name = e.freelancerId ? fls.find((f) => f.id === e.freelancerId)?.displayName ?? "" : internalName(e) ?? "";
    const last = norm(name).split(" ").pop() ?? "";
    return last.length >= 4 && flat.includes(` ${last} `);
  });
  const byName = editable.find((c) => norm(c.setup.name).length >= 4 && flat.includes(norm(c.setup.name)));
  return (hit && editable.find((c) => c.setup.id === hit.setupId)) || byName || editable[0] || null;
}

// ---------------------------------------------------------------------------
// 2) Lagebild mit Kürzeln
// ---------------------------------------------------------------------------

export type Refs = { C: Map<string, string>; E: Map<string, string>; A: Map<string, string>; Q: Map<string, string>; P: Map<string, string>; labels: Map<string, string> };

export async function buildLagebild(actor: Actor, route: Route): Promise<{ text: string; refs: Refs }> {
  const refs: Refs = { C: new Map(), E: new Map(), A: new Map(), Q: new Map(), P: new Map(), labels: new Map() };
  const lines: string[] = [`Heute: ${todayIso()}`, `Angemeldet: ${actor.displayName}`];
  const users = await db.query.users.findMany({ where: eq(schema.users.workspaceId, actor.workspaceId), columns: { displayName: true, email: true } });
  lines.push(`Verve-Personen (keine Kundenpersonen): ${users.map((u) => u.displayName.replace(/\s*\(.*?\)\s*/g, " ").trim()).join("; ")}`);
  if (!route.account) {
    const known = (await listVisibleAccounts(actor)).filter((a) => a.status !== "ARCHIVED").map((a) => a.name);
    lines.push(`Kein Kunde erkannt. Bekannte Kunden (für EINSORTIERUNG nur exakt so): ${known.join("; ") || "–"}`);
    return { text: lines.join("\n"), refs };
  }
  const acc = route.account;
  lines.push(`Kunde: ${acc.name} (${acc.orgType}) – erkannt über: ${route.reason}`);
  const setups = await db.query.projectSetups.findMany({ where: eq(schema.projectSetups.accountId, acc.id) });
  lines.push(`Setups: ${setups.map((s) => `${s.name}${route.ctx?.setup.id === s.id ? " (Ziel dieses Eingangs)" : ""}`).join("; ") || "noch keins"}`);
  const setupIds = setups.map((s) => s.id);
  const [opps, engs, actions, questions, persons] = await Promise.all([
    db.query.opportunities.findMany({ where: eq(schema.opportunities.accountId, acc.id), orderBy: desc(schema.opportunities.updatedAt) }),
    db.query.engagements.findMany({ where: and(eq(schema.engagements.accountId, acc.id), inArray(schema.engagements.status, ["GEPLANT", "AKTIV", "PAUSIERT", "ENDET"])) }),
    setupIds.length ? db.query.actions.findMany({ where: and(inArray(schema.actions.setupId, setupIds), inArray(schema.actions.status, ["VORGESCHLAGEN", "ANGENOMMEN", "IN_ARBEIT", "BLOCKIERT"])), orderBy: desc(schema.actions.createdAt), limit: 30 }) : Promise.resolve([]),
    setupIds.length ? db.query.openQuestions.findMany({ where: and(inArray(schema.openQuestions.setupId, setupIds), inArray(schema.openQuestions.status, ["OFFEN", "IN_KLAERUNG"])), orderBy: desc(schema.openQuestions.createdAt), limit: 20 }) : Promise.resolve([]),
    db.query.persons.findMany({ where: eq(schema.persons.accountId, acc.id) }),
  ]);
  const fns = persons.length ? await db.query.personFunctions.findMany({ where: inArray(schema.personFunctions.personId, persons.map((p) => p.id)) }) : [];
  const units = await db.query.orgUnits.findMany({ where: eq(schema.orgUnits.accountId, acc.id) });
  const activeOpps = opps.filter((o) => o.status !== "BEENDET").slice(0, 40);
  activeOpps.forEach((o, i) => { refs.C.set(`C${i + 1}`, o.id); refs.labels.set(`C${i + 1}`, o.title); });
  lines.push(`Chancen:\n${activeOpps.map((o, i) => `- C${i + 1}: ${o.title} [${o.status}, ${o.kind}]${o.needDescription ? ` – ${o.needDescription.slice(0, 120)}` : ""}`).join("\n") || "- keine"}`);
  const fls = await db.query.freelancers.findMany({ where: inArray(schema.freelancers.id, [...engs.map((e) => e.freelancerId).filter((x): x is string => !!x), "-"]), columns: { id: true, displayName: true } });
  const us = await db.query.users.findMany({ where: inArray(schema.users.id, [...engs.map((e) => e.internalUserId).filter((x): x is string => !!x), "-"]), columns: { id: true, displayName: true } });
  const renewals = engs.length ? await db.query.renewalDecisions.findMany({ where: and(inArray(schema.renewalDecisions.engagementId, engs.map((e) => e.id)), inArray(schema.renewalDecisions.status, ["ZU_KLAEREN", "IN_ABSTIMMUNG", "ANGEBOTEN"])) }) : [];
  engs.forEach((e, i) => {
    refs.E.set(`E${i + 1}`, e.id);
    const who = (e.freelancerId ? fls.find((f) => f.id === e.freelancerId)?.displayName : us.find((u) => u.id === e.internalUserId)?.displayName) ?? e.title;
    refs.labels.set(`E${i + 1}`, who.replace(/\s*\((fiktiv|intern)\)\s*/gi, " ").trim());
  });
  lines.push(
    `Laufende Einsätze:\n${
      engs
        .map((e, i) => {
          const who = (e.freelancerId ? fls.find((f) => f.id === e.freelancerId)?.displayName : us.find((u) => u.id === e.internalUserId)?.displayName) ?? e.title;
          const r = renewals.find((x) => x.engagementId === e.id);
          return `- E${i + 1}: ${who.replace(/\s*\((fiktiv|intern)\)\s*/gi, " ").trim()} – ${e.title} [${e.status}], Start ${e.actualStart ?? e.plannedStart ?? "?"}, Ende ${e.plannedEnd ?? "offen"}${r ? `, Verlängerung ${r.status === "ZU_KLAEREN" ? "zu klären" : `in Abstimmung${r.proposedTo ? ` bis ${r.proposedTo}` : ""}`}` : ""}`;
        })
        .join("\n") || "- keine"
    }`,
  );
  actions.forEach((a, i) => { refs.A.set(`A${i + 1}`, a.id); refs.labels.set(`A${i + 1}`, a.title); });
  if (actions.length) lines.push(`Offene Aktionen:\n${actions.map((a, i) => `- A${i + 1}: ${a.title} [${a.status}${a.dueDate ? `, bis ${a.dueDate}` : ""}]`).join("\n")}`);
  questions.forEach((q, i) => { refs.Q.set(`Q${i + 1}`, q.id); refs.labels.set(`Q${i + 1}`, q.question.slice(0, 80)); });
  if (questions.length) lines.push(`Offene Fragen:\n${questions.map((q, i) => `- Q${i + 1}: ${q.question.slice(0, 200)}`).join("\n")}`);
  persons.forEach((p, i) => { refs.P.set(`P${i + 1}`, p.id); refs.labels.set(`P${i + 1}`, p.displayName); });
  lines.push(
    `Bekannte Kundenpersonen:\n${
      persons
        .map((p, i) => {
          const f = fns.find((x) => x.personId === p.id && !x.validTo);
          const u = f?.orgUnitId ? units.find((x) => x.id === f.orgUnitId)?.name : null;
          return `- P${i + 1}: ${p.displayName}${f ? ` – ${f.functionTitle}` : ""}${u ? ` (${u})` : ""}${p.email ? ` <${p.email}>` : ""}`;
        })
        .join("\n") || "- keine"
    }`,
  );
  return { text: lines.join("\n"), refs };
}

/** Lernen aus Ablehnungen: die letzten abgelehnten Vorschläge mit Grund. */
export async function recentLessons(workspaceId: string): Promise<string[]> {
  const rows = await db.query.suggestions.findMany({ where: and(eq(schema.suggestions.workspaceId, workspaceId), eq(schema.suggestions.status, "ABGELEHNT")), orderBy: desc(schema.suggestions.decidedAt), limit: 15 });
  return rows.map((r) => `${r.title.slice(0, 100)} – abgelehnt: ${feedbackReasonLabel[r.feedbackReason ?? ""] ?? "ohne Grund"}${r.feedbackNote ? ` (${r.feedbackNote.slice(0, 80)})` : ""}`);
}

// ---------------------------------------------------------------------------
// 3) Auswerten
// ---------------------------------------------------------------------------

export const eingangInput = z.object({
  text: z.string().trim().min(12, "Bitte mehr Text einfügen (mind. 12 Zeichen).").max(60000),
  /** leer oder „AUTO“ = Kunde/Setup automatisch erkennen */
  setupId: z.string().optional().or(z.literal("")),
  title: z.string().trim().max(200).optional().or(z.literal("")),
});

export type EingangResult = { created: number; rejected: number; setupId: string | null; accountName: string | null; reason: string; sourceId: string; noSuggestionReason: string };

/** Freitext (Was gibt es Neues?) auswerten: Quelle anlegen, Kunde erkennen, Karten erzeugen. */
export async function eingangFromText(actor: Actor, raw: unknown, deps: { provider?: AIProvider } = {}): Promise<EingangResult> {
  const p = eingangInput.safeParse(raw);
  if (!p.success) throw new ValidationError(p.error.issues.map((i) => i.message).join("; "));
  const hint = p.data.setupId && p.data.setupId !== "AUTO" ? p.data.setupId : undefined;
  const route = await routeText(actor, p.data.text, [], hint);
  if (route.ctx && !canEditSetup(actor, route.ctx)) throw new ForbiddenError("In dieses Setup darfst du nichts einspielen.");
  const [src] = await db
    .insert(schema.sources)
    .values({ workspaceId: actor.workspaceId, setupId: route.ctx?.setup.id ?? null, type: "NOTIZ", title: p.data.title || `Eingang ${new Date().toLocaleDateString("de-DE")}`, body: p.data.text, origin: "Was gibt es Neues? (Eingang)", sourceTime: new Date(), ownerUserId: actor.userId, accessClass: route.ctx ? "SETUP" : "PERSOENLICH" })
    .returning();
  await db.insert(schema.sourceVersions).values({ sourceId: src!.id, versionNo: 1, body: p.data.text, contentHash: sha(p.data.text) });
  return evaluate(actor, { text: p.data.text, sourceId: src!.id, sourceLabel: "Notiz/Text aus „Was gibt es Neues?“", route }, deps);
}

/** Bestehende Quelle (Mail, Notiz, Protokoll) (neu) auswerten – auch zum erneuten Auswerten mit neuer Logik. */
export async function eingangFromSource(actor: Actor, sourceId: string, opts: { participants?: Participant[]; sourceLabel?: string; autoRoute?: boolean } = {}, deps: { provider?: AIProvider } = {}): Promise<EingangResult> {
  const src = await db.query.sources.findFirst({ where: and(eq(schema.sources.id, sourceId), eq(schema.sources.workspaceId, actor.workspaceId)) });
  if (!src) throw new NotFoundError("Quelle");
  if (src.ownerUserId !== actor.userId && src.setupId) {
    const c = await loadSetupContext(actor, src.setupId);
    if (!c || !canEditSetup(actor, c)) throw new ForbiddenError("Diese Quelle darfst du nicht auswerten.");
  } else if (src.ownerUserId !== actor.userId) throw new ForbiddenError("Diese Quelle darfst du nicht auswerten.");
  if (src.isLocked) throw new TransitionError("Eine gesperrte Quelle wird nicht ausgewertet.");
  const text = (src.body ?? "").trim();
  const route = await routeText(actor, text, opts.participants ?? [], opts.autoRoute ? undefined : src.setupId ?? undefined);
  if (route.ctx && src.setupId !== route.ctx.setup.id && !src.setupId) await db.update(schema.sources).set({ setupId: route.ctx.setup.id }).where(eq(schema.sources.id, src.id));
  // alte, noch offene Karten derselben Quelle sind überholt
  const old = await db.query.suggestions.findMany({ where: and(eq(schema.suggestions.workspaceId, actor.workspaceId), inArray(schema.suggestions.status, ["NEU", "GEPRUEFT"])) });
  const stale = old.filter((s) => s.sourceIds.includes(src.id));
  if (stale.length) await db.update(schema.suggestions).set({ status: "UEBERHOLT" }).where(inArray(schema.suggestions.id, stale.map((s) => s.id)));
  const label = opts.sourceLabel ?? `${src.type === "EMAIL" ? "E-Mail" : src.type === "PROTOKOLL" ? "Protokoll" : "Notiz"} „${src.title}“ vom ${src.sourceTime ? new Date(src.sourceTime).toLocaleDateString("de-DE") : "?"}`;
  return evaluate(actor, { text, sourceId: src.id, sourceLabel: label, route }, deps);
}

async function evaluate(actor: Actor, i: { text: string; sourceId: string; sourceLabel: string; route: Route }, deps: { provider?: AIProvider }): Promise<EingangResult> {
  const provider = deps.provider ?? getAIProvider();
  const info = provider.info();
  if (!info.enabled) throw new ValidationError("Die KI ist deaktiviert (Verwaltung → KI). Der Text ist gespeichert.");
  if (!provider.intake) throw new ValidationError("Der KI-Anbieter unterstützt die Eingangs-Auswertung nicht.");
  const { text: contextText, refs } = await buildLagebild(actor, i.route);
  const lessons = await recentLessons(actor.workspaceId);
  const taskOpts = await resolveTaskOptions(actor.workspaceId, "STRUCTURE_NOTE", info.id);
  const [job] = await db.insert(schema.aiJobs).values({ workspaceId: actor.workspaceId, type: "EINGANG", actorUserId: actor.userId, setupId: i.route.ctx?.setup.id ?? null, provider: info.id, model: taskOpts.model ?? info.model, promptVersion: INTAKE_PROMPT_VERSION, inputHash: sha(i.text), inputChars: i.text.length, dedupeKey: sha(`eingang:${i.sourceId}:${sha(i.text)}:${Date.now()}`) }).returning();
  let raw: unknown;
  try {
    raw = await provider.intake({ text: i.text, sourceLabel: i.sourceLabel, today: todayIso(), contextText, lessons }, { ...taskOpts, maxOutputTokens: Math.max(taskOpts.maxOutputTokens ?? 0, 9000) });
  } catch (e) {
    await db.update(schema.aiJobs).set({ status: "ABGELEHNT", error: e instanceof Error ? e.message.slice(0, 300) : "Anbieterfehler", finishedAt: new Date() }).where(eq(schema.aiJobs.id, job!.id));
    throw e;
  }
  const usage = provider.lastUsage?.() ?? null;
  const out = intakeOutputSchema.safeParse(raw);
  if (!out.success) {
    await db.update(schema.aiJobs).set({ status: "FEHLER", error: "Ausgabe entspricht nicht dem Schema", finishedAt: new Date() }).where(eq(schema.aiJobs.id, job!.id));
    throw new ValidationError("Die KI-Antwort war nicht auswertbar. Bitte noch einmal versuchen.");
  }
  const flat = ws(i.text);
  const users = await db.query.users.findMany({ where: eq(schema.users.workspaceId, actor.workspaceId), columns: { displayName: true, email: true } });
  const verveNames = new Set(users.map((u) => norm(u.displayName)));
  const verveLast = new Set([...verveNames].map((n) => n.split(" ").pop()!).filter((n) => n.length >= 3));
  const ownDomains = new Set(users.map((u) => u.email.split("@")[1]?.toLowerCase()).filter((d): d is string => !!d && !d.endsWith("example")));
  const isVerve = (name: string, email: string) => {
    const n = norm(name);
    return verveNames.has(n) || (/^(frau|herr)\s/i.test(name.trim()) && verveLast.has(n.split(" ").pop() ?? "")) || (!!email && (ownDomains.has(email.split("@")[1]?.toLowerCase() ?? "") || /verve/i.test(email)));
  };
  const valid: { item: IntakeItem; resolved: Resolved }[] = [];
  let rejected = 0;
  for (const rawItem of out.data.items) {
    const parsed = intakeItemSchema.safeParse(rawItem);
    if (!parsed.success) {
      rejected++;
      continue;
    }
    const item = parsed.data;
    if (!flat.includes(ws(item.evidenceQuote))) {
      rejected++;
      continue;
    }
    const r = resolveRefs(item, refs);
    if (r === null) {
      rejected++;
      continue;
    }
    if (item.type === "PERSON" && isVerve(item.displayName, item.email)) {
      rejected++;
      continue;
    }
    // Kunde schon erkannt → keine Kunden-/Einsortierungskarte
    // Kunde sicher erkannt → keine Kunden-/Einsortierungskarte; unsicher → die KI darf eine andere Zuordnung vorschlagen
    if (i.route.account && (item.type === "KUNDE" || item.type === "EINSORTIERUNG") && (i.route.confident || (item.type === "EINSORTIERUNG" && norm(item.accountName) === norm(i.route.account.name)))) continue;
    if (item.type === "AKTION") r.dueDate = ISO.test(item.dueDate) ? item.dueDate : parseRelativeDue(item.dueHint) ?? parseDueHint(item.dueHint) ?? "";
    if (item.type === "VERLAENGERUNG" && item.newEnd && !ISO.test(item.newEnd)) item.newEnd = "";
    valid.push({ item, resolved: r });
  }
  let created = 0;
  await db.transaction(async (tx) => {
    for (const { item, resolved } of valid) {
      const dedupeKey = sha(`KARTE:${item.type}:${JSON.stringify(cardKey(item))}:${ws(item.evidenceQuote).toLowerCase()}`);
      const dup = await tx.query.suggestions.findFirst({ where: and(eq(schema.suggestions.workspaceId, actor.workspaceId), eq(schema.suggestions.dedupeKey, dedupeKey), inArray(schema.suggestions.status, ["NEU", "GEPRUEFT", "ZURUECKGESTELLT"])) });
      if (dup) continue;
      const v = describeCard(item, refs.labels);
      await tx.insert(schema.suggestions).values({
        workspaceId: actor.workspaceId,
        type: "KARTE",
        title: v.title.slice(0, 200),
        setupId: i.route.ctx?.setup.id ?? null,
        accountId: i.route.account?.id ?? null,
        opportunityId: resolved.opportunityId ?? null,
        purpose: v.purpose || null,
        targetRole: "BD",
        trigger: i.sourceLabel.slice(0, 300),
        sourceIds: [i.sourceId],
        evidenceQuote: item.evidenceQuote,
        observation: v.detail.slice(0, 2000) || item.evidenceQuote,
        objectType: resolved.engagementId ? "ENGAGEMENT" : null,
        objectId: resolved.engagementId ?? null,
        proposedOwnerUserId: actor.userId,
        payload: { item, resolved, route: { reason: i.route.reason, confident: i.route.confident, byKey: !!i.route.byKey, domains: i.route.domains ?? [] } },
        priorityCategory: v.priority,
        dedupeKey,
        provider: info.id,
        model: usage?.model || taskOpts.model || info.model,
        promptVersion: INTAKE_PROMPT_VERSION,
        aiJobId: job!.id,
      });
      created++;
    }
    await tx.update(schema.aiJobs).set({ status: "ERFOLGREICH", itemCount: created, rejectedCount: rejected, finishedAt: new Date(), ...(usage ? { tokensIn: usage.tokensIn, tokensOut: usage.tokensOut } : {}) }).where(eq(schema.aiJobs.id, job!.id));
    await recordAudit(tx, actor, "eingang.evaluated", "SOURCE", i.sourceId, { karten: created, zurueckgewiesen: rejected, kunde: i.route.account?.name ?? null, setup: i.route.ctx?.setup.name ?? null });
  });
  return { created, rejected, setupId: i.route.ctx?.setup.id ?? null, accountName: i.route.account?.name ?? null, reason: i.route.reason, sourceId: i.sourceId, noSuggestionReason: out.data.noSuggestionReason };
}

type Resolved = { opportunityId?: string | null; engagementId?: string | null; actionId?: string | null; questionId?: string | null; personId?: string | null; dueDate?: string };

/** Kürzel auflösen; unbekanntes Pflichtkürzel → null (Karte verwerfen). */
function resolveRefs(item: IntakeItem, refs: Refs): Resolved | null {
  const r: Resolved = {};
  const get = (map: Map<string, string>, ref: string) => map.get(ref.trim().toUpperCase()) ?? null;
  if (item.type === "VERLAENGERUNG" || item.type === "STIMMUNG") {
    r.engagementId = get(refs.E, item.engagementRef);
    if (!r.engagementId) return null;
  }
  if (item.type === "CHANCE_STATUS") {
    r.opportunityId = get(refs.C, item.chanceRef);
    if (!r.opportunityId) return null;
  }
  if (item.type === "ERLEDIGT") {
    const ref = item.ref.trim().toUpperCase();
    if (ref.startsWith("A")) r.actionId = get(refs.A, ref);
    else if (ref.startsWith("Q")) r.questionId = get(refs.Q, ref);
    if (!r.actionId && !r.questionId) return null;
  }
  if ((item.type === "PERSON" || item.type === "AKTION" || item.type === "FREELANCER") && item.chanceRef) r.opportunityId = get(refs.C, item.chanceRef);
  if (item.type === "PERSON" && item.personRef) r.personId = get(refs.P, item.personRef);
  return r;
}

function cardKey(item: IntakeItem): unknown {
  switch (item.type) {
    case "PERSON": return norm(item.displayName);
    case "VERLAENGERUNG": case "STIMMUNG": return item.engagementRef;
    case "CHANCE_STATUS": return [item.chanceRef, item.status];
    case "ERLEDIGT": return item.ref;
    case "CHANCE": return norm(item.title);
    case "FREELANCER": return norm(item.displayName);
    default: return "";
  }
}

const typeLabel: Record<string, string> = {
  KUNDE: "Neuer Kunde", SETUP: "Neues Setup", PERSON: "Person", SIGNAL: "Beobachtung", CHANCE: "Neue Chance", ACCOUNTZIEL: "Accountziel", AKTION: "Aufgabe", KONTAKT: "Kontaktaufnahme", FRAGE: "Offene Frage", INITIATIVE: "Kundenagenda", BESCHAFFUNG: "Beschaffung", EINSATZ: "Laufender Einsatz", RISIKO: "Risiko", SOS: "SOS", HEBEL: "Vorhaben", VORGANG: "Vorgang", BESETZUNG: "Besetzung", TEAM: "Team", EINSORTIERUNG: "Kunde zuordnen",
  VERLAENGERUNG: "Verlängerung", CHANCE_STATUS: "Chance: neuer Stand", ERLEDIGT: "Erledigt", STIMMUNG: "Stimmung", FREELANCER: "Freelancer",
};
export const eingangTypeLabel = typeLabel;

const statusLabel: Record<string, string> = { IN_KLAERUNG: "in Klärung", BESTAETIGT: "bestätigt", ZURUECKGESTELLT: "zurückgestellt", BEENDET: "beendet" };

/** Titel/Detail/Priorität einer Karte für die Vorschlagsliste. */
export function describeCard(item: IntakeItem, labels: Map<string, string> = new Map()): { title: string; detail: string; purpose: string; priority: "KONKRETE_ANFRAGE" | "NEUE_INFORMATION" | "ZUGANGSLUECKE" | "PLANUNGSANLASS" | "VERBESSERUNGSIDEE" | "BLOCKIERTE_AKTION" } {
  const t = typeLabel[item.type] ?? item.type;
  const L = (ref: string) => labels.get(ref.trim().toUpperCase()) ?? ref;
  switch (item.type) {
    case "KUNDE": return { title: `${t}: ${item.name}`, detail: `Setup „${item.setupName}“${item.contextNote ? ` – ${item.contextNote}` : ""}`, purpose: "", priority: "NEUE_INFORMATION" };
    case "SETUP": return { title: `${t}: ${item.name}`, detail: item.contextNote, purpose: "", priority: "NEUE_INFORMATION" };
    case "PERSON": return { title: `${t}: ${item.displayName}${item.functionTitle ? ` – ${item.functionTitle}` : ""}`, detail: [item.orgUnitName && `Bereich: ${item.orgUnitName}`, item.email, item.phone, item.decisionRole && `Buyingcenter: ${item.decisionRole}`, item.knownResponsibility].filter(Boolean).join(" · "), purpose: "", priority: "ZUGANGSLUECKE" };
    case "SIGNAL": return { title: `${t}: ${item.observation.slice(0, 120)}`, detail: [item.observation, item.relevanceHypothesis && `Vermutung: ${item.relevanceHypothesis}`].filter(Boolean).join(" · "), purpose: item.purpose, priority: "NEUE_INFORMATION" };
    case "CHANCE": return { title: `${t}: ${item.title}`, detail: `${item.needDescription}${item.roleName ? ` · Rolle ${item.roleName}` : ""}${item.headcount ? ` · ${item.headcount}×` : ""}${item.horizon ? ` · ${item.horizon}` : ""}${item.anticipated ? " · antizipiert" : " · vom Kunden ausgesprochen"}`, purpose: item.title, priority: "KONKRETE_ANFRAGE" };
    case "AKTION": return { title: `${t}: ${item.title}`, detail: item.description, purpose: item.purpose, priority: "KONKRETE_ANFRAGE" };
    case "KONTAKT": return { title: `${t}: ${item.personName}`, detail: item.occasion, purpose: item.purpose, priority: "ZUGANGSLUECKE" };
    case "FRAGE": return { title: `${t}: ${item.question.slice(0, 140)}`, detail: item.question, purpose: item.purpose, priority: "NEUE_INFORMATION" };
    case "VERLAENGERUNG": return { title: `${item.decision === "ENDET" ? "Endet ohne Verlängerung" : t}: ${L(item.engagementRef)}${item.newEnd ? ` bis ${item.newEnd.split("-").reverse().join(".")}` : ""}`, detail: [item.newEnd && `neues Ende ${item.newEnd}`, item.conditionsNote].filter(Boolean).join(" · "), purpose: "", priority: "KONKRETE_ANFRAGE" };
    case "CHANCE_STATUS": return { title: `${t}: ${L(item.chanceRef)} → ${statusLabel[item.status]}`, detail: item.reason, purpose: "", priority: "KONKRETE_ANFRAGE" };
    case "ERLEDIGT": return { title: `${t}: ${L(item.ref)}`, detail: item.result, purpose: "", priority: "NEUE_INFORMATION" };
    case "STIMMUNG": return { title: `${t} zu ${L(item.engagementRef)} (${item.side === "KUNDE" ? "Kunde" : "Freelancer"}): ${item.mood.toLowerCase()}`, detail: item.note, purpose: "", priority: item.mood === "NEGATIV" ? "KONKRETE_ANFRAGE" : "NEUE_INFORMATION" };
    case "FREELANCER": return { title: `${t}: ${item.displayName}`, detail: [item.skills, item.availableFrom && `verfügbar ab ${item.availableFrom}`, item.ekRate && `EK ${item.ekRate}`, item.email].filter(Boolean).join(" · "), purpose: "", priority: "NEUE_INFORMATION" };
    case "BESETZUNG": return { title: `${t}: ${item.title}`, detail: [item.personName && `Person: ${item.personName}`, item.desiredStart && `Start ${item.desiredStart}`, item.mustHave].filter(Boolean).join(" · "), purpose: item.chanceTitle, priority: "KONKRETE_ANFRAGE" };
    case "EINSATZ": return { title: `${t}: ${item.title}`, detail: [item.consultantName, item.plannedEnd && `Ende ${item.plannedEnd}`, item.endHint].filter(Boolean).join(" · "), purpose: "", priority: "PLANUNGSANLASS" };
    case "EINSORTIERUNG": return { title: `${t}: ${item.accountName}${item.setupName ? ` · ${item.setupName}` : ""}`, detail: item.reasoning, purpose: "", priority: "NEUE_INFORMATION" };
    case "VORGANG": return { title: `${t}: ${item.title}`, detail: item.description, purpose: "", priority: "KONKRETE_ANFRAGE" };
    case "INITIATIVE": case "HEBEL": return { title: `${t}: ${item.title}`, detail: "", purpose: "", priority: "PLANUNGSANLASS" };
    case "SOS": return { title: `${t}: ${item.title}`, detail: item.situation, purpose: "", priority: "BLOCKIERTE_AKTION" };
    case "RISIKO": return { title: `${t}: ${item.risk}`, detail: item.note, purpose: "", priority: "PLANUNGSANLASS" };
    case "BESCHAFFUNG": return { title: `${t}: ${item.channel}`, detail: item.note, purpose: "", priority: "NEUE_INFORMATION" };
    case "ACCOUNTZIEL": return { title: `${t}: ${item.title}`, detail: item.desiredOutcome, purpose: "", priority: "PLANUNGSANLASS" };
    case "TEAM": return { title: `${t}`, detail: [item.bdName, ...item.ankerNames].filter(Boolean).join(", "), purpose: "", priority: "NEUE_INFORMATION" };
    default: return { title: t, detail: "", purpose: "", priority: "NEUE_INFORMATION" };
  }
}

// ---------------------------------------------------------------------------
// 4) Übernehmen
// ---------------------------------------------------------------------------

export const acceptCardInput = z.object({
  version: z.coerce.number().int().positive(),
  newEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("")),
  contractFollowUp: z.string().trim().max(200).optional().or(z.literal("")),
  /** Organisationstyp beim Anlegen eines neuen Kunden (Pflichtfrage auf der Karte) */
  orgType: z.enum(schema.orgTypeEnum.enumValues).optional().or(z.literal("")),
  /** Kunde zuordnen, wenn die Karte noch keinem Setup gehört */
  setupId: z.string().optional().or(z.literal("")),
});

type SuggestionRow = typeof schema.suggestions.$inferSelect;

export async function acceptIntakeCard(actor: Actor, s: SuggestionRow, ctx0: SetupContext | null, raw: unknown) {
  const p = acceptCardInput.safeParse(raw);
  if (!p.success) throw new ValidationError(p.error.issues.map((i) => i.message).join("; "));
  const input = p.data;
  if (!["NEU", "GEPRUEFT", "ZURUECKGESTELLT"].includes(s.status)) throw new TransitionError("Diese Karte ist bereits entschieden.");
  if (s.version !== input.version) throw new ConflictError();
  const payload = s.payload as { item: IntakeItem; resolved: Resolved } | null;
  if (!payload) throw new ValidationError("Die Karte ist unvollständig.");
  const { item, resolved } = payload;
  if (item.type === "KUNDE" && input.orgType) item.orgType = input.orgType;
  let ctx = ctx0;
  // Karte ohne Setup: gewähltes Setup übernehmen
  if (!ctx && input.setupId) {
    const c = await loadSetupContext(actor, input.setupId);
    if (!c || !canViewSetup(actor, c)) throw new NotFoundError("Setup");
    ctx = c;
  }
  if (ctx && !canEditSetup(actor, ctx) && !["VERLAENGERUNG", "STIMMUNG"].includes(item.type)) throw new ForbiddenError("Sie sind an diesem Setup nicht bearbeitend beteiligt.");
  const account = ctx?.account ?? (s.accountId ? await db.query.accounts.findFirst({ where: eq(schema.accounts.id, s.accountId) }) : null) ?? null;
  const sourceId = s.sourceIds[0] ?? null;
  let result: { type: string; id: string; note: string };
  switch (item.type) {
    case "VERLAENGERUNG":
      result = await applyRenewal(actor, resolved.engagementId!, item, input.newEnd || item.newEnd || "", input.contractFollowUp || "", s.trigger);
      break;
    case "CHANCE_STATUS":
      result = await applyChanceStatus(actor, resolved.opportunityId!, item, s.trigger);
      break;
    case "ERLEDIGT":
      result = await applyDone(actor, resolved, item, sourceId);
      break;
    case "STIMMUNG":
      result = await applyMood(actor, resolved.engagementId!, item);
      break;
    case "FREELANCER":
      result = await applyFreelancer(actor, resolved.opportunityId ?? null, item);
      break;
    case "PERSON":
      if (!account) throw new ValidationError("Für die Person fehlt der Kunde – übernimm zuerst „Neuer Kunde“ oder wähle ein Setup.");
      result = await applyPerson(actor, account.id, ctx, resolved, item, sourceId);
      break;
    default: {
      const { applyCard } = await import("@/modules/assistant/service");
      const res = { ref: ctx ? { type: "SETUP" as const, id: ctx.setup.id } : account ? { type: "ACCOUNT" as const, id: account.id } : { type: "GLOBAL" as const, id: "" }, ctx, account, canWrite: ctx ? canEditSetup(actor, ctx) : !!account };
      const r = await applyCard(actor, res, item as AssistantItem, {
        origin: s.trigger,
        intake: true,
        dueDate: resolved.dueDate,
        opportunityId: resolved.opportunityId ?? null,
        sourceFor: async (setupId) => {
          if (sourceId) {
            const src = await db.query.sources.findFirst({ where: eq(schema.sources.id, sourceId) });
            if (src && !src.setupId && setupId) await db.update(schema.sources).set({ setupId, accessClass: "SETUP" }).where(eq(schema.sources.id, src.id));
            if (src) return src.id;
          }
          const [n] = await db.insert(schema.sources).values({ workspaceId: actor.workspaceId, setupId, type: "NOTIZ", title: "Eingang", body: s.evidenceQuote, origin: "Eingang", sourceTime: new Date(), ownerUserId: actor.userId, accessClass: setupId ? "SETUP" : "PERSOENLICH" }).returning();
          return n!.id;
        },
      });
      result = { type: r.type, id: r.id, note: (r.note ?? "Übernommen.").replace(/;\s*das Gespräch gehört jetzt zu diesem Setup\./, ".").replace("das Gespräch bezieht sich jetzt auf", "der Eingang gehört jetzt zu").replace(/ Als Nächstes kannst du z\. B\. ein Setup vorschlagen lassen\./, "") };
      // Neuer Kunde/Setup oder Zuordnung: die übrigen Karten desselben Eingangs gehören jetzt dorthin
      if (r.rebind && s.aiJobId) {
        const setupId = r.rebind.type === "SETUP" ? r.rebind.id : null;
        const accId = r.rebind.type === "ACCOUNT" ? r.rebind.id : setupId ? (await db.query.projectSetups.findFirst({ where: eq(schema.projectSetups.id, setupId) }))?.accountId ?? null : null;
        await db.update(schema.suggestions).set({ setupId: setupId ?? undefined, accountId: accId }).where(and(eq(schema.suggestions.aiJobId, s.aiJobId), isNull(schema.suggestions.setupId), inArray(schema.suggestions.status, ["NEU", "GEPRUEFT"])));
        result.note += " Die übrigen Karten dieses Eingangs sind jetzt diesem Kunden zugeordnet.";
        // Kennung lernen: die Mail-Domänen dieses Eingangs gehören künftig zu diesem Kunden
        const domains = (s.payload as { route?: { domains?: string[] } } | null)?.route?.domains ?? [];
        if (accId && domains.length) {
          const { learnDomain } = await import("@/modules/accounts/keys");
          const learned: string[] = [];
          for (const d of domains) if (await learnDomain(db, actor.workspaceId, accId, d)) learned.push(d);
          if (learned.length) result.note += ` Kennung gelernt: Mails von ${learned.join(", ")} gehören künftig zu diesem Kunden.`;
        }
      }
    }
  }
  const [updated] = await db
    .update(schema.suggestions)
    .set({ status: "ANGENOMMEN", decidedBy: actor.userId, decidedAt: new Date(), acceptedObjectType: result.type, acceptedObjectId: result.id, setupId: s.setupId ?? ctx?.setup.id ?? null, version: s.version + 1 })
    .where(and(eq(schema.suggestions.id, s.id), eq(schema.suggestions.version, s.version)))
    .returning();
  if (!updated) throw new ConflictError();
  await recordAudit(db, actor, "suggestion.accepted", "SUGGESTION", s.id, { karte: item.type, objekt: result.type });
  return { suggestion: updated, acceptedObjectType: result.type, acceptedObjectId: result.id, message: result.note };
}

function addMonthsIso(iso: string, months: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}
const de = (iso: string) => iso.split("-").reverse().join(".");

/** Vorbelegung des neuen Endes: aus dem Text, sonst bereits angestoßenes Ende, sonst heutiges Ende + 12 Monate. */
export async function renewalDefaultsFor(engagementId: string | null, fromText: string) {
  if (!engagementId) return null;
  const e = await db.query.engagements.findFirst({ where: eq(schema.engagements.id, engagementId) });
  if (!e) return null;
  const open = await db.query.renewalDecisions.findFirst({ where: and(eq(schema.renewalDecisions.engagementId, e.id), inArray(schema.renewalDecisions.status, ["ZU_KLAEREN", "IN_ABSTIMMUNG", "ANGEBOTEN"])) });
  return { engagementId: e.id, title: e.title, status: e.status, currentEnd: e.plannedEnd, newEnd: fromText || open?.proposedTo || addMonthsIso(e.plannedEnd ?? todayIso(), 12), fromText: !!fromText, openStatus: open?.status ?? null };
}

async function applyRenewal(actor: Actor, engagementId: string, item: Extract<IntakeItem, { type: "VERLAENGERUNG" }>, newEnd: string, contractFollowUp: string, trigger: string) {
  const { engagementAccess } = await import("@/modules/engagements/authz");
  const { decideRenewal, startRenewal, upsertRenewalDecision } = await import("@/modules/engagements/care");
  const { changeEngagementStatus } = await import("@/modules/engagements/service");
  const e = await db.query.engagements.findFirst({ where: and(eq(schema.engagements.id, engagementId), eq(schema.engagements.workspaceId, actor.workspaceId)) });
  if (!e) throw new NotFoundError("Einsatz");
  const a = await engagementAccess(actor, e);
  if (!a || !(a.manage || a.care)) throw new ForbiddenError("Für diesen Einsatz dürfen Sie keine Verlängerung bearbeiten.");
  const quote = `Laut ${trigger}: „${item.evidenceQuote.slice(0, 200)}“`;
  const open = await db.query.renewalDecisions.findFirst({ where: and(eq(schema.renewalDecisions.engagementId, e.id), inArray(schema.renewalDecisions.status, ["ZU_KLAEREN", "IN_ABSTIMMUNG", "ANGEBOTEN"])) });
  if (item.decision === "ENDET") {
    if (!a.commercial) throw new ForbiddenError("„Endet ohne Verlängerung“ entscheidet der BD, Principal oder CEO.");
    if (open) await upsertRenewalDecision(actor, e.id, { version: open.version, status: "ABGELEHNT", proposedFrom: open.proposedFrom ?? "", proposedTo: open.proposedTo ?? "", conditionsNote: open.conditionsNote ?? "", availabilityNote: `Keine Verlängerung – ${quote}`.slice(0, 500), commercialOwnerUserId: actor.userId });
    if (["AKTIV", "PAUSIERT"].includes(e.status)) await changeEngagementStatus(actor, e.id, { version: e.version, status: "ENDET", actualDate: e.plannedEnd ?? todayIso(), reason: "Keine Verlängerung (aus Eingang)" });
    return { type: "ENGAGEMENT", id: e.id, note: `Festgehalten: keine Verlängerung – der Einsatz endet zum ${e.plannedEnd ? de(e.plannedEnd) : "geplanten Ende"}; die offene Klärung ist erledigt.` };
  }
  if (!newEnd) throw new ValidationError("Bitte das neue Ende angeben.");
  if (!open || open.proposedTo !== newEnd) await startRenewal(actor, e.id, { newEnd, conditions: "UNVERAENDERT", note: `${quote}${item.conditionsNote ? ` – ${item.conditionsNote}` : ""}`.slice(0, 1000) });
  if (a.commercial) {
    const r = await decideRenewal(actor, e.id, { decision: "BESTAETIGEN", contractFollowUp: contractFollowUp || "Nachtrag", note: item.conditionsNote });
    const moco = r.mocoWritten ? " Das Projektende in Moco ist aktualisiert." : r.mocoError ? " Moco konnte nicht aktualisiert werden – Sales Operations ist informiert." : "";
    return { type: "RENEWAL", id: r.decision.id, note: `Verlängerung bis ${de(newEnd)} bestätigt – die offene Klärung ist erledigt.${moco}` };
  }
  return { type: "RENEWAL", id: open?.id ?? e.id, note: `Verlängerung bis ${de(newEnd)} angestoßen – die Entscheidung liegt beim BD.` };
}

async function applyChanceStatus(actor: Actor, opportunityId: string, item: Extract<IntakeItem, { type: "CHANCE_STATUS" }>, trigger: string) {
  const { changeOpportunityStatus, confirmOpportunity } = await import("@/modules/opportunities/service");
  const o = await db.query.opportunities.findFirst({ where: and(eq(schema.opportunities.id, opportunityId), eq(schema.opportunities.workspaceId, actor.workspaceId)) });
  if (!o) throw new NotFoundError("Chance");
  if (o.status === item.status) return { type: "OPPORTUNITY", id: o.id, note: `„${o.title}“ steht bereits auf ${statusLabel[item.status]}.` };
  if (item.status === "BESTAETIGT") {
    await confirmOpportunity(actor, o.id, { version: o.version, evidenceText: `${trigger}: „${item.evidenceQuote.slice(0, 400)}“`, confirmedNote: item.reason });
  } else {
    await changeOpportunityStatus(actor, o.id, { version: o.version, status: item.status, reason: item.reason || `Laut ${trigger}: „${item.evidenceQuote.slice(0, 200)}“` });
  }
  return { type: "OPPORTUNITY", id: o.id, note: `Chance „${o.title}“ steht jetzt auf ${statusLabel[item.status]}.` };
}

async function applyDone(actor: Actor, r: Resolved, item: Extract<IntakeItem, { type: "ERLEDIGT" }>, sourceId: string | null) {
  if (r.actionId) {
    const { changeActionStatus } = await import("@/modules/actions/service");
    const a = await db.query.actions.findFirst({ where: eq(schema.actions.id, r.actionId) });
    if (!a) throw new NotFoundError("Aktion");
    // Vorgeschlagene Aktion erst annehmen (nur die verantwortliche Person), dann erledigen
    let version = a.version;
    if (a.status === "VORGESCHLAGEN" && a.ownerUserId === actor.userId) version = (await changeActionStatus(actor, a.id, { version, status: "ANGENOMMEN" })).version;
    await changeActionStatus(actor, a.id, { version, status: "ERLEDIGT", result: item.result || `Erledigt laut Eingang: „${item.evidenceQuote.slice(0, 300)}“` });
    return { type: "ACTION", id: a.id, note: `Aktion „${a.title}“ abgehakt.` };
  }
  const q = await db.query.openQuestions.findFirst({ where: eq(schema.openQuestions.id, r.questionId!) });
  if (!q) throw new NotFoundError("Frage");
  const ctx = await loadSetupContext(actor, q.setupId);
  if (!ctx || !canEditSetup(actor, ctx)) throw new ForbiddenError();
  await db.update(schema.openQuestions).set({ status: "BEANTWORTET", answer: (item.result || item.evidenceQuote).slice(0, 2000), answerSourceId: sourceId, updatedAt: new Date() }).where(eq(schema.openQuestions.id, q.id));
  await recordAudit(db, actor, "open_question.answered", "OPEN_QUESTION", q.id, { herkunft: "Eingang" });
  return { type: "OPEN_QUESTION", id: q.id, note: `Frage beantwortet: „${q.question.slice(0, 80)}“.` };
}

async function applyMood(actor: Actor, engagementId: string, item: Extract<IntakeItem, { type: "STIMMUNG" }>) {
  const { actOnCheckin, createCheckin } = await import("@/modules/engagements/care");
  const c = await createCheckin(actor, engagementId, { side: item.side, dueDate: todayIso(), note: "Aus Eingang" });
  await actOnCheckin(actor, c.id, { version: c.version, action: "ERLEDIGEN", mood: item.mood, note: (item.note || item.evidenceQuote).slice(0, 4000) });
  return { type: "CHECKIN", id: c.id, note: `Stimmung ${item.mood.toLowerCase()} (${item.side === "KUNDE" ? "Kunde" : "Freelancer"}) als Check-in festgehalten.` };
}

async function applyFreelancer(actor: Actor, opportunityId: string | null, item: Extract<IntakeItem, { type: "FREELANCER" }>) {
  const { addCandidacy, createFreelancer } = await import("@/modules/staffing/service");
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item.email.trim()) ? item.email.trim() : "";
  const known = email ? await db.query.freelancers.findFirst({ where: and(eq(schema.freelancers.workspaceId, actor.workspaceId), eq(schema.freelancers.email, email)) }) : null;
  const pos = opportunityId ? await db.query.staffingPositions.findFirst({ where: and(eq(schema.staffingPositions.opportunityId, opportunityId), inArray(schema.staffingPositions.status, ["OFFEN", "ENTWURF"])) }) : null;
  const avail = ISO.test(item.availableFrom) ? item.availableFrom : "";
  if (pos) {
    const c = await addCandidacy(actor, pos.id, known ? { freelancerId: known.id, availableFrom: avail, ekRate: item.ekRate } : { newName: item.displayName, newEmail: email, newSkills: item.skills, availableFrom: avail, ekRate: item.ekRate });
    return { type: "CANDIDACY", id: c.id, note: `${item.displayName} als Kandidat:in an der Position „${pos.title}“ eingetragen.` };
  }
  if (known) return { type: "FREELANCER", id: known.id, note: `${known.displayName} ist schon im Freelancer-Pool.` };
  const f = await createFreelancer(actor, { displayName: item.displayName, email, phone: item.phone, skills: item.skills, availabilityNote: avail ? `verfügbar ab ${de(avail)}` : "", availabilityAsOf: avail ? todayIso() : "", availabilitySource: "Eingang" });
  return { type: "FREELANCER", id: f.id, note: `${f.displayName} in den Freelancer-Pool aufgenommen.` };
}

async function applyPerson(actor: Actor, accountId: string, ctx: SetupContext | null, r: Resolved, item: Extract<IntakeItem, { type: "PERSON" }>, sourceId: string | null) {
  const { createPerson, resolveOrgUnit } = await import("@/modules/people/service");
  const name = item.displayName.replace(/^(Frau|Herr|Fr\.|Hr\.)\s+/i, "").trim();
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item.email.trim()) ? item.email.trim() : "";
  const persons = await db.query.persons.findMany({ where: eq(schema.persons.accountId, accountId) });
  const clean = (n: string) => norm(n);
  const hit =
    (r.personId && persons.find((p) => p.id === r.personId)) ||
    (email && persons.find((p) => p.email?.toLowerCase() === email.toLowerCase())) ||
    persons.find((p) => clean(p.displayName) === clean(name)) ||
    (() => {
      const last = clean(name).split(" ").pop()!;
      const same = persons.filter((p) => clean(p.displayName).split(" ").pop() === last);
      return same.length === 1 ? same[0] : undefined;
    })();
  let personId: string;
  let note: string;
  if (!hit) {
    const p = await createPerson(actor, { accountId, displayName: name, email, phone: item.phone.slice(0, 50), functionTitle: item.functionTitle, orgUnitName: item.orgUnitName, knownResponsibility: item.knownResponsibility, setupId: ctx?.setup.id ?? "" });
    personId = p.id;
    note = `${name} angelegt${item.functionTitle ? ` als ${item.functionTitle}` : ""}${item.orgUnitName ? ` (${item.orgUnitName})` : ""}.`;
  } else {
    personId = hit.id;
    await db.transaction(async (tx) => {
      if (email && !hit.email) await tx.update(schema.persons).set({ email, updatedAt: new Date() }).where(eq(schema.persons.id, hit.id));
      if (item.phone && !hit.phone) await tx.update(schema.persons).set({ phone: item.phone.slice(0, 50), updatedAt: new Date() }).where(eq(schema.persons.id, hit.id));
      if (item.functionTitle || item.orgUnitName) {
        const cur = (await tx.query.personFunctions.findMany({ where: eq(schema.personFunctions.personId, hit.id) })).find((f) => !f.validTo);
        const unitId = item.orgUnitName ? await resolveOrgUnit(tx, accountId, undefined, item.orgUnitName) : cur?.orgUnitId ?? null;
        if (!cur || (item.functionTitle && cur.functionTitle !== item.functionTitle) || (item.orgUnitName && cur.orgUnitId !== unitId)) {
          const today = todayIso();
          if (cur) await tx.update(schema.personFunctions).set({ validTo: today }).where(eq(schema.personFunctions.id, cur.id));
          await tx.insert(schema.personFunctions).values({ personId: hit.id, orgUnitId: unitId, functionTitle: item.functionTitle || cur?.functionTitle || "Funktion noch unbekannt", knownResponsibility: item.knownResponsibility || cur?.knownResponsibility || null, validFrom: today, sourceId });
        }
      }
      await recordAudit(tx, actor, "person.updated_from_eingang", "PERSON", hit.id, { funktion: item.functionTitle || null });
    });
    note = `${hit.displayName.replace(/\(.*?\)/g, "").trim()} ergänzt${item.functionTitle ? `: ${item.functionTitle}` : ""}${item.orgUnitName ? ` (${item.orgUnitName})` : ""}.`;
  }
  // Buyingcenter-Rolle / Haltung als Hypothese am Setup (ggf. Chance)
  if (ctx && (item.decisionRole || item.stance !== "UNBEKANNT" || item.influence !== "UNBEKANNT")) {
    const { upsertAssessment } = await import("@/modules/people/assessments");
    await upsertAssessment(actor, { personId, setupId: ctx.setup.id, decisionRole: item.decisionRole ?? "", stance: item.stance, influence: item.influence, note: item.assessmentNote, sourceId: sourceId ?? "", confirm: false }).catch(() => null);
    note += " Buyingcenter-Einschätzung als Hypothese gespeichert.";
  }
  return { type: "PERSON", id: personId, note };
}

export function eingangEnabled(): boolean {
  return getConfig().AI_PROVIDER !== "disabled";
}

/** Laufende und zuletzt gescheiterte Eingangs-Auswertungen der Person (Etappe 39) – für den Hinweis unter „Vorschläge“. */
export async function listRunningEingang(actor: Actor): Promise<{ running: { id: string; startedAt: Date }[]; lastError: { at: Date; error: string } | null }> {
  const since = new Date(Date.now() - 15 * 60_000);
  const jobs = await db.query.aiJobs.findMany({ where: and(eq(schema.aiJobs.workspaceId, actor.workspaceId), eq(schema.aiJobs.actorUserId, actor.userId), eq(schema.aiJobs.type, "EINGANG")), orderBy: desc(schema.aiJobs.startedAt), limit: 10 });
  const running = jobs.filter((j) => j.status === "GESTARTET" && j.startedAt >= since).map((j) => ({ id: j.id, startedAt: j.startedAt }));
  const failed = jobs.find((j) => (j.status === "FEHLER" || j.status === "ABGELEHNT") && j.startedAt >= since && !jobs.some((k) => k.status === "ERFOLGREICH" && k.startedAt > j.startedAt));
  return { running, lastError: failed ? { at: failed.startedAt, error: failed.error ?? "unbekannter Fehler" } : null };
}

/**
 * Falsch zugeordnet? (Etappe 42) – Eingang einem anderen Kunden/Setup zuordnen und mit dessen Lagebild neu auswerten.
 * Optional werden die Mail-Domänen des Eingangs zur Kennung des richtigen Kunden (und bei einem anderen Kunden entfernt).
 */
export async function reassignIntake(actor: Actor, suggestionId: string, setupId: string, opts: { learn?: boolean } = {}, deps: { provider?: AIProvider } = {}) {
  const { requireSuggestionAny } = await import("@/modules/suggestions/service");
  const { suggestion: s } = await requireSuggestionAny(actor, suggestionId);
  const sourceId = s.sourceIds[0];
  if (!sourceId) throw new ValidationError("Zu dieser Karte gibt es keine Quelle, die neu ausgewertet werden könnte.");
  const ctx = await loadSetupContext(actor, setupId);
  if (!ctx || !canEditSetup(actor, ctx)) throw new ForbiddenError("In diesem Setup darfst du nicht arbeiten.");
  const domains = (s.payload as { route?: { domains?: string[] } } | null)?.route?.domains ?? [];
  const learned: string[] = [];
  if (opts.learn && domains.length) {
    const { learnDomain } = await import("@/modules/accounts/keys");
    const { sql } = await import("drizzle-orm");
    for (const d of domains) {
      // falsche Kennung bei einem anderen Kunden lösen, dann beim richtigen setzen
      await db.execute(sql`update accounts set mail_domains = array_remove(mail_domains, ${d}) where workspace_id = ${actor.workspaceId} and id <> ${ctx.account.id} and ${d} = any(mail_domains)`);
      if (await learnDomain(db, actor.workspaceId, ctx.account.id, d)) learned.push(d);
    }
    if (learned.length) await recordAudit(db, actor, "account.keys_learned", "ACCOUNT", ctx.account.id, { domaenen: learned.length });
  }
  await db.update(schema.sources).set({ setupId: ctx.setup.id }).where(and(eq(schema.sources.id, sourceId), eq(schema.sources.workspaceId, actor.workspaceId)));
  if (s.aiJobId) await db.update(schema.suggestions).set({ status: "UEBERHOLT" }).where(and(eq(schema.suggestions.aiJobId, s.aiJobId), inArray(schema.suggestions.status, ["NEU", "GEPRUEFT", "ZURUECKGESTELLT"])));
  const r = await eingangFromSource(actor, sourceId, { autoRoute: false }, deps);
  return { ...r, accountName: ctx.account.name, learned };
}

/** Bearbeitbare Setups für die Auswahl „Anderer Kunde“. */
export async function editableSetupOptions(actor: Actor): Promise<{ id: string; label: string }[]> {
  const out: { id: string; label: string }[] = [];
  for (const a of (await listVisibleAccounts(actor)).filter((x) => x.status !== "ARCHIVED")) {
    const setups = await db.query.projectSetups.findMany({ where: eq(schema.projectSetups.accountId, a.id) });
    for (const st of setups.filter((x) => x.status !== "ARCHIVIERT")) {
      const c = await loadSetupContext(actor, st.id);
      if (c && canEditSetup(actor, c)) out.push({ id: st.id, label: `${a.name} · ${st.name}` });
    }
  }
  return out.sort((x, y) => x.label.localeCompare(y.label, "de"));
}
