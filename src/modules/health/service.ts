import { openSosByAccount } from "@/modules/sos/service";
import { procurementLabel } from "@/modules/agenda/service";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db/client";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/identity/actor";
import { assertDecisionRight, canReassignResponsibility, canViewAccount, hasRoleForAccountWrite } from "@/modules/identity/authz";
import { getAccount } from "@/modules/accounts/service";

/**
 * Kunden-Health-Check (Etappe 23): „Wie sicher sitzen wir im Sattel?“
 *
 * Grundsätze (Briefing 14.3 „transparente Kategorien statt unklarer KI-Scores“):
 *  - Der Score entsteht aus festen, sichtbaren Regeln je Dimension – jede Punktzahl hat eine Begründung.
 *  - „Unbekannt“ ist nicht „schlecht“: Unbekannte Dimensionen zählen nicht in den Score, sondern senken die
 *    getrennt ausgewiesene Datenlage. Genau diese Lücken fragt das geführte Interview ab.
 *  - Der Score bewertet Kunden, nie Personen; er sperrt nichts.
 */

export const DAY = 86400000;
const STALE_DAYS = 90;

export const feedbackToneValues = ["POSITIV", "NEUTRAL", "KRITISCH"] as const;
export const listingValues = ["RAHMENVERTRAG", "GELISTET", "NICHT_GELISTET"] as const;
export const riskValues = ["UMSTRUKTURIERUNG", "BUDGETKUERZUNG", "WETTBEWERBER", "FUERSPRECHER_WEG", "INSOURCING", "EINKAUF_VERSCHAERFT", "NACHBARTEAM"] as const;

export const feedbackToneLabel: Record<string, string> = { POSITIV: "positiv", NEUTRAL: "neutral / gemischt", KRITISCH: "kritisch" };
export const listingLabel: Record<string, string> = { RAHMENVERTRAG: "Rahmenvertrag", GELISTET: "gelistet (ohne Rahmenvertrag)", NICHT_GELISTET: "nicht gelistet" };
export const riskLabel: Record<string, string> = {
  UMSTRUKTURIERUNG: "Umstrukturierung beim Kunden",
  BUDGETKUERZUNG: "Budgetkürzung / Sparprogramm",
  WETTBEWERBER: "Wettbewerber im Account aktiv",
  FUERSPRECHER_WEG: "Fürsprecher geht oder ist gegangen",
  INSOURCING: "Kunde will intern besetzen (Insourcing)",
  EINKAUF_VERSCHAERFT: "Einkauf/Vendor-Prozess verschärft",
  NACHBARTEAM: "Nachbarteam / interne Stelle stellt sich gegen Änderungen",
};

type Stamp = { at: string; by: string };
export type HealthAnswers = {
  feedback?: { tone: (typeof feedbackToneValues)[number]; date: string | null; note: string } & Stamp;
  listing?: { status: (typeof listingValues)[number]; validUntil: string | null; note: string } & Stamp;
  risks?: { items: (typeof riskValues)[number][]; note: string } & Stamp;
};

export type Dimension = { key: string; label: string; max: number; points: number; known: boolean; reasons: string[]; missing: string[] };
export type Engagement = {
  orderId: string;
  version: number;
  opportunityId: string;
  title: string;
  setupId: string;
  setupName: string;
  status: string; // GESTARTET | GEPLANT | STARTBEREIT
  plannedStart: string | null;
  plannedEnd: string | null;
  renewalDeadline: string | null;
  daysToEnd: number | null;
  triggerDate: string | null;
  consultantUserId: string | null;
  consultantName: string | null;
  contractSourceId: string | null;
  contractLink: string | null;
  evidenceSourceId: string | null;
  orderReference: string | null;
};
export type Level = "SATTELFEST" | "WACKELIG" | "GEFAEHRDET" | "UNKLAR";
export const levelLabel: Record<Level, string> = { SATTELFEST: "sattelfest", WACKELIG: "wackelig", GEFAEHRDET: "gefährdet", UNKLAR: "zu wenig Daten" };

export type HealthResult = {
  accountId: string;
  accountName: string;
  score: number | null;
  coverage: number;
  level: Level;
  dimensions: Dimension[];
  engagements: Engagement[];
  /** Offene Fragen fürs Interview, in sinnvoller Reihenfolge */
  questions: HealthQuestion[];
  answers: HealthAnswers;
  answersVersion: number;
};

export type HealthQuestionKey = "ENGAGEMENT_END" | "ENGAGEMENT_MISSING" | "FEEDBACK" | "LISTING" | "RISKS" | "PEOPLE";
export type HealthQuestion = { key: HealthQuestionKey; text: string; why: string; orderId?: string };

const today = () => new Date().toISOString().slice(0, 10);
const daysBetween = (fromIso: string, toIso: string) => Math.round((new Date(toIso).getTime() - new Date(fromIso).getTime()) / DAY);
const isStale = (at: string | undefined) => !at || Date.now() - new Date(at).getTime() > STALE_DAYS * DAY;

/** Verlängerungsauslöser: Frist minus 14 Tage, sonst Einsatzende minus 8 Wochen. */
/** Fahrplan Verlängerung, Schritt 1: Ping an den BD 3 Monate vor Ende (bzw. 30 Tage vor der Verlängerungsfrist). */
export function renewalPingDate(o: { plannedEnd: string | null; renewalDeadline: string | null }): string | null {
  const cands: number[] = [];
  if (o.plannedEnd) cands.push(new Date(o.plannedEnd).getTime() - 90 * DAY);
  if (o.renewalDeadline) cands.push(new Date(o.renewalDeadline).getTime() - 30 * DAY);
  return cands.length ? new Date(Math.min(...cands)).toISOString().slice(0, 10) : null;
}

export type Milestone = { key: string; date: string; label: string; state: "ERLEDIGT" | "UEBERFAELLIG" | "BALD" | "SPAETER" };

/**
 * Fahrplan je auslaufendem Einsatz (Feedback Pilot): Was ist wann zu tun? Stand aus dem Ping (Aktion) und den
 * Schritten des Vorgehens „Verlängerung vor Einsatzende“. Orientierung, keine Sperre.
 */
export async function renewalRoadmaps(engagements: Engagement[], now = new Date()): Promise<Map<string, Milestone[]>> {
  const out = new Map<string, Milestone[]>();
  const withEnd = engagements.filter((e) => e.plannedEnd || e.renewalDeadline);
  if (!withEnd.length) return out;
  const pingTasks = await db.query.standardTasks.findMany({ where: inArray(schema.standardTasks.key, withEnd.map((e) => `renewal-ping:order:${e.orderId}`)) });
  const pingActions = pingTasks.filter((x) => x.actionId).length ? await db.query.actions.findMany({ where: inArray(schema.actions.id, pingTasks.map((x) => x.actionId!).filter(Boolean)) }) : [];
  const pb = await db.query.playbooks.findMany({ where: eq(schema.playbooks.code, "VERLAENGERUNG") });
  const runs = pb.length ? await db.query.playbookRuns.findMany({ where: and(inArray(schema.playbookRuns.opportunityId, withEnd.map((e) => e.opportunityId)), inArray(schema.playbookRuns.playbookId, pb.map((p) => p.id))) }) : [];
  const steps = runs.length ? await db.query.playbookRunSteps.findMany({ where: inArray(schema.playbookRunSteps.runId, runs.map((r) => r.id)) }) : [];
  const t = now.toISOString().slice(0, 10);
  const soon = new Date(now.getTime() + 14 * DAY).toISOString().slice(0, 10);
  const add = (d: string, n: number) => new Date(new Date(d).getTime() + n * DAY).toISOString().slice(0, 10);
  for (const e of withEnd) {
    const end = e.plannedEnd ?? e.renewalDeadline!;
    const ping = renewalPingDate(e)!;
    const trig = renewalTriggerDate(e)!;
    const pingAction = pingActions.find((a) => pingTasks.some((x) => x.key === `renewal-ping:order:${e.orderId}` && x.actionId === a.id));
    const run = runs.filter((r) => r.opportunityId === e.opportunityId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    const st = (pos: number) => (run ? steps.find((s) => s.runId === run.id && s.position === pos) : undefined);
    const doneStep = (pos: number) => { const x = st(pos); return !!x && (x.status === "ERLEDIGT" || x.status === "UEBERSPRUNGEN"); };
    const raw: { key: string; date: string; label: string; done: boolean }[] = [
      { key: "PING", date: ping, label: "Ping an den BD: Verlängerung beim Kunden ansprechen (Zufriedenheit, Anschlussbedarf, Bestellweg)", done: pingAction?.status === "ERLEDIGT" || doneStep(1) },
      { key: "START", date: trig, label: run ? "Vorgehen „Verlängerung vor Einsatzende“ läuft – Schritt 1: Zufriedenheit und Wirkung abfragen" : "Vorgehen „Verlängerung vor Einsatzende“ startet – Zufriedenheit und Wirkung abfragen", done: !!run },
      { key: "WIRKUNG", date: add(trig, 7), label: "Zufriedenheit und belegbare Wirkung sind notiert", done: doneStep(1) },
      { key: "BEDARF", date: add(trig, 14), label: "Anschlussbedarf klären – weitere Rollen, Freelancer, neue Vorhaben?", done: doneStep(2) },
      { key: "ANGEBOT", date: add(trig, 28), label: "Verlängerung oder Ausweitung anbieten; Bestell- und Freigabeweg klären", done: doneStep(3) },
      { key: "ESKALATION", date: add(end, -28), label: "Spätestens jetzt: Principal/CEO sehen den Einsatz als Eskalation, wenn nichts erledigt ist", done: doneStep(1) || doneStep(3) },
      { key: "ENDE", date: end, label: "Einsatzende – Entscheidung dokumentiert (verlängert, ausgeweitet oder Ende bestätigt)", done: run?.status === "ABGESCHLOSSEN" },
    ];
    out.set(e.orderId, raw.sort((a, b) => a.date.localeCompare(b.date)).map((m) => ({ key: m.key, date: m.date, label: m.label, state: m.done ? "ERLEDIGT" : m.date < t ? "UEBERFAELLIG" : m.date <= soon ? "BALD" : "SPAETER" })));
  }
  return out;
}

export function renewalTriggerDate(o: { plannedEnd: string | null; renewalDeadline: string | null }): string | null {
  if (o.renewalDeadline) return new Date(new Date(o.renewalDeadline).getTime() - 14 * DAY).toISOString().slice(0, 10);
  if (o.plannedEnd) return new Date(new Date(o.plannedEnd).getTime() - 56 * DAY).toISOString().slice(0, 10);
  return null;
}

async function loadEngagements(accountIds: string[]): Promise<Map<string, Engagement[]>> {
  const out = new Map<string, Engagement[]>();
  if (accountIds.length === 0) return out;
  const rows = await db
    .select({ o: schema.orders, oppTitle: schema.opportunities.title, accountId: schema.opportunities.accountId, setupId: schema.opportunities.setupId, setupName: schema.projectSetups.name })
    .from(schema.orders)
    .innerJoin(schema.opportunities, eq(schema.opportunities.id, schema.orders.opportunityId))
    .innerJoin(schema.projectSetups, eq(schema.projectSetups.id, schema.opportunities.setupId))
    .where(and(inArray(schema.opportunities.accountId, accountIds), eq(schema.orders.status, "BEAUFTRAGUNG_BESTAETIGT"), ne(schema.orders.engagementStatus, "BEENDET")));
  const t = today();
  for (const r of rows) {
    const e: Engagement = {
      orderId: r.o.id,
      version: r.o.version,
      opportunityId: r.o.opportunityId,
      title: r.oppTitle,
      setupId: r.setupId,
      setupName: r.setupName,
      status: r.o.engagementStatus,
      plannedStart: r.o.plannedStart,
      plannedEnd: r.o.plannedEnd,
      renewalDeadline: r.o.renewalDeadline,
      daysToEnd: r.o.plannedEnd ? daysBetween(t, r.o.plannedEnd) : null,
      triggerDate: renewalTriggerDate(r.o),
      consultantUserId: r.o.consultantUserId,
      consultantName: r.o.consultantName,
      contractSourceId: r.o.contractSourceId,
      contractLink: r.o.contractLink,
      evidenceSourceId: r.o.evidenceSourceId,
      orderReference: r.o.orderReference,
    };
    out.set(r.accountId, [...(out.get(r.accountId) ?? []), e]);
  }
  for (const list of out.values()) list.sort((a, b) => (a.plannedEnd ?? "9999").localeCompare(b.plannedEnd ?? "9999"));
  return out;
}

async function lastActivity(accountIds: string[]): Promise<Map<string, Date>> {
  if (accountIds.length === 0) return new Map();
  const rows = await db.execute(sql`
    select a.id as "accountId", greatest(
      a.created_at,
      coalesce((select max(s.updated_at) from project_setups s where s.account_id = a.id), a.created_at),
      coalesce((select max(x.updated_at) from actions x join project_setups s on s.id = x.setup_id where s.account_id = a.id), a.created_at),
      coalesce((select max(g.created_at) from signals g join project_setups s on s.id = g.setup_id where s.account_id = a.id), a.created_at),
      coalesce((select max(o.updated_at) from opportunities o where o.account_id = a.id), a.created_at)
    ) as "last" from accounts a where a.id in (${sql.join(accountIds.map((i) => sql`${i}`), sql`, `)})`);
  const list = ((rows as unknown as { rows?: { accountId: string; last: string | Date }[] }).rows ?? []) as { accountId: string; last: string | Date }[];
  return new Map(list.map((r) => [r.accountId, new Date(r.last)]));
}

/** Health-Check für mehrere Kunden (ohne Rechteprüfung – Aufrufer liefert nur sichtbare Kunden). */
export async function computeHealthFor(accounts: { id: string; name: string }[]): Promise<HealthResult[]> {
  const ids = accounts.map((a) => a.id);
  if (ids.length === 0) return [];
  const [engagements, activity, answersRows, persons, opps, sos, accRows] = await Promise.all([
    loadEngagements(ids),
    lastActivity(ids),
    db.query.accountHealth.findMany({ where: inArray(schema.accountHealth.accountId, ids) }),
    db.query.persons.findMany({ where: inArray(schema.persons.accountId, ids), columns: { id: true, accountId: true } }),
    db.query.opportunities.findMany({ where: and(inArray(schema.opportunities.accountId, ids), inArray(schema.opportunities.status, ["ANTIZIPIERT", "IN_KLAERUNG", "BESTAETIGT", "PROFIL_ANGEBOT_VORGESTELLT", "AUSWAHL_BESTELLUNG"])), columns: { accountId: true, status: true } }),
    openSosByAccount(ids),
    db.query.accounts.findMany({ where: inArray(schema.accounts.id, ids), columns: { id: true, procurementChannel: true, intermediaryName: true } }),
  ]);
  const accById = new Map(accRows.map((a) => [a.id, a]));
  const personIds = persons.map((p) => p.id);
  const rels = personIds.length ? await db.query.relationships.findMany({ where: inArray(schema.relationships.personId, personIds), columns: { personId: true, holderUserId: true, state: true } }) : [];
  const accountOfPerson = new Map(persons.map((p) => [p.id, p.accountId]));
  const answersBy = new Map(answersRows.map((r) => [r.accountId, r]));

  return accounts.map((acc) => {
    const answers = (answersBy.get(acc.id)?.answers ?? {}) as HealthAnswers;
    const eng = engagements.get(acc.id) ?? [];
    const dims: Dimension[] = [];
    const questions: HealthQuestion[] = [];

    // 1) Einsätze (25): Anzahl laufender/beauftragter Einsätze, Klippe, Konzentration, nahes Ende
    {
      const d: Dimension = { key: "EINSAETZE", label: "Einsätze", max: 25, points: 0, known: true, reasons: [], missing: [] };
      const n = eng.length;
      d.points = n === 0 ? 0 : n === 1 ? 10 : n <= 3 ? 18 : 25;
      d.reasons.push(n === 0 ? "Kein laufender oder beauftragter Einsatz dokumentiert." : `${n} laufende/beauftragte Einsätze.`);
      if (n === 1) d.reasons.push("Alles hängt an einem Einsatz (Konzentration).");
      const noEnd = eng.filter((e) => !e.plannedEnd);
      for (const e of noEnd) {
        d.missing.push(`Einsatzende unbekannt: ${e.title}`);
        questions.push({ key: "ENGAGEMENT_END", orderId: e.orderId, text: `Wann endet der Einsatz „${e.title}“ – und bis wann muss über eine Verlängerung entschieden werden?`, why: "Ohne Enddatum kann die Verlängerung nicht rechtzeitig angestoßen werden." });
      }
      const ends = eng.filter((e) => e.plannedEnd).map((e) => e.plannedEnd!);
      const quarter = (iso: string) => `${iso.slice(0, 4)}-Q${Math.floor((Number(iso.slice(5, 7)) - 1) / 3) + 1}`;
      if (ends.length >= 2 && new Set(ends.map(quarter)).size === 1 && ends.length === n) {
        d.points = Math.max(0, d.points - 5);
        d.reasons.push(`−5: alle Einsätze enden im selben Quartal (${quarter(ends[0]!)}).`);
      }
      const soon = eng.filter((e) => e.daysToEnd !== null && e.daysToEnd >= 0 && e.daysToEnd <= 56);
      if (soon.length) {
        d.points = Math.max(0, d.points - 5);
        d.reasons.push(`−5: ${soon.length} Einsatz/Einsätze enden in den nächsten 8 Wochen.`);
      }
      if (n === 0) questions.push({ key: "ENGAGEMENT_MISSING", text: "Laufen bei diesem Kunden Einsätze, die hier noch nicht erfasst sind?", why: "Anzahl und Laufzeit der Einsätze sind die wichtigste Grundlage des Health-Checks." });
      dims.push(d);
    }

    // 2) Beziehungsbreite (20): Kontakte im Austausch, mehrere Verve-Beziehungshalter
    {
      const r = rels.filter((x) => accountOfPerson.get(x.personId) === acc.id);
      const active = new Set(r.filter((x) => x.state === "IM_AUSTAUSCH" || x.state === "KONKRETE_ZUSAMMENARBEIT").map((x) => x.personId));
      const holders = new Set(r.filter((x) => x.state !== "NICHT_AKTIV").map((x) => x.holderUserId));
      const d: Dimension = { key: "BEZIEHUNGEN", label: "Beziehungsbreite", max: 20, points: 0, known: persons.some((p) => p.accountId === acc.id), reasons: [], missing: [] };
      if (!d.known) {
        d.missing.push("Keine Ansprechpartner erfasst.");
        questions.push({ key: "PEOPLE", text: "Mit wem beim Kunden sind wir im Austausch – Name, Funktion, wer von uns hält die Beziehung?", why: "Hängt alles an einer Person, ist die Position verwundbar." });
      } else {
        d.points = active.size === 0 ? 0 : active.size === 1 ? 6 : active.size <= 3 ? 12 : 16;
        d.reasons.push(`${active.size} Kontakt(e) im aktiven Austausch.`);
        if (holders.size >= 2) {
          d.points += 4;
          d.reasons.push(`+4: ${holders.size} Beziehungshalter bei Verve (nicht nur eine Person).`);
        } else if (active.size > 0) d.reasons.push("Beziehung hängt bei Verve an einer Person.");
      }
      dims.push(d);
    }

    // 3) Zufriedenheit (20): letztes dokumentiertes Feedback
    {
      const f = answers.feedback;
      const d: Dimension = { key: "ZUFRIEDENHEIT", label: "Zufriedenheit", max: 20, points: 0, known: !!f, reasons: [], missing: [] };
      if (!f) {
        d.missing.push("Kein Kundenfeedback dokumentiert.");
      } else {
        d.points = f.tone === "POSITIV" ? 20 : f.tone === "NEUTRAL" ? 12 : 3;
        d.reasons.push(`Letztes Feedback ${feedbackToneLabel[f.tone]}${f.date ? ` (${f.date})` : ""}.`);
        const age = f.date ? daysBetween(f.date, today()) : null;
        if (age !== null && age > 180) {
          d.points = Math.round(d.points / 2);
          d.reasons.push("Halbiert: Feedback älter als 6 Monate.");
        }
      }
      if (!f || isStale(f.at)) questions.push({ key: "FEEDBACK", text: "Wie zufrieden ist der Kunde aktuell – und wann gab es das letzte Feedback?", why: "Unzufriedenheit zeigt sich selten von selbst, meist erst bei der Verlängerung." });
      dims.push(d);
    }

    // 4) Vertrag und Listung (15)
    {
      const l = answers.listing;
      const d: Dimension = { key: "LISTUNG", label: "Vertrag & Listung", max: 15, points: 0, known: !!l, reasons: [], missing: [] };
      if (!l) d.missing.push("Listung / Rahmenvertrag unbekannt.");
      else {
        d.points = l.status === "RAHMENVERTRAG" ? 15 : l.status === "GELISTET" ? 11 : 3;
        d.reasons.push(`${listingLabel[l.status]}.`);
        if (l.validUntil && daysBetween(today(), l.validUntil) <= 90) {
          d.points = Math.max(0, d.points - 5);
          d.reasons.push(`−5: läuft bis ${l.validUntil} (≤ 90 Tage).`);
        }
      }
      const pc = accById.get(acc.id);
      if (pc?.procurementChannel) d.reasons.push(`Beschaffung ${procurementLabel[pc.procurementChannel] ?? pc.procurementChannel}${pc.intermediaryName ? ` (${pc.intermediaryName})` : ""}.`);
      if (!l || isStale(l.at)) questions.push({ key: "LISTING", text: "Sind wir beim Kunden gelistet oder im Rahmenvertrag – und bis wann gilt das?", why: "Ohne Listung sehen wir viele Anfragen gar nicht." });
      dims.push(d);
    }

    // 5) Pipeline (10) – immer bekannt
    {
      const o = opps.filter((x) => x.accountId === acc.id);
      const confirmed = o.filter((x) => x.status !== "ANTIZIPIERT" && x.status !== "IN_KLAERUNG").length;
      const d: Dimension = { key: "PIPELINE", label: "Pipeline", max: 10, points: 0, known: true, reasons: [], missing: [] };
      d.points = Math.min(10, (o.length === 0 ? 0 : o.length === 1 ? 5 : 8) + (confirmed > 0 ? 2 : 0));
      d.reasons.push(o.length === 0 ? "Keine offene Chance." : `${o.length} offene Chance(n)${confirmed ? `, davon ${confirmed} bestätigt oder weiter` : ""}.`);
      dims.push(d);
    }

    // 6) Aktivität (10) – immer bekannt
    {
      const last = activity.get(acc.id);
      const days = last ? Math.floor((Date.now() - last.getTime()) / DAY) : 999;
      const d: Dimension = { key: "AKTIVITAET", label: "Aktivität", max: 10, points: days <= 30 ? 10 : days <= 90 ? 6 : days <= 180 ? 3 : 0, known: true, reasons: [`Letzte dokumentierte Aktivität vor ${days} Tagen.`], missing: [] };
      dims.push(d);
    }

    // Risiken (Abzug bis −15; „keine bekannt“ ist eine Antwort)
    let penalty = 0;
    {
      const r = answers.risks;
      const d: Dimension = { key: "RISIKEN", label: "Risiken im Umfeld", max: 0, points: 0, known: !!r, reasons: [], missing: [] };
      if (!r) d.missing.push("Risiken im Umfeld nicht abgefragt.");
      else if (r.items.length === 0) d.reasons.push("Keine Risiken bekannt.");
      else {
        penalty = Math.min(15, r.items.length * 5);
        d.points = -penalty;
        d.reasons.push(`−${penalty}: ${r.items.map((i) => riskLabel[i] ?? i).join(", ")}.`);
      }
      // Offene SOS-Protokolle zählen wie ein akutes Risiko (je −5, höchstens −10 zusätzlich)
      const open = sos.get(acc.id) ?? [];
      if (open.length) {
        const sp = Math.min(10, open.length * 5);
        penalty += sp;
        d.points = -penalty;
        d.reasons.push(`−${sp}: ${open.length} offene(s) SOS – ${open.map((x) => x.title).join(", ")}.`);
      }
      if (!r || isStale(r.at)) questions.push({ key: "RISKS", text: "Gibt es gerade Risiken im Umfeld – Umstrukturierung, Sparprogramm, Wettbewerber, Fürsprecher geht?", why: "Frühe Warnzeichen lassen sich noch abfangen." });
      dims.push(d);
    }

    const known = dims.filter((d) => d.known && d.max > 0);
    const knownMax = known.reduce((a, d) => a + d.max, 0);
    const totalMax = dims.reduce((a, d) => a + d.max, 0) + 10; // Risiken zählen mit 10 in die Datenlage
    const coverage = Math.round(((knownMax + (answers.risks ? 10 : 0)) / totalMax) * 100);
    const raw = known.reduce((a, d) => a + d.points, 0) - penalty;
    const score = coverage < 50 || knownMax === 0 ? null : Math.max(0, Math.min(100, Math.round((raw / knownMax) * 100)));
    const level: Level = score === null ? "UNKLAR" : score >= 70 ? "SATTELFEST" : score >= 45 ? "WACKELIG" : "GEFAEHRDET";
    return { accountId: acc.id, accountName: acc.name, score, coverage, level, dimensions: dims, engagements: eng, questions, answers, answersVersion: answersBy.get(acc.id)?.version ?? 0 };
  });
}

export async function getHealth(actor: Actor, accountId: string): Promise<HealthResult> {
  const account = await getAccount(actor, accountId);
  const [r] = await computeHealthFor([{ id: account.id, name: account.name }]);
  return r!;
}

export function canMaintainHealth(actor: Actor, account: typeof schema.accounts.$inferSelect): boolean {
  return canViewAccount(actor, account) && (hasRoleForAccountWrite(actor, account) || canReassignResponsibility(actor, account));
}

// ---------------------------------------------------------------------------
// Antworten aus dem geführten Interview
// ---------------------------------------------------------------------------

const dateOpt = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal(""));
export const answerInput = z.discriminatedUnion("key", [
  z.object({ key: z.literal("FEEDBACK"), tone: z.enum(feedbackToneValues), date: dateOpt, note: z.string().trim().max(1000).optional().default("") }),
  z.object({ key: z.literal("LISTING"), status: z.enum(listingValues), validUntil: dateOpt, note: z.string().trim().max(1000).optional().default("") }),
  z.object({ key: z.literal("RISKS"), items: z.array(z.enum(riskValues)).default([]), note: z.string().trim().max(1000).optional().default("") }),
]);

export async function saveHealthAnswer(actor: Actor, accountId: string, raw: unknown) {
  const account = await getAccount(actor, accountId);
  if (!canMaintainHealth(actor, account)) throw new ForbiddenError("Den Health-Check pflegen BD, Principal, CEO oder Sales Operations.");
  const parsed = answerInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const a = parsed.data;
  const stamp = { at: new Date().toISOString(), by: actor.userId };
  await db.transaction(async (tx) => {
    const row = await tx.query.accountHealth.findFirst({ where: eq(schema.accountHealth.accountId, accountId) });
    const answers = { ...((row?.answers ?? {}) as HealthAnswers) };
    if (a.key === "FEEDBACK") answers.feedback = { tone: a.tone, date: a.date || null, note: a.note, ...stamp };
    if (a.key === "LISTING") answers.listing = { status: a.status, validUntil: a.validUntil || null, note: a.note, ...stamp };
    if (a.key === "RISKS") answers.risks = { items: a.items, note: a.note, ...stamp };
    if (!row) await tx.insert(schema.accountHealth).values({ accountId, workspaceId: actor.workspaceId, answers, updatedBy: actor.userId });
    else {
      const [u] = await tx.update(schema.accountHealth).set({ answers, updatedBy: actor.userId, updatedAt: new Date(), version: row.version + 1 }).where(and(eq(schema.accountHealth.accountId, accountId), eq(schema.accountHealth.version, row.version))).returning();
      if (!u) throw new ConflictError();
    }
    await recordAudit(tx, actor, "health.answer_saved", "ACCOUNT", accountId, { frage: a.key });
  });
  return snapshotHealth(actor, accountId);
}

/** Einsatzdaten nachtragen (Ende, Verlängerungsfrist) – Dokumentation, keine Entscheidung. */
export const orderDatesInput = z.object({ version: z.coerce.number().int().positive(), plannedStart: dateOpt, plannedEnd: dateOpt, renewalDeadline: dateOpt });

export async function updateOrderDates(actor: Actor, orderId: string, raw: unknown) {
  const parsed = orderDatesInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError("Bitte gültige Daten angeben (TT.MM.JJJJ).");
  const i = parsed.data;
  const order = await db.query.orders.findFirst({ where: and(eq(schema.orders.id, orderId), eq(schema.orders.workspaceId, actor.workspaceId)) });
  if (!order) throw new NotFoundError("Auftrag");
  const opp = await db.query.opportunities.findFirst({ where: eq(schema.opportunities.id, order.opportunityId) });
  const account = await getAccount(actor, opp!.accountId);
  if (!canMaintainHealth(actor, account)) throw new ForbiddenError("Einsatzdaten pflegen BD, Principal, CEO oder Sales Operations.");
  if (i.plannedEnd && i.renewalDeadline && i.renewalDeadline > i.plannedEnd) throw new ValidationError("Die Verlängerungsfrist liegt nach dem Einsatzende.");
  const [u] = await db
    .update(schema.orders)
    .set({ plannedStart: i.plannedStart || order.plannedStart, plannedEnd: i.plannedEnd || null, renewalDeadline: i.renewalDeadline || null, version: i.version + 1, updatedAt: new Date() })
    .where(and(eq(schema.orders.id, orderId), eq(schema.orders.version, i.version)))
    .returning();
  if (!u) throw new ConflictError();
  await recordAudit(db, actor, "order.dates_updated", "ORDER", orderId, { ende: i.plannedEnd || null, frist: i.renewalDeadline || null });
  return u;
}

/**
 * Bestandseinsatz nachtragen: Einsätze, die schon laufen, aber nie im Tool erfasst wurden. Legt Chance
 * (beauftragt) und Auftrag (Beauftragung bestätigt, gestartet) mit Belegnotiz an. Entscheidungsrecht nötig.
 */
export const existingEngagementInput = z.object({
  setupId: z.string().min(1, "Bitte ein Setup wählen."),
  title: z.string().trim().min(3, "Bezeichnung fehlt").max(200),
  kind: z.enum(schema.chanceKindEnum.enumValues).default("VERVE_EXPERTE"),
  headcount: z.preprocess((v) => (v === "" || v == null ? undefined : v), z.coerce.number().int().min(1).max(999).optional()),
  plannedStart: dateOpt,
  plannedEnd: dateOpt,
  renewalDeadline: dateOpt,
  evidenceText: z.string().trim().max(2000).optional().or(z.literal("")), // optional: Belege liegen oft in anderen Systemen
  /** Operativer Berater (Etappe 26): Name; wird einem Verve-Nutzer zugeordnet, wenn der Name eindeutig passt */
  consultantName: z.string().trim().max(200).optional().or(z.literal("")),
});

export async function recordExistingEngagement(actor: Actor, accountId: string, raw: unknown) {
  assertDecisionRight(actor, "Einen laufenden Einsatz als beauftragt nachzutragen");
  const parsed = existingEngagementInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const i = parsed.data;
  const account = await getAccount(actor, accountId);
  if (!canMaintainHealth(actor, account)) throw new ForbiddenError("Einsätze nachtragen dürfen BD, Principal oder CEO.");
  const setup = await db.query.projectSetups.findFirst({ where: and(eq(schema.projectSetups.id, i.setupId), eq(schema.projectSetups.accountId, accountId)) });
  if (!setup) throw new ValidationError("Das Setup gehört nicht zu diesem Kunden.");
  const owner = setup.bdUserId ?? account.responsibleBdUserId ?? actor.userId;
  const consultant = i.consultantName ? await matchUserByName(actor.workspaceId, i.consultantName) : null;
  return db.transaction(async (tx) => {
    const [src] = i.evidenceText ? await tx.insert(schema.sources).values({ workspaceId: actor.workspaceId, setupId: setup.id, type: "NOTIZ", title: `Bestandseinsatz: ${i.title}`, body: i.evidenceText, origin: "manuell", sourceTime: new Date(), ownerUserId: actor.userId, accessClass: "ACCOUNT_TEAM" }).returning() : [null];
    const [opp] = await tx
      .insert(schema.opportunities)
      .values({ workspaceId: actor.workspaceId, accountId, setupId: setup.id, title: i.title, needDescription: `Laufender Einsatz, im Health-Check nachgetragen.${i.evidenceText ? ` ${i.evidenceText}` : ""}`.slice(0, 4000), status: "BEAUFTRAGT", kind: i.kind, headcount: i.headcount ?? null, ownerUserId: owner, confirmedAt: new Date(), confirmedSourceId: src?.id ?? null, createdBy: actor.userId })
      .returning();
    const [order] = await tx
      .insert(schema.orders)
      .values({ workspaceId: actor.workspaceId, opportunityId: opp!.id, evidenceSourceId: src?.id ?? null, evidenceNote: i.evidenceText || null, plannedStart: i.plannedStart || null, plannedEnd: i.plannedEnd || null, renewalDeadline: i.renewalDeadline || null, status: "BEAUFTRAGUNG_BESTAETIGT", confirmedAt: new Date(), confirmedBy: actor.userId, engagementStatus: "GESTARTET", startedAt: i.plannedStart ? new Date(i.plannedStart) : new Date(), consultantUserId: consultant?.id ?? null, consultantName: consultant?.displayName ?? (i.consultantName || null), createdBy: actor.userId })
      .returning();
    await recordAudit(tx, actor, "engagement.recorded_existing", "ORDER", order!.id, { accountId, titel: i.title });
    return order!;
  });
}

/** Verve-Nutzer unscharf nach Namen finden (eindeutig, sonst null) – z. B. „Ferdinand Henze“ ~ „Ferdinand Henze (Anker)“. */
export async function matchUserByName(workspaceId: string, name: string) {
  const norm = (x: string) => x.toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-zäöüß ]/g, " ").replace(/\s+/g, " ").trim();
  const q = norm(name);
  if (q.length < 3) return null;
  const users = await db.query.users.findMany({ where: and(eq(schema.users.workspaceId, workspaceId), eq(schema.users.status, "ACTIVE")) });
  const exact = users.filter((u) => norm(u.displayName) === q);
  if (exact.length === 1) return exact[0]!;
  if (!q.includes(" ")) return null; // nur Vorname ist zu unsicher
  const partial = users.filter((u) => norm(u.displayName).startsWith(q) || q.startsWith(norm(u.displayName)));
  return partial.length === 1 ? partial[0]! : null;
}

// ---------------------------------------------------------------------------
// Verlauf
// ---------------------------------------------------------------------------

export async function snapshotHealth(actor: Actor, accountId: string) {
  const account = await db.query.accounts.findFirst({ where: eq(schema.accounts.id, accountId) });
  if (!account) throw new NotFoundError("Kunde");
  const [h] = await computeHealthFor([{ id: account.id, name: account.name }]);
  const prev = await db.query.accountHealthSnapshots.findFirst({ where: eq(schema.accountHealthSnapshots.accountId, accountId), orderBy: desc(schema.accountHealthSnapshots.createdAt) });
  const [snap] = await db
    .insert(schema.accountHealthSnapshots)
    .values({ workspaceId: account.workspaceId, accountId, score: h!.score, coverage: h!.coverage, breakdown: h!.dimensions.map((d) => ({ key: d.key, points: d.points, max: d.max, known: d.known })), createdBy: actor.userId })
    .returning();
  // Deutlicher Rückgang → Vorschlag an den zuständigen BD
  if (prev?.score != null && h!.score != null && prev.score - h!.score > 10 && account.responsibleBdUserId) {
    const setup = await db.query.projectSetups.findFirst({ where: and(eq(schema.projectSetups.accountId, accountId), ne(schema.projectSetups.status, "ARCHIVIERT")), orderBy: desc(schema.projectSetups.updatedAt) });
    if (setup) {
      const [log] = await db.insert(schema.standardTasks).values({ workspaceId: account.workspaceId, key: `health-drop:${snap!.id}`, kind: "HEALTH_DROP", accountId, ownerUserId: account.responsibleBdUserId }).onConflictDoNothing().returning();
      if (log) {
        const [a] = await db
          .insert(schema.actions)
          .values({ workspaceId: account.workspaceId, setupId: setup.id, title: `Sattelfestigkeit bei ${account.name} gesunken (${prev.score} → ${h!.score})`, agreement: "Health-Check ansehen: Was hat sich verschlechtert? Mit Principal besprechen und Gegenmaßnahme vereinbaren.", ownerUserId: account.responsibleBdUserId, status: "VORGESCHLAGEN", dueDate: new Date(Date.now() + 7 * DAY).toISOString().slice(0, 10), createdBy: actor.userId })
          .returning();
        await db.update(schema.standardTasks).set({ actionId: a!.id }).where(eq(schema.standardTasks.id, log.id));
      }
    }
  }
  return { health: h!, snapshot: snap! };
}

export async function listSnapshots(accountId: string, limit = 6) {
  return db.query.accountHealthSnapshots.findMany({ where: eq(schema.accountHealthSnapshots.accountId, accountId), orderBy: desc(schema.accountHealthSnapshots.createdAt), limit });
}

/** Verlauf mindestens monatlich fortschreiben (beim Öffnen des Health-Checks). */
export async function ensureRecentSnapshot(actor: Actor, accountId: string): Promise<void> {
  const [latest] = await listSnapshots(accountId, 1);
  if (!latest || Date.now() - latest.createdAt.getTime() > 30 * DAY) await snapshotHealth(actor, accountId);
}
