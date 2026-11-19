import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { ForbiddenError } from "@/lib/errors";
import { EXPIRY_URGENT_DAYS, EXPIRY_WINDOW_DAYS } from "@/lib/window";
import { hasRole, type Actor } from "@/modules/identity/actor";
import { plusDaysIso, todayIso } from "@/modules/work/calendar";
import { currentPeriod } from "@/modules/engagements/service";

/**
 * Assignmentmanager (e49): die Arbeitsoberfläche von Sales Operations, Backoffice und Geschäftsführung auf denselben
 * Daten wie der Accountmeister – alle Einsätze mit Laufzeiten und Konditionen, als Zeitleiste und als Aufgabenliste.
 * Reine Sicht; geändert wird über die bestehenden Abläufe (Einsatz, Verlängerung, Übergabe, Check-in).
 */

const RUNNING = ["VORBEREITUNG", "GEPLANT", "AKTIV", "PAUSIERT", "ENDET"];
const RENEWAL_OPEN = ["ZU_KLAEREN", "IN_ABSTIMMUNG", "ANGEBOTEN"];

export async function canUseAssignments(actor: Actor): Promise<boolean> {
  if (actor.roles.has("SALES_OPS") || hasRole(actor, "CEO") || actor.roles.has("ADMIN")) return true;
  const { isBackoffice } = await import("@/modules/conversion/profile");
  return isBackoffice(actor);
}

export type AsgState = "LAEUFT" | "GEPLANT" | "ENDET_BALD" | "DRINGEND" | "UEBERSCHRITTEN" | "VERLAENGERUNG" | "BEENDET";
export const asgStateLabel: Record<AsgState, string> = { LAEUFT: "läuft", GEPLANT: "geplant", ENDET_BALD: "endet in 8 Wochen", DRINGEND: "endet in 4 Wochen, offen", UEBERSCHRITTEN: "Ende überschritten", VERLAENGERUNG: "Verlängerung läuft", BEENDET: "beendet" };

export type AsgEngagement = {
  id: string;
  personId: string;
  person: string;
  kind: "FREELANCER" | "INTERN";
  accountId: string;
  accountName: string;
  title: string;
  status: string;
  start: string | null;
  end: string | null;
  daysToEnd: number | null;
  state: AsgState;
  renewalStatus: string | null;
  renewalTo: string | null;
  offerNumber: string | null;
  orderReference: string | null;
  mocoProjectId: number | null;
  ek: string | null;
  vk: string | null;
  rateUnit: string;
  scope: string | null;
  /** Freelancer-Vertrag: UNTERSCHRIEBEN | VERSENDET | ENTWURF | null (fehlt) */
  contract: string | null;
  /** Bestellung als Unterlage vorhanden */
  orderDoc: boolean;
  bdName: string;
  nextCheckin: { id: string; version: number; side: string; due: string; overdue: boolean; owner: string } | null;
  checkinDots: string[];
};

export type AsgTask = { key: string; kind: "VERLAENGERUNG" | "BESTELLUNG" | "VERTRAG" | "UEBERGABE" | "CHECKIN" | "ENDE"; title: string; detail: string; person: string; accountName: string; due: string | null; overdue: boolean; href: string };
export const asgTaskLabel: Record<AsgTask["kind"], string> = { VERLAENGERUNG: "Verlängerung", BESTELLUNG: "Bestellung", VERTRAG: "Vertrag", UEBERGABE: "Übergabe", CHECKIN: "Check-in", ENDE: "Einsatzende" };

export type AsgOverview = {
  today: string;
  engagements: AsgEngagement[];
  tasks: AsgTask[];
  kpis: { freelancer: number; intern: number; ending: number; renewals: number; contractsOpen: number; ordersOpen: number; handovers: number; checkinsOverdue: number };
};

const de = (iso: string | null) => (iso ? iso.split("-").reverse().join(".") : "?");
const dayDiff = (a: string, b: string) => Math.round((new Date(a).getTime() - new Date(b).getTime()) / 86400000);

export async function asgOverview(actor: Actor, opts: { includeEndedDays?: number } = {}): Promise<AsgOverview> {
  if (!(await canUseAssignments(actor))) throw new ForbiddenError("Den Assignmentmanager nutzen Sales Operations, Backoffice und Geschäftsführung.");
  const ws = actor.workspaceId;
  const today = todayIso();
  const endedSince = plusDaysIso(today, -(opts.includeEndedDays ?? 60));
  const all = await db.query.engagements.findMany({ where: eq(schema.engagements.workspaceId, ws), orderBy: [asc(schema.engagements.plannedEnd)] });
  const engs = all.filter((e) => RUNNING.includes(e.status) || (e.status === "ABGESCHLOSSEN" && (e.actualEnd ?? e.plannedEnd ?? "") >= endedSince));
  if (!engs.length) return { today, engagements: [], tasks: [], kpis: { freelancer: 0, intern: 0, ending: 0, renewals: 0, contractsOpen: 0, ordersOpen: 0, handovers: 0, checkinsOverdue: 0 } };
  const ids = engs.map((e) => e.id);
  const [accounts, fls, users, periods, renewals, checkins, links, handovers] = await Promise.all([
    db.query.accounts.findMany({ where: inArray(schema.accounts.id, [...new Set(engs.map((e) => e.accountId))]), columns: { id: true, name: true } }),
    db.query.freelancers.findMany({ where: inArray(schema.freelancers.id, [...new Set(engs.map((e) => e.freelancerId).filter((x): x is string => !!x)), "-"]), columns: { id: true, displayName: true, ekRate: true, ekUnit: true } }),
    db.query.users.findMany({ where: eq(schema.users.workspaceId, ws), columns: { id: true, displayName: true } }),
    db.query.engagementPeriods.findMany({ where: and(inArray(schema.engagementPeriods.engagementId, ids), isNull(schema.engagementPeriods.supersededById)), orderBy: [desc(schema.engagementPeriods.validFrom), desc(schema.engagementPeriods.createdAt)] }),
    db.query.renewalDecisions.findMany({ where: inArray(schema.renewalDecisions.engagementId, ids), orderBy: desc(schema.renewalDecisions.createdAt) }),
    db.query.checkins.findMany({ where: and(inArray(schema.checkins.engagementId, ids), inArray(schema.checkins.status, ["FAELLIG", "ANGEFRAGT", "GEPLANT"])), orderBy: asc(schema.checkins.dueDate) }),
    db.query.engagementDocuments.findMany({ where: inArray(schema.engagementDocuments.engagementId, ids) }),
    db.query.backofficeHandovers.findMany({ where: and(eq(schema.backofficeHandovers.workspaceId, ws), eq(schema.backofficeHandovers.status, "OFFEN")), orderBy: asc(schema.backofficeHandovers.createdAt) }),
  ]);
  const docs = links.length ? await db.query.contractDocuments.findMany({ where: inArray(schema.contractDocuments.id, [...new Set(links.map((l) => l.documentId))]) }) : [];
  const an = new Map(accounts.map((a) => [a.id, a.name]));
  const fn = new Map(fls.map((f) => [f.id, f]));
  const un = new Map(users.map((u) => [u.id, u.displayName]));
  const rank: Record<string, number> = { UNTERSCHRIEBEN: 3, VERSENDET: 2, ENTWURF: 1 };

  const engagements: AsgEngagement[] = engs.map((e) => {
    const fl = e.freelancerId ? fn.get(e.freelancerId) : null;
    const p = currentPeriod(periods.filter((x) => x.engagementId === e.id));
    const ren = renewals.find((r) => r.engagementId === e.id) ?? null;
    const openRen = ren && RENEWAL_OPEN.includes(ren.status) ? ren : null;
    const myDocs = docs.filter((d) => links.some((l) => l.engagementId === e.id && l.documentId === d.id));
    const contracts = myDocs.filter((d) => d.side === "FREELANCER" && ["EINZELBEAUFTRAGUNG", "NACHTRAG", "RAHMENVERTRAG"].includes(d.docType) && d.signedStatus !== "GEKUENDIGT");
    const contract = contracts.sort((a, b) => (rank[b.signedStatus] ?? 0) - (rank[a.signedStatus] ?? 0))[0]?.signedStatus ?? null;
    const end = e.actualEnd ?? e.plannedEnd ?? null;
    const daysToEnd = end ? dayDiff(end, today) : null;
    const ci = checkins.filter((c) => c.engagementId === e.id);
    const next = ci[0] ?? null;
    let state: AsgState = "LAEUFT";
    if (["ABGESCHLOSSEN", "ABGEBROCHEN"].includes(e.status)) state = "BEENDET";
    else if (["VORBEREITUNG", "GEPLANT"].includes(e.status)) state = "GEPLANT";
    else if (daysToEnd !== null && daysToEnd < 0) state = "UEBERSCHRITTEN";
    else if (openRen && openRen.proposedTo) state = "VERLAENGERUNG";
    else if (daysToEnd !== null && daysToEnd <= EXPIRY_URGENT_DAYS && e.status !== "ENDET") state = "DRINGEND";
    else if (daysToEnd !== null && daysToEnd <= EXPIRY_WINDOW_DAYS && e.status !== "ENDET") state = "ENDET_BALD";
    return {
      id: e.id,
      personId: e.freelancerId ? `fl:${e.freelancerId}` : `u:${e.internalUserId ?? e.id}`,
      person: fl?.displayName ?? (e.internalUserId ? un.get(e.internalUserId) ?? "?" : "?"),
      kind: e.freelancerId ? "FREELANCER" : "INTERN",
      accountId: e.accountId,
      accountName: an.get(e.accountId) ?? "?",
      title: e.title,
      status: e.status,
      start: e.actualStart ?? e.plannedStart ?? null,
      end,
      daysToEnd,
      state,
      renewalStatus: openRen?.status ?? null,
      renewalTo: openRen?.proposedTo ?? null,
      offerNumber: ren?.offerNumber ?? null,
      orderReference: e.orderReference ?? null,
      mocoProjectId: e.mocoProjectId ?? null,
      ek: e.freelancerId ? p?.ek ?? fl?.ekRate ?? null : null,
      vk: p?.vk ?? null,
      rateUnit: p?.rateUnit ?? (e.freelancerId && !p?.ek ? fl?.ekUnit ?? "TAG" : "TAG"),
      scope: p?.scopeAmount ? `${p.scopeAmount} ${p.scopeUnit === "TAGE_PRO_WOCHE" ? "T./Woche" : p.scopeUnit === "STUNDEN_PRO_WOCHE" ? "Std./Woche" : p.scopeUnit === "PROZENT" ? "%" : p.scopeUnit === "TAGE_GESAMT" ? "Tage" : ""}`.trim() : null,
      contract: e.freelancerId ? contract : null,
      orderDoc: myDocs.some((d) => d.side === "KUNDE" && d.docType === "BESTELLUNG"),
      bdName: un.get(e.bdUserId) ?? "?",
      nextCheckin: next ? { id: next.id, version: next.version, side: next.side, due: next.dueDate, overdue: next.dueDate < today, owner: un.get(next.ownerUserId) ?? "?" } : null,
      checkinDots: ci.map((c) => c.dueDate),
    };
  });

  // Aufgaben: was Sales Operations und Backoffice jetzt tun müssen – nach Fälligkeit
  const tasks: AsgTask[] = [];
  const live = engagements.filter((e) => e.state !== "BEENDET");
  for (const e of live) {
    const href = `/einsaetze/${e.id}`;
    const base = { person: e.person, accountName: e.accountName };
    if (e.state === "UEBERSCHRITTEN") tasks.push({ key: `ende:${e.id}`, kind: "ENDE", title: "Ende überschritten – abschließen oder verlängern", detail: `Ende war ${de(e.end)}`, ...base, due: e.end, overdue: true, href });
    else if ((e.state === "DRINGEND" || e.state === "ENDET_BALD") && e.status !== "ENDET") tasks.push({ key: `ren:${e.id}`, kind: "VERLAENGERUNG", title: e.renewalStatus === "ZU_KLAEREN" || !e.renewalStatus ? "Verlängerung klären" : "Verlängerung nachhalten", detail: `endet in ${e.daysToEnd} Tagen`, ...base, due: e.end, overdue: e.state === "DRINGEND", href: `${href}#verlaengerung` });
    else if (e.state === "VERLAENGERUNG") tasks.push({ key: `ren:${e.id}`, kind: "VERLAENGERUNG", title: `Verlängerung bis ${de(e.renewalTo)} umsetzen (Angebot, Bestellung, Vertrag)`, detail: e.offerNumber ? `Angebot ${e.offerNumber}` : "noch kein Angebot verknüpft", ...base, due: e.end, overdue: (e.daysToEnd ?? 99) <= EXPIRY_URGENT_DAYS, href: `${href}#verlaengerung` });
    if (["AKTIV", "PAUSIERT", "GEPLANT"].includes(e.status)) {
      if (!e.orderReference) tasks.push({ key: `po:${e.id}`, kind: "BESTELLUNG", title: "Bestellnummer fehlt", detail: e.orderDoc ? "Bestellung liegt vor – Nummer nachtragen" : "Bestellung des Kunden steht aus", ...base, due: null, overdue: false, href });
      if (e.kind === "FREELANCER" && e.contract !== "UNTERSCHRIEBEN") tasks.push({ key: `fv:${e.id}`, kind: "VERTRAG", title: e.contract === "VERSENDET" ? "Freelancer-Vertrag: Unterschrift fehlt" : e.contract === "ENTWURF" ? "Freelancer-Vertrag versenden" : "Freelancer-Vertrag erzeugen", detail: e.contract ? `Stand: ${e.contract.toLowerCase()}` : "noch keine Unterlage", ...base, due: null, overdue: false, href: `${href}#vertraege` });
    }
    if (e.nextCheckin && e.nextCheckin.overdue && e.nextCheckin.side === "FREELANCER") tasks.push({ key: `ci:${e.nextCheckin.id}`, kind: "CHECKIN", title: "Freelancer-Check-in überfällig", detail: `zuständig ${e.nextCheckin.owner}`, ...base, due: e.nextCheckin.due, overdue: true, href: "/assignments/checkins" });
  }
  const { handoverTask } = await import("@/modules/conversion/handover");
  for (const h of handovers) {
    const p = h.payload as { person?: string; kunde?: string };
    tasks.push({ key: `ho:${h.id}`, kind: "UEBERGABE", title: handoverTask[h.kind] ?? "Übergabe quittieren", detail: `seit ${de(h.createdAt.toISOString().slice(0, 10))}`, person: p.person ?? "?", accountName: p.kunde ?? "?", due: h.createdAt.toISOString().slice(0, 10), overdue: dayDiff(today, h.createdAt.toISOString().slice(0, 10)) > 2, href: `/uebergaben/${h.id}` });
  }
  // Reihenfolge: was Fristen hat zuerst (Ende, Verlängerung, Übergabe, Check-in), dann fehlende Unterlagen
  const prio: Record<AsgTask["kind"], number> = { ENDE: 0, VERLAENGERUNG: 1, UEBERGABE: 2, CHECKIN: 3, VERTRAG: 4, BESTELLUNG: 5 };
  tasks.sort((a, b) => prio[a.kind] - prio[b.kind] || Number(b.overdue) - Number(a.overdue) || (a.due ?? "9999").localeCompare(b.due ?? "9999") || a.person.localeCompare(b.person, "de"));

  const flLive = live.filter((e) => e.kind === "FREELANCER");
  return {
    today,
    engagements,
    tasks,
    kpis: {
      freelancer: new Set(flLive.filter((e) => ["AKTIV", "PAUSIERT", "ENDET"].includes(e.status)).map((e) => e.personId)).size,
      intern: new Set(live.filter((e) => e.kind === "INTERN" && ["AKTIV", "PAUSIERT", "ENDET"].includes(e.status)).map((e) => e.personId)).size,
      ending: live.filter((e) => ["ENDET_BALD", "DRINGEND", "UEBERSCHRITTEN"].includes(e.state)).length,
      renewals: live.filter((e) => e.state === "VERLAENGERUNG").length,
      contractsOpen: tasks.filter((t) => t.kind === "VERTRAG").length,
      ordersOpen: tasks.filter((t) => t.kind === "BESTELLUNG").length,
      handovers: handovers.length,
      checkinsOverdue: tasks.filter((t) => t.kind === "CHECKIN").length,
    },
  };
}

export type AsgCheckin = { id: string; version: number; engagementId: string; side: string; due: string; overdue: boolean; status: string; person: string; accountName: string; owner: string; lastNote: string | null };

/** Alle offenen Check-ins (Freelancer-Seite zuerst) – Sales Operations führt die Freelancer-Check-ins. */
export async function asgCheckins(actor: Actor): Promise<AsgCheckin[]> {
  if (!(await canUseAssignments(actor))) throw new ForbiddenError("Den Assignmentmanager nutzen Sales Operations, Backoffice und Geschäftsführung.");
  const today = todayIso();
  const rows = await db.query.checkins.findMany({ where: and(eq(schema.checkins.workspaceId, actor.workspaceId), inArray(schema.checkins.status, ["FAELLIG", "ANGEFRAGT", "GEPLANT"])), orderBy: asc(schema.checkins.dueDate) });
  if (!rows.length) return [];
  const engs = await db.query.engagements.findMany({ where: inArray(schema.engagements.id, [...new Set(rows.map((r) => r.engagementId))]) });
  const live = new Map(engs.filter((e) => RUNNING.includes(e.status)).map((e) => [e.id, e]));
  const [accounts, fls, users, done] = await Promise.all([
    db.query.accounts.findMany({ where: inArray(schema.accounts.id, [...new Set(engs.map((e) => e.accountId)), "-"]), columns: { id: true, name: true } }),
    db.query.freelancers.findMany({ where: inArray(schema.freelancers.id, [...new Set(engs.map((e) => e.freelancerId).filter((x): x is string => !!x)), "-"]), columns: { id: true, displayName: true } }),
    db.query.users.findMany({ where: eq(schema.users.workspaceId, actor.workspaceId), columns: { id: true, displayName: true } }),
    db.query.checkins.findMany({ where: and(inArray(schema.checkins.engagementId, [...live.keys(), "-"]), eq(schema.checkins.status, "ERLEDIGT")), orderBy: desc(schema.checkins.heldAt) }),
  ]);
  const an = new Map(accounts.map((a) => [a.id, a.name]));
  const fn = new Map(fls.map((f) => [f.id, f.displayName]));
  const un = new Map(users.map((u) => [u.id, u.displayName]));
  return rows
    .filter((r) => live.has(r.engagementId))
    .map((r) => {
      const e = live.get(r.engagementId)!;
      return { id: r.id, version: r.version, engagementId: e.id, side: r.side, due: r.dueDate, overdue: r.dueDate < today, status: r.status, person: e.freelancerId ? fn.get(e.freelancerId) ?? "?" : un.get(e.internalUserId ?? "") ?? "?", accountName: an.get(e.accountId) ?? "?", owner: un.get(r.ownerUserId) ?? "?", lastNote: done.find((d) => d.engagementId === e.id && d.side === r.side)?.note?.split("\n")[0]?.slice(0, 120) ?? null };
    })
    .sort((a, b) => (a.side === b.side ? a.due.localeCompare(b.due) : a.side === "FREELANCER" ? -1 : 1));
}

// ---------------------------------------------------------------------------
// e55: Chancen in der Zeitleiste – wer ist wo im Gespräch, in welcher Phase
// ---------------------------------------------------------------------------

/** Phasen in aufsteigender Verbindlichkeit (Darstellung: eine Farbe, von hell nach kräftig). */
export type AsgOppPhase = "VERMUTET" | "ANFRAGE" | "BESTAETIGT" | "ANGEBOT" | "AUSWAHL";
export const asgOppPhaseLabel: Record<AsgOppPhase, string> = { VERMUTET: "vermutet", ANFRAGE: "Anfrage", BESTAETIGT: "Bedarf bestätigt", ANGEBOT: "Profil/Angebot verschickt", AUSWAHL: "ausgewählt, Bestellung offen" };
const PHASE_RANK: AsgOppPhase[] = ["VERMUTET", "ANFRAGE", "BESTAETIGT", "ANGEBOT", "AUSWAHL"];
const OPP_PHASE: Record<string, AsgOppPhase> = { ANTIZIPIERT: "VERMUTET", IN_KLAERUNG: "ANFRAGE", BESTAETIGT: "BESTAETIGT", PROFIL_ANGEBOT_VORGESTELLT: "ANGEBOT", AUSWAHL_BESTELLUNG: "AUSWAHL" };
const CAND_PHASE: Record<string, AsgOppPhase> = { FREIGEGEBEN: "BESTAETIGT", VORGESTELLT: "ANGEBOT", INTERVIEW: "ANGEBOT", AUSGEWAEHLT: "AUSWAHL" };
const CAND_OPEN = ["IDENTIFIZIERT", "KONTAKT", "QUALIFIZIERT", "VORGESCHLAGEN", "FREIGEGEBEN", "VORGESTELLT", "INTERVIEW", "AUSGEWAEHLT"];

export type AsgOpportunity = {
  id: string; // Kandidatur
  opportunityId: string;
  positionId: string;
  personId: string;
  person: string;
  kind: "FREELANCER" | "INTERN";
  accountName: string;
  title: string;
  phase: AsgOppPhase;
  start: string;
  end: string;
  /** Zeitraum geschätzt (Position ohne Start bzw. Ende) */
  estimated: boolean;
  /** Überschneidung mit einem Einsatz oder einer anderen Chance derselben Person */
  conflict: string | null;
};

export async function asgOpportunities(actor: Actor, engagements: AsgEngagement[]): Promise<{ items: AsgOpportunity[]; withoutPerson: number }> {
  if (!(await canUseAssignments(actor))) throw new ForbiddenError("Den Assignmentmanager nutzen Sales Operations, Backoffice und Geschäftsführung.");
  const ws = actor.workspaceId;
  const today = todayIso();
  const opps = await db.query.opportunities.findMany({ where: and(eq(schema.opportunities.workspaceId, ws), inArray(schema.opportunities.status, Object.keys(OPP_PHASE) as never[])), columns: { id: true, title: true, status: true, accountId: true } });
  if (!opps.length) return { items: [], withoutPerson: 0 };
  const positions = await db.query.staffingPositions.findMany({ where: and(inArray(schema.staffingPositions.opportunityId, opps.map((o) => o.id)), inArray(schema.staffingPositions.status, ["ENTWURF", "OFFEN", "PAUSIERT"])) });
  if (!positions.length) return { items: [], withoutPerson: 0 };
  const cands = await db.query.candidacies.findMany({ where: and(inArray(schema.candidacies.positionId, positions.map((p) => p.id)), eq(schema.candidacies.isActive, true), inArray(schema.candidacies.status, CAND_OPEN)) });
  const [accounts, fls, users] = await Promise.all([
    db.query.accounts.findMany({ where: inArray(schema.accounts.id, [...new Set(opps.map((o) => o.accountId))]), columns: { id: true, name: true } }),
    db.query.freelancers.findMany({ where: inArray(schema.freelancers.id, [...new Set(cands.map((c) => c.freelancerId).filter((x): x is string => !!x)), "-"]), columns: { id: true, displayName: true } }),
    db.query.users.findMany({ where: eq(schema.users.workspaceId, ws), columns: { id: true, displayName: true } }),
  ]);
  const an = new Map(accounts.map((a) => [a.id, a.name]));
  const fn = new Map(fls.map((f) => [f.id, f.displayName]));
  const un = new Map(users.map((u) => [u.id, u.displayName]));
  const om = new Map(opps.map((o) => [o.id, o]));
  const pm = new Map(positions.map((p) => [p.id, p]));
  const items: AsgOpportunity[] = cands
    .filter((c) => c.freelancerId || c.internalUserId)
    .map((c) => {
      const pos = pm.get(c.positionId)!;
      const o = om.get(pos.opportunityId)!;
      const a = OPP_PHASE[o.status] ?? "ANFRAGE";
      const b = CAND_PHASE[c.status];
      const phase = b && PHASE_RANK.indexOf(b) > PHASE_RANK.indexOf(a) ? b : a;
      const start = pos.desiredStart && pos.desiredStart > today ? pos.desiredStart : pos.desiredStart ?? today;
      const end = pos.plannedEnd && pos.plannedEnd > start ? pos.plannedEnd : plusDaysIso(start, 90);
      return {
        id: c.id,
        opportunityId: o.id,
        positionId: pos.id,
        personId: c.freelancerId ? `fl:${c.freelancerId}` : `u:${c.internalUserId}`,
        person: c.freelancerId ? fn.get(c.freelancerId) ?? "?" : un.get(c.internalUserId!) ?? "?",
        kind: c.freelancerId ? ("FREELANCER" as const) : ("INTERN" as const),
        accountName: an.get(o.accountId) ?? "?",
        title: pos.title || o.title,
        phase,
        start,
        end,
        estimated: !pos.desiredStart || !pos.plannedEnd,
        conflict: null,
      };
    })
    // Chancen, die schon vorbei sind, interessieren hier nicht
    .filter((x) => x.end >= today);
  // Konflikte: Überschneidung mit laufendem Einsatz oder anderer Chance derselben Person
  const overlap = (s1: string, e1: string, s2: string, e2: string) => s1 <= e2 && s2 <= e1;
  for (const it of items) {
    const eng = engagements.find((e) => e.personId === it.personId && e.state !== "BEENDET" && overlap(it.start, it.end, e.start ?? "0000-01-01", e.renewalTo && e.renewalTo > (e.end ?? "") ? e.renewalTo : e.end ?? "9999-12-31"));
    const other = items.find((x) => x !== it && x.personId === it.personId && x.opportunityId !== it.opportunityId && overlap(it.start, it.end, x.start, x.end));
    it.conflict = eng ? `überschneidet sich mit dem Einsatz bei ${eng.accountName}${eng.end ? ` (bis ${de(eng.end)})` : ""}` : other ? `überschneidet sich mit der Chance bei ${other.accountName}` : null;
  }
  const staffed = new Set(cands.map((c) => c.positionId));
  const withoutPerson = positions.filter((p) => !staffed.has(p.id) && om.has(p.opportunityId)).length;
  return { items: items.sort((x, y) => x.start.localeCompare(y.start)), withoutPerson };
}
