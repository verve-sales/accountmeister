import { and, asc, desc, eq, inArray, isNull, lt, notInArray, or } from "drizzle-orm";
import { z } from "zod";
import { db, schema, type Db, type Tx } from "@/db/client";
import { ConflictError, ForbiddenError, NotFoundError, TransitionError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/identity/actor";
import { notify, type NotificationKind } from "@/modules/notifications/service";
import { addWorkdays, plusDaysIso, todayIso } from "./calendar";
import { resolveSubject, subjectTypeValues, type ResolvedSubject } from "./subjects";
import { deputyOf, ensureDefaultTeams, isTeamLead, isTeamMember, teamMemberIds, type ServiceField } from "./teams";

/**
 * Vorgänge (Etappe 27, Kollaborationskern). Eine eigene Aufgabe, eine Anfrage an eine Person oder ein Team, eine
 * Prüfung oder eine Erinnerung – an einem Kunden, Setup, einer Chance, einem SOS oder ohne Bezug.
 *
 * Grundregeln:
 * - Auftraggeber:in (requester) und Bearbeiter:in (assignee) sind getrennt. Eine Anfrage wartet als „angefragt“,
 *   bis sie angenommen (oder bei Teams: übernommen) wird.
 * - Ist eine Prüfung vereinbart, geht das Ergebnis „zur Prüfung“ an die Auftraggeber:in zurück; sie nimmt ab oder
 *   gibt mit Begründung zur Nacharbeit zurück.
 * - Sichtbar für Beteiligte (Auftraggeber, Bearbeiter, Beobachter, Team) und für alle, die das Bezugsobjekt sehen.
 * - Jede Änderung: Audit-Eintrag und – in derselben Transaktion – Benachrichtigung der Betroffenen.
 */

export type WorkItem = typeof schema.workItems.$inferSelect;
export const workStatusValues = ["ANGEFRAGT", "RUECKFRAGE", "OFFEN", "IN_ARBEIT", "BLOCKIERT", "ZUR_PRUEFUNG", "ERLEDIGT", "ABGELEHNT", "VERWORFEN"] as const;
export type WorkStatus = (typeof workStatusValues)[number];
export const FINAL: WorkStatus[] = ["ERLEDIGT", "VERWORFEN"];
export const workStatusLabel: Record<string, string> = {
  ANGEFRAGT: "angefragt",
  RUECKFRAGE: "Rückfrage offen",
  OFFEN: "offen",
  IN_ARBEIT: "in Arbeit",
  BLOCKIERT: "blockiert",
  ZUR_PRUEFUNG: "zur Prüfung",
  ERLEDIGT: "erledigt",
  ABGELEHNT: "abgelehnt",
  VERWORFEN: "verworfen",
};
export const workKindLabel: Record<string, string> = { AKTION: "Aufgabe", ANFRAGE: "Anfrage", PRUEFUNG: "Prüfung", ERINNERUNG: "Erinnerung", SUCHE: "Suchauftrag", SHORTLIST: "Shortlist prüfen", NACHFASSEN: "Nachfassen", BETREUUNG: "Betreuungsübergabe" };

const TRANSITIONS: Record<WorkStatus, WorkStatus[]> = {
  ANGEFRAGT: ["OFFEN", "RUECKFRAGE", "ABGELEHNT", "VERWORFEN"],
  RUECKFRAGE: ["ANGEFRAGT", "OFFEN", "IN_ARBEIT", "VERWORFEN"],
  OFFEN: ["IN_ARBEIT", "BLOCKIERT", "ZUR_PRUEFUNG", "RUECKFRAGE", "ANGEFRAGT", "ERLEDIGT", "VERWORFEN"],
  IN_ARBEIT: ["BLOCKIERT", "ZUR_PRUEFUNG", "RUECKFRAGE", "ANGEFRAGT", "ERLEDIGT", "VERWORFEN"],
  BLOCKIERT: ["IN_ARBEIT", "ZUR_PRUEFUNG", "ERLEDIGT", "VERWORFEN"],
  ZUR_PRUEFUNG: ["ERLEDIGT", "IN_ARBEIT", "VERWORFEN"],
  ABGELEHNT: ["ANGEFRAGT", "VERWORFEN"],
  ERLEDIGT: [],
  VERWORFEN: [],
};

export function assertWorkTransition(from: string, to: WorkStatus): void {
  const allowed = TRANSITIONS[from as WorkStatus] ?? [];
  if (!allowed.includes(to)) throw new TransitionError(`Übergang von „${workStatusLabel[from] ?? from}“ nach „${workStatusLabel[to] ?? to}“ ist nicht vorgesehen.`);
}

const link = (id: string) => `/vorgaenge/${id}`;
const truthy = (v: unknown) => v === true || v === "true" || v === "on";
const issues = (e: z.ZodError) => e.issues.map((i) => i.message).join("; ");

async function activeUser(actor: Actor, userId: string, tx: Tx | Db = db) {
  const u = await tx.query.users.findFirst({ where: and(eq(schema.users.id, userId), eq(schema.users.workspaceId, actor.workspaceId), eq(schema.users.status, "ACTIVE")) });
  if (!u) throw new ValidationError("Person nicht gefunden oder nicht aktiv.");
  return u;
}

// ---------------------------------------------------------------------------
// Anlegen
// ---------------------------------------------------------------------------

export const createWorkItemInput = z
  .object({
    title: z.string().trim().min(3, "Bitte kurz benennen, worum es geht").max(300),
    description: z.string().trim().max(4000).optional().or(z.literal("")),
    subjectType: z.enum(subjectTypeValues).default("OHNE"),
    subjectId: z.string().optional().or(z.literal("")),
    /** Ziel: „me“, eine Person (userId) oder ein Team (team:<id>) */
    target: z.string().min(1, "Bitte wählen, wer den Vorgang bearbeitet."),
    serviceTypeId: z.string().optional().or(z.literal("")),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("")),
    priority: z.enum(["NORMAL", "HOCH"]).default("NORMAL"),
    /** Ergebnis vor dem Abschluss prüfen (bei Anfragen an Personen wählbar; bei Teams aus der Anfrageart) */
    reviewRequired: z.union([z.boolean(), z.enum(["true", "false", "on"])]).optional(),
    /** zusätzliche Checklistenpunkte, je Zeile einer */
    checklistText: z.string().max(4000).optional().or(z.literal("")),
    parentId: z.string().optional().or(z.literal("")),
    kind: z.enum(["AKTION", "ANFRAGE", "PRUEFUNG", "ERINNERUNG", "SUCHE", "SHORTLIST", "NACHFASSEN", "BETREUUNG"]).optional(),
  })
  .passthrough();

export async function createWorkItem(actor: Actor, raw: unknown, tx0?: Tx) {
  const parsed = createWorkItemInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(issues(parsed.error));
  const i = parsed.data;
  const extra = raw as Record<string, unknown>;

  let parent: WorkItem | null = null;
  if (i.parentId) {
    parent = await requireVisible(actor, i.parentId);
    if (FINAL.includes(parent.status as WorkStatus)) throw new ValidationError("Zu einem abgeschlossenen Vorgang können keine Unteraufgaben angelegt werden.");
  }
  const subject: ResolvedSubject =
    parent && (i.subjectType === "OHNE" || !i.subjectId)
      ? await resolveSubject(actor, parent.subjectType, parent.subjectId)
      : await resolveSubject(actor, i.subjectType, i.subjectId || null);

  // Ziel bestimmen
  let assigneeUserId: string | null = null;
  let teamId: string | null = null;
  if (i.target === "me") assigneeUserId = actor.userId;
  else if (i.target.startsWith("team:")) {
    await ensureDefaultTeams(actor.workspaceId);
    const team = await db.query.teams.findFirst({ where: and(eq(schema.teams.id, i.target.slice(5)), eq(schema.teams.workspaceId, actor.workspaceId), eq(schema.teams.isActive, true)) });
    if (!team) throw new ValidationError("Team nicht gefunden.");
    teamId = team.id;
  } else assigneeUserId = (await activeUser(actor, i.target)).id;

  // Anfrageart (nur bei Teams)
  let service: typeof schema.serviceTypes.$inferSelect | undefined;
  const fields: Record<string, string> = {};
  if (i.serviceTypeId) {
    service = await db.query.serviceTypes.findFirst({ where: and(eq(schema.serviceTypes.id, i.serviceTypeId), eq(schema.serviceTypes.workspaceId, actor.workspaceId), eq(schema.serviceTypes.isActive, true)) });
    if (!service) throw new ValidationError("Anfrageart nicht gefunden.");
    if (teamId && service.teamId !== teamId) throw new ValidationError("Die Anfrageart gehört zu einem anderen Team.");
    if (!teamId) teamId = service.teamId;
    const missing: string[] = [];
    for (const f of service.fields as ServiceField[]) {
      const v = String(extra[`field_${f.key}`] ?? "").trim().slice(0, 2000);
      if (v) fields[f.key] = v;
      else if (f.required) missing.push(f.label);
    }
    if (missing.length) throw new ValidationError(`Bitte noch angeben: ${missing.join(", ")}.`);
  }

  // Vertretung: neue Zuweisungen an Abwesende gehen an die Vertretung
  let deputyFor: string | null = null;
  if (assigneeUserId && assigneeUserId !== actor.userId) {
    const d = await deputyOf(assigneeUserId);
    if (d) {
      deputyFor = assigneeUserId;
      assigneeUserId = d;
    }
  }

  const self = assigneeUserId === actor.userId && !teamId;
  const kind = i.kind ?? (self ? "AKTION" : "ANFRAGE");
  const status: WorkStatus = self ? "OFFEN" : "ANGEFRAGT";
  const today = todayIso();
  const slaDueDate = service ? addWorkdays(today, service.defaultWorkdays) : null;
  const dueDate = i.dueDate || slaDueDate || null;
  if (dueDate && dueDate < today && !self) throw new ValidationError("Die Frist liegt in der Vergangenheit.");
  const checklist = [...((service?.checklist as string[]) ?? []), ...(i.checklistText ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean)].slice(0, 30).map((text) => ({ text, done: false }));
  const reviewRequired = service ? service.reviewRequired : !self && truthy(i.reviewRequired);

  const work = async (tx: Tx) => {
    const [row] = await tx
      .insert(schema.workItems)
      .values({
        workspaceId: actor.workspaceId,
        kind,
        subjectType: subject.type,
        subjectId: subject.id,
        accountId: subject.accountId,
        title: i.title,
        description: i.description || null,
        requesterUserId: actor.userId,
        assigneeUserId,
        teamId,
        serviceTypeId: service?.id ?? null,
        fields,
        priority: i.priority,
        status,
        dueDate,
        slaDueDate,
        checklist,
        reviewRequired,
        parentId: parent?.id ?? null,
        deputyFor,
        createdBy: actor.userId,
      })
      .returning();
    if (!row) throw new Error("Vorgang konnte nicht angelegt werden");
    await recordAudit(tx, actor, "work.created", "WORK_ITEM", row.id, { art: kind, status, an: assigneeUserId ?? `team:${teamId}`, bezug: subject.type });
    if (!self) {
      if (assigneeUserId) await notify(tx, { workspaceId: actor.workspaceId, userIds: [assigneeUserId], kind: "ZUGEWIESEN", title: `${actor.displayName}: ${row.title}`, link: link(row.id), actorUserId: actor.userId });
      else if (teamId) {
        const team = (await tx.query.teams.findFirst({ where: eq(schema.teams.id, teamId) }))!;
        await notify(tx, { workspaceId: actor.workspaceId, userIds: await teamMemberIds(team, tx), kind: "TEAM_EINGANG", title: `${team.name}: ${service ? `${service.name} – ` : ""}${row.title}`, link: link(row.id), actorUserId: actor.userId });
      }
    }
    return row;
  };
  return tx0 ? work(tx0) : db.transaction(work);
}

// ---------------------------------------------------------------------------
// Sichtbarkeit und Rollen am Vorgang
// ---------------------------------------------------------------------------

export type Roles = { requester: boolean; assignee: boolean; watcher: boolean; teamMember: boolean; teamLead: boolean };

export async function rolesOn(actor: Actor, item: WorkItem, tx: Tx | Db = db): Promise<Roles> {
  const team = item.teamId ? await tx.query.teams.findFirst({ where: eq(schema.teams.id, item.teamId) }) : null;
  const watcher = !!(await tx.query.workWatchers.findFirst({ where: and(eq(schema.workWatchers.workItemId, item.id), eq(schema.workWatchers.userId, actor.userId)) }));
  return {
    requester: item.requesterUserId === actor.userId,
    assignee: item.assigneeUserId === actor.userId,
    watcher,
    teamMember: team ? await isTeamMember(actor, team, tx) : false,
    teamLead: team ? await isTeamLead(actor, team, tx) : false,
  };
}

export async function canViewWorkItem(actor: Actor, item: WorkItem): Promise<boolean> {
  if (item.workspaceId !== actor.workspaceId) return false;
  const r = await rolesOn(actor, item);
  if (r.requester || r.assignee || r.watcher || r.teamMember || r.teamLead || item.deputyFor === actor.userId) return true;
  if (item.subjectType === "OHNE" || !item.subjectId) return false;
  try {
    await resolveSubject(actor, item.subjectType, item.subjectId);
    return true;
  } catch {
    return false;
  }
}

async function requireVisible(actor: Actor, id: string): Promise<WorkItem> {
  const item = await db.query.workItems.findFirst({ where: and(eq(schema.workItems.id, id), eq(schema.workItems.workspaceId, actor.workspaceId)) });
  if (!item || !(await canViewWorkItem(actor, item))) throw new NotFoundError("Vorgang");
  return item;
}

// ---------------------------------------------------------------------------
// Statuswechsel
// ---------------------------------------------------------------------------

export const workActionValues = ["ANNEHMEN", "UEBERNEHMEN", "ABLEHNEN", "STARTEN", "BLOCKIEREN", "FORTSETZEN", "ABSCHLIESSEN", "ABNEHMEN", "ZURUECKGEBEN", "VERWERFEN", "ERNEUT_ANFRAGEN", "RUECKFRAGE", "BEANTWORTEN", "ABGEBEN"] as const;
export type WorkAction = (typeof workActionValues)[number];

export const workActionInput = z.object({
  version: z.coerce.number().int().positive(),
  action: z.enum(workActionValues),
  note: z.string().trim().max(4000).optional().or(z.literal("")),
  result: z.string().trim().max(4000).optional().or(z.literal("")),
  /** bei ERNEUT_ANFRAGEN: neues Ziel (userId oder team:<id>) */
  target: z.string().optional().or(z.literal("")),
});

export async function actOnWorkItem(actor: Actor, id: string, raw: unknown) {
  const parsed = workActionInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(issues(parsed.error));
  const i = parsed.data;
  const item = await requireVisible(actor, id);
  // Veralteter Stand (z. B. parallele Übernahme durch eine Kollegin): verständlicher Konflikt statt Statusfehler
  if (i.version !== item.version) throw new ConflictError(item.assigneeUserId && item.assigneeUserId !== actor.userId ? "Der Vorgang wurde inzwischen von jemand anderem übernommen oder geändert. Bitte neu laden." : undefined);
  const r = await rolesOn(actor, item);
  const worker = r.assignee || (!item.assigneeUserId && r.teamMember);
  const deny = (msg: string): never => {
    throw new ForbiddenError(msg);
  };

  let to: WorkStatus;
  const patch: Partial<typeof schema.workItems.$inferInsert> = {};
  let event: { kind: NotificationKind; to: (string | null)[]; title: string } | null = null;
  const who = actor.displayName;

  switch (i.action) {
    case "ANNEHMEN": {
      if (item.status !== "ANGEFRAGT") throw new TransitionError("Der Vorgang ist bereits angenommen.");
      if (!(r.assignee || (!item.assigneeUserId && (r.teamMember || r.teamLead)))) deny("Annehmen kann nur die angefragte Person oder ein Mitglied des Teams.");
      to = "OFFEN";
      patch.assigneeUserId = item.assigneeUserId ?? actor.userId;
      if (item.requesterUserId !== actor.userId) event = { kind: "ANGENOMMEN", to: [item.requesterUserId], title: `${who} hat angenommen: ${item.title}` };
      break;
    }
    case "UEBERNEHMEN": {
      // Team-Vorgang selbst übernehmen – auch wenn eine Kollegin ihn schon hatte (z. B. Ausfall)
      if (!item.teamId || !(r.teamMember || r.teamLead)) deny("Übernehmen können Mitglieder des Teams.");
      if (item.assigneeUserId === actor.userId) throw new ValidationError("Der Vorgang liegt bereits bei dir.");
      to = item.status === "ANGEFRAGT" ? "OFFEN" : (item.status as WorkStatus);
      patch.assigneeUserId = actor.userId;
      const prev = item.assigneeUserId;
      event = { kind: "ANGENOMMEN", to: [item.requesterUserId, prev], title: `${who} hat übernommen: ${item.title}` };
      break;
    }
    case "ABLEHNEN":
      if (!(r.assignee || (r.teamMember && !item.assigneeUserId))) deny("Ablehnen kann nur die angefragte Person oder das Team.");
      if (!i.note || i.note.length < 3) throw new ValidationError("Bitte kurz begründen, warum die Anfrage abgelehnt wird.");
      to = "ABGELEHNT";
      patch.statusNote = i.note;
      event = { kind: "ABGELEHNT", to: [item.requesterUserId], title: `${who} hat abgelehnt: ${item.title}` };
      break;
    case "STARTEN":
    case "FORTSETZEN":
      if (!worker) deny("Nur die bearbeitende Person kann den Vorgang bearbeiten.");
      to = "IN_ARBEIT";
      if (!item.assigneeUserId) patch.assigneeUserId = actor.userId;
      break;
    case "BLOCKIEREN":
      if (!worker) deny("Nur die bearbeitende Person kann den Vorgang als blockiert markieren.");
      if (!i.note || i.note.length < 3) throw new ValidationError("Bitte kurz festhalten, was blockiert.");
      to = "BLOCKIERT";
      patch.statusNote = i.note;
      if (item.requesterUserId !== actor.userId) event = { kind: "KOMMENTAR", to: [item.requesterUserId], title: `Blockiert: ${item.title} – ${i.note.slice(0, 120)}` };
      break;
    case "ABSCHLIESSEN": {
      // Die bearbeitende Person schließt ab; die Auftraggeber:in darf den eigenen Auftrag jederzeit selbst als erledigt setzen
      // (z. B. Suchauftrag, der sich anders erledigt hat) – dann ohne Prüfschleife, die Bearbeiter:in wird informiert.
      if (!(worker || r.requester)) deny("Abschließen kann die bearbeitende Person oder die Auftraggeber:in.");
      const openChildren = await db.query.workItems.findFirst({ where: and(eq(schema.workItems.parentId, item.id), notInArray(schema.workItems.status, FINAL)), columns: { id: true } });
      if (openChildren) throw new ValidationError("Es sind noch Unteraufgaben offen.");
      const byRequester = r.requester && !worker;
      const needsReview = !byRequester && item.reviewRequired && item.requesterUserId !== actor.userId;
      if (needsReview && !i.result) throw new ValidationError("Bitte das Ergebnis kurz beschreiben – es geht zur Prüfung an die Auftraggeber:in.");
      to = needsReview ? "ZUR_PRUEFUNG" : "ERLEDIGT";
      if (i.result) patch.result = i.result;
      if (!item.assigneeUserId && !byRequester) patch.assigneeUserId = actor.userId;
      if (to === "ERLEDIGT") patch.completedAt = new Date();
      event = needsReview
        ? { kind: "ZUR_PRUEFUNG", to: [item.requesterUserId], title: `Bitte prüfen: ${item.title}` }
        : byRequester
          ? item.assigneeUserId && item.assigneeUserId !== actor.userId
            ? { kind: "ERLEDIGT", to: [item.assigneeUserId], title: `Von der Auftraggeber:in erledigt: ${item.title}` }
            : item.teamId && !item.assigneeUserId
              ? { kind: "ERLEDIGT", to: await teamMemberIds((await db.query.teams.findFirst({ where: eq(schema.teams.id, item.teamId) }))!), title: `Auftrag zurückgezogen/erledigt: ${item.title}` }
              : null
          : item.requesterUserId !== actor.userId
            ? { kind: "ERLEDIGT", to: [item.requesterUserId], title: `Erledigt: ${item.title}` }
            : null;
      break;
    }
    case "ABNEHMEN":
      if (!r.requester) deny("Abnehmen kann die Auftraggeber:in.");
      to = "ERLEDIGT";
      patch.completedAt = new Date();
      if (i.note) patch.statusNote = i.note;
      event = { kind: "ERLEDIGT", to: [item.assigneeUserId], title: `Abgenommen: ${item.title}` };
      break;
    case "ZURUECKGEBEN":
      if (!r.requester) deny("Zur Nacharbeit zurückgeben kann die Auftraggeber:in.");
      if (!i.note || i.note.length < 3) throw new ValidationError("Bitte kurz sagen, was noch fehlt.");
      to = "IN_ARBEIT";
      patch.statusNote = i.note;
      event = { kind: "ZURUECKGEGEBEN", to: [item.assigneeUserId], title: `Nacharbeit: ${item.title} – ${i.note.slice(0, 120)}` };
      break;
    case "VERWERFEN":
      if (!(r.requester || (r.assignee && item.requesterUserId === actor.userId) || r.teamLead)) deny("Verwerfen kann die Auftraggeber:in.");
      to = "VERWORFEN";
      patch.completedAt = new Date();
      if (i.note) patch.statusNote = i.note;
      if (item.assigneeUserId && item.assigneeUserId !== actor.userId) event = { kind: "KOMMENTAR", to: [item.assigneeUserId], title: `Verworfen: ${item.title}` };
      break;
    case "RUECKFRAGE": {
      // Fehlende Information sichtbar machen – vor der Annahme nur als kurze Intake-Rückfrage durch das Team
      if (!(worker || (item.status === "ANGEFRAGT" && (r.assignee || r.teamMember || r.teamLead)))) deny("Rückfragen stellt die angefragte Person oder das Team.");
      if (!i.note || i.note.length < 3) throw new ValidationError("Bitte die Rückfrage formulieren.");
      to = "RUECKFRAGE";
      patch.statusNote = i.note;
      patch.resumeStatus = item.status === "ANGEFRAGT" ? "ANGEFRAGT" : "IN_ARBEIT";
      event = { kind: "KOMMENTAR", to: [item.requesterUserId], title: `Rückfrage zu „${item.title}“: ${i.note.slice(0, 120)}` };
      break;
    }
    case "BEANTWORTEN": {
      if (!r.requester) deny("Beantworten kann die Auftraggeber:in.");
      if (item.status !== "RUECKFRAGE") throw new TransitionError("Es ist keine Rückfrage offen.");
      if (!i.note || i.note.length < 2) throw new ValidationError("Bitte die Antwort eintragen.");
      to = (item.resumeStatus as WorkStatus | null) ?? (item.assigneeUserId ? "IN_ARBEIT" : "ANGEFRAGT");
      patch.statusNote = `Antwort: ${i.note}`;
      patch.resumeStatus = null;
      if (!item.description?.includes(i.note)) patch.description = `${item.description ?? ""}\n\nAntwort auf Rückfrage (${todayIso()}): ${i.note}`.trim();
      if (item.assigneeUserId) event = { kind: "KOMMENTAR", to: [item.assigneeUserId], title: `Antwort zu „${item.title}“: ${i.note.slice(0, 120)}` };
      else if (item.teamId) event = { kind: "TEAM_EINGANG", to: await teamMemberIds((await db.query.teams.findFirst({ where: eq(schema.teams.id, item.teamId) }))!), title: `Antwort zu „${item.title}“ – wieder im Eingang` };
      break;
    }
    case "ABGEBEN": {
      // Angenommenen Vorgang zurückgeben: Team-Vorgang in die Warteschlange, sonst zurück an die Auftraggeber:in
      if (!r.assignee) deny("Abgeben kann nur die bearbeitende Person.");
      if (!i.note || i.note.length < 3) throw new ValidationError("Bitte kurz begründen, warum du den Vorgang abgibst.");
      if (item.teamId) {
        to = "ANGEFRAGT";
        patch.assigneeUserId = null;
        patch.statusNote = `Abgegeben von ${who}: ${i.note}`;
        const team = (await db.query.teams.findFirst({ where: eq(schema.teams.id, item.teamId) }))!;
        event = { kind: "TEAM_EINGANG", to: [...(await teamMemberIds(team)), item.requesterUserId], title: `Zurück im Eingang (${who}): ${item.title}` };
      } else {
        to = "ABGELEHNT";
        patch.statusNote = i.note;
        event = { kind: "ABGELEHNT", to: [item.requesterUserId], title: `${who} gibt zurück: ${item.title}` };
      }
      break;
    }
    case "ERNEUT_ANFRAGEN": {
      if (!r.requester) deny("Erneut anfragen kann die Auftraggeber:in.");
      to = "ANGEFRAGT";
      patch.statusNote = null;
      if (i.target?.startsWith("team:")) {
        const team = await db.query.teams.findFirst({ where: and(eq(schema.teams.id, i.target.slice(5)), eq(schema.teams.workspaceId, actor.workspaceId)) });
        if (!team) throw new ValidationError("Team nicht gefunden.");
        patch.teamId = team.id;
        patch.assigneeUserId = null;
        event = { kind: "TEAM_EINGANG", to: await teamMemberIds(team), title: `${team.name}: ${item.title}` };
      } else {
        const target = i.target ? (await activeUser(actor, i.target)).id : item.assigneeUserId;
        if (!target && !item.teamId) throw new ValidationError("Bitte wählen, an wen die Anfrage gehen soll.");
        patch.assigneeUserId = target;
        if (target) event = { kind: "ZUGEWIESEN", to: [target], title: `${who}: ${item.title}` };
        else {
          const team = (await db.query.teams.findFirst({ where: eq(schema.teams.id, item.teamId!) }))!;
          event = { kind: "TEAM_EINGANG", to: await teamMemberIds(team), title: `${team.name}: ${item.title}` };
        }
      }
      break;
    }
  }
  if (!(i.action === "UEBERNEHMEN" && to === item.status)) assertWorkTransition(item.status, to);

  return db.transaction(async (tx) => {
    const [u] = await tx
      .update(schema.workItems)
      .set({ ...patch, status: to, version: i.version + 1, updatedAt: new Date() })
      .where(and(eq(schema.workItems.id, item.id), eq(schema.workItems.version, i.version)))
      .returning();
    if (!u) throw new ConflictError();
    await recordAudit(tx, actor, "work.status_changed", "WORK_ITEM", item.id, { aktion: i.action, von: item.status, nach: to });
    // Betreuungsübergabe (Etappe 29): Annahme aktiviert die dauerhafte Zuordnung in derselben Transaktion
    if ((i.action === "ANNEHMEN" || i.action === "UEBERNEHMEN") && item.kind === "BETREUUNG" && u.assigneeUserId) {
      const { activateCareFromWorkItem } = await import("@/modules/engagements/care");
      await activateCareFromWorkItem(tx, actor, u, u.assigneeUserId);
    }
    const watchers = await tx.query.workWatchers.findMany({ where: eq(schema.workWatchers.workItemId, item.id) });
    if (event) await notify(tx, { workspaceId: actor.workspaceId, userIds: event.to, kind: event.kind, title: event.title, link: link(item.id), actorUserId: actor.userId });
    if (to === "ERLEDIGT" && watchers.length) await notify(tx, { workspaceId: actor.workspaceId, userIds: watchers.map((w) => w.userId).filter((w) => !event?.to.includes(w)), kind: "ERLEDIGT", title: `Erledigt: ${item.title}`, link: link(item.id), actorUserId: actor.userId });
    return u;
  });
}

// ---------------------------------------------------------------------------
// Weitere Änderungen
// ---------------------------------------------------------------------------

export const reassignInput = z.object({ version: z.coerce.number().int().positive(), target: z.string().min(1, "Bitte eine Person wählen.") });

/** Umverteilen: Auftraggeber:in, Team-Leitung oder bisherige Bearbeiter:in. Ziel: Person oder (Team-Vorgang) Mitglied. */
export async function reassignWorkItem(actor: Actor, id: string, raw: unknown) {
  const p = reassignInput.safeParse(raw);
  if (!p.success) throw new ValidationError(issues(p.error));
  const item = await requireVisible(actor, id);
  if (FINAL.includes(item.status as WorkStatus)) throw new TransitionError("Der Vorgang ist abgeschlossen.");
  const r = await rolesOn(actor, item);
  if (!(r.requester || r.teamLead || r.assignee)) throw new ForbiddenError("Umverteilen können Auftraggeber:in, Team-Leitung oder die bisherige Bearbeiter:in.");
  const target = await activeUser(actor, p.data.target);
  if (item.teamId) {
    const team = (await db.query.teams.findFirst({ where: eq(schema.teams.id, item.teamId) }))!;
    if (!(await teamMemberIds(team)).includes(target.id)) throw new ValidationError("Team-Vorgänge gehen nur an Mitglieder des Teams.");
  }
  let assignee = target.id;
  let deputyFor: string | null = null;
  const d = await deputyOf(target.id);
  if (d && target.id !== actor.userId) {
    deputyFor = target.id;
    assignee = d;
  }
  const status: WorkStatus = assignee === actor.userId ? (item.status === "ANGEFRAGT" ? "OFFEN" : (item.status as WorkStatus)) : item.status === "ABGELEHNT" ? "ANGEFRAGT" : (item.status as WorkStatus);
  return db.transaction(async (tx) => {
    const [u] = await tx
      .update(schema.workItems)
      .set({ assigneeUserId: assignee, deputyFor, status, version: p.data.version + 1, updatedAt: new Date() })
      .where(and(eq(schema.workItems.id, id), eq(schema.workItems.version, p.data.version)))
      .returning();
    if (!u) throw new ConflictError();
    await recordAudit(tx, actor, "work.reassigned", "WORK_ITEM", id, { von: item.assigneeUserId, an: assignee });
    await notify(tx, { workspaceId: actor.workspaceId, userIds: [assignee], kind: "ZUGEWIESEN", title: `${actor.displayName}: ${item.title}`, link: link(id), actorUserId: actor.userId });
    return u;
  });
}

export const checklistInput = z.object({ version: z.coerce.number().int().positive(), index: z.coerce.number().int().min(0), done: z.union([z.boolean(), z.enum(["true", "false", "on"])]) });

export async function toggleChecklistItem(actor: Actor, id: string, raw: unknown) {
  const p = checklistInput.safeParse(raw);
  if (!p.success) throw new ValidationError("Ungültige Angabe.");
  const item = await requireVisible(actor, id);
  const r = await rolesOn(actor, item);
  if (!(r.assignee || r.requester || (r.teamMember && !item.assigneeUserId))) throw new ForbiddenError("Die Checkliste pflegen Bearbeiter:in und Auftraggeber:in.");
  const list = [...((item.checklist as { text: string; done: boolean }[]) ?? [])];
  if (!list[p.data.index]) throw new ValidationError("Punkt nicht gefunden.");
  list[p.data.index] = { ...list[p.data.index]!, done: truthy(p.data.done) };
  const [u] = await db.update(schema.workItems).set({ checklist: list, version: p.data.version + 1, updatedAt: new Date() }).where(and(eq(schema.workItems.id, id), eq(schema.workItems.version, p.data.version))).returning();
  if (!u) throw new ConflictError();
  return u;
}

export const updateWorkInput = z.object({
  version: z.coerce.number().int().positive(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("")),
  priority: z.enum(["NORMAL", "HOCH"]).optional(),
  blockedById: z.string().optional().or(z.literal("")),
});

export async function updateWorkItem(actor: Actor, id: string, raw: unknown) {
  const p = updateWorkInput.safeParse(raw);
  if (!p.success) throw new ValidationError(issues(p.error));
  const item = await requireVisible(actor, id);
  const r = await rolesOn(actor, item);
  if (!(r.requester || r.teamLead || r.assignee)) throw new ForbiddenError("Frist und Priorität ändern Auftraggeber:in, Bearbeiter:in oder Team-Leitung.");
  if (p.data.blockedById) {
    if (p.data.blockedById === id) throw new ValidationError("Ein Vorgang kann nicht auf sich selbst warten.");
    await requireVisible(actor, p.data.blockedById);
  }
  return db.transaction(async (tx) => {
    const [u] = await tx
      .update(schema.workItems)
      .set({ dueDate: p.data.dueDate === undefined ? item.dueDate : p.data.dueDate || null, priority: p.data.priority ?? item.priority, blockedById: p.data.blockedById === undefined ? item.blockedById : p.data.blockedById || null, version: p.data.version + 1, updatedAt: new Date() })
      .where(and(eq(schema.workItems.id, id), eq(schema.workItems.version, p.data.version)))
      .returning();
    if (!u) throw new ConflictError();
    await recordAudit(tx, actor, "work.updated", "WORK_ITEM", id, { frist: u.dueDate, prio: u.priority });
    return u;
  });
}

export async function setWatching(actor: Actor, id: string, watching: boolean) {
  const item = await requireVisible(actor, id);
  if (watching) await db.insert(schema.workWatchers).values({ workItemId: item.id, userId: actor.userId }).onConflictDoNothing();
  else await db.delete(schema.workWatchers).where(and(eq(schema.workWatchers.workItemId, item.id), eq(schema.workWatchers.userId, actor.userId)));
}

// ---------------------------------------------------------------------------
// Listen
// ---------------------------------------------------------------------------

async function decorate(actor: Actor, rows: WorkItem[]) {
  if (!rows.length) return [];
  const userIds = [...new Set(rows.flatMap((r) => [r.requesterUserId, r.assigneeUserId, r.deputyFor]).filter((x): x is string => !!x))];
  const [users, teams, services, accounts] = await Promise.all([
    db.query.users.findMany({ where: inArray(schema.users.id, userIds), columns: { id: true, displayName: true } }),
    db.query.teams.findMany({ where: eq(schema.teams.workspaceId, actor.workspaceId) }),
    db.query.serviceTypes.findMany({ where: eq(schema.serviceTypes.workspaceId, actor.workspaceId), columns: { id: true, name: true } }),
    db.query.accounts.findMany({ where: inArray(schema.accounts.id, [...new Set(rows.map((r) => r.accountId).filter((x): x is string => !!x)), "-"]), columns: { id: true, name: true } }),
  ]);
  const un = new Map(users.map((u) => [u.id, u.displayName]));
  const tn = new Map(teams.map((t) => [t.id, t.name]));
  const sn = new Map(services.map((s) => [s.id, s.name]));
  const an = new Map(accounts.map((a) => [a.id, a.name]));
  const today = todayIso();
  return rows.map((r) => ({
    ...r,
    requesterName: un.get(r.requesterUserId) ?? "?",
    assigneeName: r.assigneeUserId ? un.get(r.assigneeUserId) ?? "?" : null,
    deputyForName: r.deputyFor ? un.get(r.deputyFor) ?? null : null,
    teamName: r.teamId ? tn.get(r.teamId) ?? null : null,
    serviceName: r.serviceTypeId ? sn.get(r.serviceTypeId) ?? null : null,
    accountName: r.accountId ? an.get(r.accountId) ?? null : null,
    overdue: !!r.dueDate && r.dueDate < today && !FINAL.includes(r.status as WorkStatus),
    slaState: !r.slaDueDate || FINAL.includes(r.status as WorkStatus) ? null : r.slaDueDate < today ? ("VERLETZT" as const) : r.slaDueDate <= addWorkdays(today, 1) ? ("KNAPP" as const) : ("OK" as const),
  }));
}
export type WorkItemView = Awaited<ReturnType<typeof decorate>>[number];

export const workFilterValues = ["alle", "heute", "ueberfaellig", "woche"] as const;
export type WorkFilter = (typeof workFilterValues)[number];

function applyFilter<T extends { dueDate: string | null }>(rows: T[], f: WorkFilter): T[] {
  const today = todayIso();
  if (f === "heute") return rows.filter((r) => r.dueDate && r.dueDate <= today);
  if (f === "ueberfaellig") return rows.filter((r) => r.dueDate && r.dueDate < today);
  if (f === "woche") return rows.filter((r) => r.dueDate && r.dueDate <= plusDaysIso(today, 7));
  return rows;
}

const sortRows = <T extends { dueDate: string | null; priority: string; createdAt: Date }>(rows: T[]) =>
  [...rows].sort((a, b) => (a.priority === b.priority ? 0 : a.priority === "HOCH" ? -1 : 1) || (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999") || a.createdAt.getTime() - b.createdAt.getTime());

/** „Meine Arbeit“: mir zugewiesen, von mir beauftragt, beobachtet, Team-Eingänge. */
export async function listMyWork(actor: Actor, filter: WorkFilter = "alle") {
  await ensureDefaultTeams(actor.workspaceId);
  const open = notInArray(schema.workItems.status, FINAL);
  const ws = eq(schema.workItems.workspaceId, actor.workspaceId);
  const assigned = await db.query.workItems.findMany({ where: and(ws, open, eq(schema.workItems.assigneeUserId, actor.userId), notInArray(schema.workItems.status, ["ZUR_PRUEFUNG", "ABGELEHNT"])) });
  const requested = await db.query.workItems.findMany({
    where: and(ws, open, eq(schema.workItems.requesterUserId, actor.userId), or(isNull(schema.workItems.assigneeUserId), notInArray(schema.workItems.assigneeUserId, [actor.userId]), inArray(schema.workItems.status, ["ZUR_PRUEFUNG"]))),
  });
  const w = await db.query.workWatchers.findMany({ where: eq(schema.workWatchers.userId, actor.userId) });
  const watched = w.length ? await db.query.workItems.findMany({ where: and(ws, open, inArray(schema.workItems.id, w.map((x) => x.workItemId))) }) : [];
  const teams = await db.query.teams.findMany({ where: and(eq(schema.teams.workspaceId, actor.workspaceId), eq(schema.teams.isActive, true)) });
  const myTeams = [];
  for (const t of teams) if (await isTeamMember(actor, t)) myTeams.push(t);
  const queue = myTeams.length ? await db.query.workItems.findMany({ where: and(ws, open, inArray(schema.workItems.teamId, myTeams.map((t) => t.id)), isNull(schema.workItems.assigneeUserId)) }) : [];
  return {
    assigned: applyFilter(sortRows(await decorate(actor, assigned)), filter),
    requested: applyFilter(sortRows(await decorate(actor, requested)), filter),
    watched: applyFilter(sortRows(await decorate(actor, watched)), filter),
    queue: applyFilter(sortRows(await decorate(actor, queue)), filter),
    myTeams: myTeams.map((t) => ({ id: t.id, name: t.name })),
    counts: { assigned: assigned.length, requested: requested.length, watched: watched.length, queue: queue.length },
  };
}

/** Vorgänge an einem Bezugsobjekt (offen + die letzten erledigten). */
export async function listWorkForSubject(actor: Actor, subjectType: string, subjectId: string) {
  await resolveSubject(actor, subjectType, subjectId);
  const rows = await db.query.workItems.findMany({
    where: and(eq(schema.workItems.workspaceId, actor.workspaceId), eq(schema.workItems.subjectType, subjectType), eq(schema.workItems.subjectId, subjectId), isNull(schema.workItems.parentId)),
    orderBy: [desc(schema.workItems.updatedAt)],
    limit: 60,
  });
  const v = await decorate(actor, rows);
  return { open: sortRows(v.filter((r) => !FINAL.includes(r.status as WorkStatus))), done: v.filter((r) => FINAL.includes(r.status as WorkStatus)).slice(0, 5) };
}

export async function getTeamQueue(actor: Actor, teamId: string) {
  const team = await db.query.teams.findFirst({ where: and(eq(schema.teams.id, teamId), eq(schema.teams.workspaceId, actor.workspaceId)) });
  if (!team) throw new NotFoundError("Team");
  if (!(await isTeamMember(actor, team)) && !(await isTeamLead(actor, team))) throw new NotFoundError("Team");
  const rows = await db.query.workItems.findMany({ where: and(eq(schema.workItems.teamId, teamId), notInArray(schema.workItems.status, FINAL)), orderBy: asc(schema.workItems.createdAt) });
  const done = await db.query.workItems.findMany({ where: and(eq(schema.workItems.teamId, teamId), inArray(schema.workItems.status, ["ERLEDIGT"])), orderBy: desc(schema.workItems.completedAt), limit: 10 });
  const v = sortRows(await decorate(actor, rows));
  return { unassigned: v.filter((r) => !r.assigneeUserId), inWork: v.filter((r) => r.assigneeUserId), done: await decorate(actor, done) };
}

export async function getWorkItemDetail(actor: Actor, id: string) {
  const item = await requireVisible(actor, id);
  const [view] = await decorate(actor, [item]);
  const roles = await rolesOn(actor, item);
  let subject: ResolvedSubject | null = null;
  try {
    subject = await resolveSubject(actor, item.subjectType, item.subjectId);
  } catch {
    subject = { type: item.subjectType as ResolvedSubject["type"], id: item.subjectId, accountId: item.accountId, label: "(kein Zugriff auf das Bezugsobjekt)", link: null };
  }
  const children = await decorate(actor, await db.query.workItems.findMany({ where: eq(schema.workItems.parentId, id), orderBy: asc(schema.workItems.createdAt) }));
  const parent = item.parentId ? await db.query.workItems.findFirst({ where: eq(schema.workItems.id, item.parentId), columns: { id: true, title: true } }) : null;
  const blockedBy = item.blockedById ? await db.query.workItems.findFirst({ where: eq(schema.workItems.id, item.blockedById), columns: { id: true, title: true, status: true } }) : null;
  const service = item.serviceTypeId ? await db.query.serviceTypes.findFirst({ where: eq(schema.serviceTypes.id, item.serviceTypeId) }) : null;
  const watchers = await db.query.workWatchers.findMany({ where: eq(schema.workWatchers.workItemId, id) });
  const users = await db.query.users.findMany({ where: and(eq(schema.users.workspaceId, actor.workspaceId), eq(schema.users.status, "ACTIVE")), columns: { id: true, displayName: true } });
  const un = new Map(users.map((u) => [u.id, u.displayName]));
  const history = await db.query.auditEvents.findMany({ where: and(eq(schema.auditEvents.objectType, "WORK_ITEM"), eq(schema.auditEvents.objectId, id)), orderBy: asc(schema.auditEvents.at) });
  let teamMembers: { id: string; name: string }[] = [];
  if (item.teamId) {
    const team = (await db.query.teams.findFirst({ where: eq(schema.teams.id, item.teamId) }))!;
    teamMembers = (await teamMemberIds(team)).map((uid) => ({ id: uid, name: un.get(uid) ?? "?" }));
  }
  return {
    item: view!,
    roles,
    subject,
    children,
    parent,
    blockedBy,
    service,
    serviceFields: (service?.fields as ServiceField[] | undefined) ?? [],
    watchers: watchers.map((w) => ({ userId: w.userId, name: un.get(w.userId) ?? "?" })),
    users: users.map((u) => ({ id: u.id, name: u.displayName })),
    teamMembers,
    history: history.map((h) => ({ at: h.at, who: h.actorUserId ? un.get(h.actorUserId) ?? "?" : "System", action: h.action, changes: h.changes as Record<string, unknown> | null })),
  };
}

/** Auswahl für Formulare: Personen und Teams mit Anfragearten. */
export async function workTargets(actor: Actor) {
  await ensureDefaultTeams(actor.workspaceId);
  const users = await db.query.users.findMany({ where: and(eq(schema.users.workspaceId, actor.workspaceId), eq(schema.users.status, "ACTIVE")), orderBy: asc(schema.users.displayName), columns: { id: true, displayName: true } });
  const teams = await db.query.teams.findMany({ where: and(eq(schema.teams.workspaceId, actor.workspaceId), eq(schema.teams.isActive, true)), orderBy: asc(schema.teams.name) });
  const services = await db.query.serviceTypes.findMany({ where: and(eq(schema.serviceTypes.workspaceId, actor.workspaceId), eq(schema.serviceTypes.isActive, true)), orderBy: asc(schema.serviceTypes.name) });
  return {
    users: users.filter((u) => u.id !== actor.userId).map((u) => ({ id: u.id, name: u.displayName })),
    teams: teams.map((t) => ({ id: t.id, name: t.name, services: services.filter((s) => s.teamId === t.id).map((s) => ({ id: s.id, name: s.name, description: s.description, defaultWorkdays: s.defaultWorkdays, fields: s.fields as ServiceField[] })) })),
  };
}

// ---------------------------------------------------------------------------
// Überfällig-Hinweise (einmal je Vorgang und Tag)
// ---------------------------------------------------------------------------

export async function generateOverdueNotifications(workspaceId?: string): Promise<number> {
  const today = todayIso();
  const rows = await db.query.workItems.findMany({
    where: and(workspaceId ? eq(schema.workItems.workspaceId, workspaceId) : undefined, notInArray(schema.workItems.status, [...FINAL, "ZUR_PRUEFUNG", "ABGELEHNT", "RUECKFRAGE"]), lt(schema.workItems.dueDate, today)),
    limit: 500,
  });
  let n = 0;
  for (const r of rows) {
    const to = r.assigneeUserId ? [r.assigneeUserId] : r.teamId ? await teamMemberIds((await db.query.teams.findFirst({ where: eq(schema.teams.id, r.teamId) }))!) : [];
    n += await notify(db, { workspaceId: r.workspaceId, userIds: to, kind: "UEBERFAELLIG", title: `Überfällig seit ${r.dueDate}: ${r.title}`, link: link(r.id), dedupeKey: `ueberfaellig:${r.id}:${today}` });
  }
  return n;
}

export async function ensureOverdueNotificationsSafe(actor: Actor) {
  try {
    await generateOverdueNotifications(actor.workspaceId);
  } catch (e) {
    console.error("Überfällig-Hinweise", e);
  }
}
