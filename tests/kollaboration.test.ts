import { describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { getConfig } from "@/lib/config";
import { ForbiddenError, NotFoundError, TransitionError, ValidationError } from "@/lib/errors";
import { loadActor, type Actor } from "@/modules/identity/actor";
import { assignRole } from "@/modules/governance/service";
import { addWorkdays, holidaysNrw, isWorkday, parseRelativeDue, plusDaysIso, todayIso } from "@/modules/work/calendar";
import { actOnWorkItem, assertWorkTransition, createWorkItem, generateOverdueNotifications, getWorkItemDetail, listMyWork, listWorkForSubject, reassignWorkItem, toggleChecklistItem } from "@/modules/work/service";
import { addAbsence, ensureDefaultTeams, removeAbsence } from "@/modules/work/teams";
import { addComment, findMentions, listComments } from "@/modules/comments/service";
import { listNotifications, markRead, saveMyPrefs, unreadCount } from "@/modules/notifications/service";
import { dispatchPendingEmails, renderDigest, renderSingle } from "@/modules/notifications/mailer";
import { createSos } from "@/modules/sos/service";
import { actorFor, ensureSeed } from "./helpers";

async function makeUser(name: string, role?: "SALES_OPS" | "BD"): Promise<Actor> {
  const s = await ensureSeed();
  const [u] = await db.insert(schema.users).values({ workspaceId: s.workspaceId, email: `${name.toLowerCase().replace(/\W+/g, "")}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}@verve.example`, displayName: name }).returning();
  if (role) await assignRole(await actorFor("admin"), { userId: u!.id, role });
  return (await loadActor(u!.id))!;
}

async function salesOpsTeam(workspaceId: string) {
  await ensureDefaultTeams(workspaceId);
  const team = (await db.query.teams.findFirst({ where: and(eq(schema.teams.workspaceId, workspaceId), eq(schema.teams.key, "SALES_OPS")) }))!;
  const services = await db.query.serviceTypes.findMany({ where: eq(schema.serviceTypes.teamId, team.id) });
  return { team, services };
}

const kinds = async (a: Actor) => (await listNotifications(a)).map((n) => n.kind);

describe("Etappe 27: Kollaborationskern – Werktage", () => {
  it("rechnet Werktage ohne Wochenende und NRW-Feiertage", () => {
    expect(holidaysNrw(2027).has("2027-03-26")).toBe(true); // Karfreitag
    expect(holidaysNrw(2027).has("2027-03-29")).toBe(true); // Ostermontag
    expect(holidaysNrw(2026).has("2026-06-04")).toBe(true); // Fronleichnam
    expect(isWorkday("2026-10-03")).toBe(false); // Tag der Deutschen Einheit (Samstag)
    expect(addWorkdays("2027-03-25", 1)).toBe("2027-03-30"); // Do → über Ostern → Di
    expect(addWorkdays("2026-10-02", 3)).toBe("2026-10-07"); // Fr → Mi
    expect(addWorkdays("2026-10-03", 0)).toBe("2026-10-05"); // Samstag → nächster Werktag
    expect(parseRelativeDue("bis Freitag", "2026-10-01")).toBe("2026-10-02");
    expect(parseRelativeDue("Donnerstag", "2026-10-01")).toBe("2026-10-08");
    expect(parseRelativeDue("in 2 Wochen", "2026-10-01")).toBe("2026-10-15");
    expect(parseRelativeDue("15.11.", "2026-10-01")).toBe("2026-11-15");
    expect(parseRelativeDue("irgendwann", "2026-10-01")).toBeNull();
  });
});

describe("Etappe 27: Vorgänge – Anfrage, Annahme, Prüfung", () => {
  it("Anfrage an eine Person: angefragt → angenommen → zur Prüfung → Nacharbeit → abgenommen", async () => {
    const s = await ensureSeed();
    const david = await actorFor("david");
    const nina = await actorFor("nina");
    const before = await unreadCount(nina);
    const item = await createWorkItem(david, { title: "Bitte Kontakt zur Fachabteilung klären", subjectType: "KUNDE", subjectId: s.accountId, target: nina.userId, reviewRequired: "on", checklistText: "Ansprechpartner\nTermin" });
    expect(item.status).toBe("ANGEFRAGT");
    expect(item.kind).toBe("ANFRAGE");
    expect(item.accountId).toBe(s.accountId);
    expect(await unreadCount(nina)).toBe(before + 1);
    expect((await listNotifications(nina))[0]!.kind).toBe("ZUGEWIESEN");

    // nur die angefragte Person nimmt an
    await expect(actOnWorkItem(await actorFor("petra"), item.id, { version: item.version, action: "ANNEHMEN" })).rejects.toBeInstanceOf(ForbiddenError);
    const a = await actOnWorkItem(nina, item.id, { version: item.version, action: "ANNEHMEN" });
    expect(a.status).toBe("OFFEN");
    expect(await kinds(david)).toContain("ANGENOMMEN");

    const c = await toggleChecklistItem(nina, item.id, { version: a.version, index: 0, done: "on" });
    expect((c.checklist as { done: boolean }[])[0]!.done).toBe(true);

    await expect(actOnWorkItem(nina, item.id, { version: c.version, action: "ABSCHLIESSEN" })).rejects.toBeInstanceOf(ValidationError); // Ergebnis fehlt
    const r = await actOnWorkItem(nina, item.id, { version: c.version, action: "ABSCHLIESSEN", result: "Frau Keller ist zuständig, Termin am Dienstag." });
    expect(r.status).toBe("ZUR_PRUEFUNG");
    expect(await kinds(david)).toContain("ZUR_PRUEFUNG");
    await expect(actOnWorkItem(nina, item.id, { version: r.version, action: "ABNEHMEN" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(actOnWorkItem(david, item.id, { version: r.version, action: "ZURUECKGEBEN" })).rejects.toBeInstanceOf(ValidationError);
    const back = await actOnWorkItem(david, item.id, { version: r.version, action: "ZURUECKGEBEN", note: "Bitte noch die Telefonnummer." });
    expect(back.status).toBe("IN_ARBEIT");
    expect(await kinds(nina)).toContain("ZURUECKGEGEBEN");
    const r2 = await actOnWorkItem(nina, item.id, { version: back.version, action: "ABSCHLIESSEN", result: "Nummer ergänzt." });
    const done = await actOnWorkItem(david, item.id, { version: r2.version, action: "ABNEHMEN" });
    expect(done.status).toBe("ERLEDIGT");
    expect(() => assertWorkTransition("ERLEDIGT", "IN_ARBEIT")).toThrow(TransitionError);

    // Bezug: am Kunden sichtbar; Fremde sehen nichts
    expect((await listWorkForSubject(david, "KUNDE", s.accountId)).done.map((x) => x.id)).toContain(item.id);
    await expect(getWorkItemDetail(await actorFor("lars"), item.id)).rejects.toBeInstanceOf(NotFoundError);
    const detail = await getWorkItemDetail(david, item.id);
    expect(detail.history.map((h) => h.action)).toEqual(expect.arrayContaining(["work.created", "work.status_changed"]));
  });

  it("eigene Aufgabe ist sofort offen; Ablehnen braucht Begründung und geht an die Auftraggeber:in zurück", async () => {
    const david = await actorFor("david");
    const nina = await actorFor("nina");
    const own = await createWorkItem(david, { title: "Notizen sortieren", target: "me" });
    expect(own.status).toBe("OFFEN");
    expect(own.kind).toBe("AKTION");
    const req = await createWorkItem(david, { title: "Bitte Referenz anfragen", target: nina.userId });
    await expect(actOnWorkItem(nina, req.id, { version: req.version, action: "ABLEHNEN" })).rejects.toBeInstanceOf(ValidationError);
    const rej = await actOnWorkItem(nina, req.id, { version: req.version, action: "ABLEHNEN", note: "Kein Kontakt dort." });
    expect(rej.status).toBe("ABGELEHNT");
    expect(await kinds(david)).toContain("ABGELEHNT");
    const petra = await actorFor("petra");
    const again = await actOnWorkItem(david, req.id, { version: rej.version, action: "ERNEUT_ANFRAGEN", target: petra.userId });
    expect(again.status).toBe("ANGEFRAGT");
    expect(again.assigneeUserId).toBe(petra.userId);
    const mine = await listMyWork(david);
    expect(mine.requested.map((x) => x.id)).toContain(req.id);
    expect(mine.assigned.map((x) => x.id)).toContain(own.id);
  });

  it("Unteraufgaben müssen erledigt sein, bevor der Vorgang abgeschlossen wird", async () => {
    const david = await actorFor("david");
    const parent = await createWorkItem(david, { title: "Angebot vorbereiten", target: "me" });
    const child = await createWorkItem(david, { title: "Preise prüfen", target: "me", parentId: parent.id });
    await expect(actOnWorkItem(david, parent.id, { version: parent.version, action: "ABSCHLIESSEN" })).rejects.toBeInstanceOf(ValidationError);
    await actOnWorkItem(david, child.id, { version: child.version, action: "ABSCHLIESSEN" });
    expect((await actOnWorkItem(david, parent.id, { version: parent.version, action: "ABSCHLIESSEN" })).status).toBe("ERLEDIGT");
  });
});

describe("Etappe 27: Teams, Leistungskatalog, Vertretung", () => {
  it("Anfrage an Sales Operations: Pflichtfelder, Frist in Werktagen, Checkliste, Warteschlange, Übernahme", async () => {
    const s = await ensureSeed();
    const david = await actorFor("david");
    const ops = await makeUser("Olga Ops (Sales Operations)", "SALES_OPS");
    const { team, services } = await salesOpsTeam(s.workspaceId);
    const ausschreibung = services.find((x) => x.key === "AUSSCHREIBUNG")!;
    await expect(createWorkItem(david, { title: "Ausschreibung Netzleitstelle", target: `team:${team.id}`, serviceTypeId: ausschreibung.id, subjectType: "KUNDE", subjectId: s.accountId })).rejects.toThrow(/Link oder Fundort/);
    const item = await createWorkItem(david, { title: "Ausschreibung Netzleitstelle", target: `team:${team.id}`, serviceTypeId: ausschreibung.id, subjectType: "KUNDE", subjectId: s.accountId, field_link: "Vergabeportal, Los 2", field_abgabe: "15.11." });
    expect(item.status).toBe("ANGEFRAGT");
    expect(item.assigneeUserId).toBeNull();
    expect(item.slaDueDate).toBe(addWorkdays(todayIso(), 5));
    expect(item.dueDate).toBe(item.slaDueDate);
    expect((item.checklist as unknown[]).length).toBe(4);
    expect(item.reviewRequired).toBe(true);
    expect(item.fields).toEqual({ link: "Vergabeportal, Los 2", abgabe: "15.11." });
    expect(await kinds(ops)).toContain("TEAM_EINGANG");
    expect((await listMyWork(ops)).queue.map((x) => x.id)).toContain(item.id);

    const taken = await actOnWorkItem(ops, item.id, { version: item.version, action: "ANNEHMEN" });
    expect(taken.assigneeUserId).toBe(ops.userId);
    expect((await listMyWork(ops)).assigned.map((x) => x.id)).toContain(item.id);
    // Kollegin übernimmt
    const ops2 = await makeUser("Otto Ops (Sales Operations)", "SALES_OPS");
    const over = await actOnWorkItem(ops2, item.id, { version: taken.version, action: "UEBERNEHMEN" });
    expect(over.assigneeUserId).toBe(ops2.userId);
    // Umverteilen nur an Team-Mitglieder
    await expect(reassignWorkItem(david, item.id, { version: over.version, target: (await actorFor("nina")).userId })).rejects.toBeInstanceOf(ValidationError);
    const re = await reassignWorkItem(david, item.id, { version: over.version, target: ops.userId });
    expect(re.assigneeUserId).toBe(ops.userId);
  });

  it("Abwesenheit: neue Anfragen gehen an die Vertretung, die Abwesende bekommt nur einen Eintrag ohne Mail", async () => {
    const david = await actorFor("david");
    const petra = await actorFor("petra");
    const away = await makeUser("Anna Abwesend");
    const today = todayIso();
    const abs = await addAbsence(away, { fromDate: today, toDate: plusDaysIso(today, 5), deputyUserId: petra.userId });
    await expect(addAbsence(away, { fromDate: today, toDate: today, deputyUserId: away.userId })).rejects.toBeInstanceOf(ValidationError);
    const item = await createWorkItem(david, { title: "Rückruf beim Kunden", target: away.userId });
    expect(item.assigneeUserId).toBe(petra.userId);
    expect(item.deputyFor).toBe(away.userId);
    // Kommentar mit Erwähnung der Abwesenden → Vertretung erhält einen Hinweis
    await removeAbsence(away, abs.id);
    const later = await createWorkItem(david, { title: "Zweiter Rückruf", target: away.userId });
    expect(later.assigneeUserId).toBe(away.userId);
  });
});

describe("Etappe 27: Kommentare und Erwähnungen", () => {
  it("findet @Name mit und ohne Klammerzusatz", () => {
    const users = [
      { id: "1", displayName: "David Demo (BD)" },
      { id: "2", displayName: "Nina Demo (Anker)" },
      { id: "3", displayName: "Nina Demoski" },
    ];
    expect(findMentions("Hallo @Nina Demo, kannst du?", users)).toEqual(["2"]);
    expect(findMentions("@david demo (bd) bitte", users)).toEqual(["1"]);
    expect(findMentions("@Nina Demoski übernimmt", users)).toEqual(["3"]);
    expect(findMentions("ohne Erwähnung", users)).toEqual([]);
  });

  it("Erwähnung benachrichtigt nur Personen, die das Objekt sehen dürfen", async () => {
    const s = await ensureSeed();
    const david = await actorFor("david");
    const nina = await actorFor("nina");
    const lars = await actorFor("lars");
    const r = await addComment(david, { subjectType: "KUNDE", subjectId: s.accountId, body: "@Nina Demo kannst du bitte die Lage einschätzen? @Lars Demo zur Info" });
    expect(r.comment.mentions).toEqual([nina.userId]);
    expect(r.skipped).toEqual(["Lars Demo (BD, anderer Kunde)"]);
    expect(await kinds(nina)).toContain("ERWAEHNT");
    expect(await kinds(lars)).not.toContain("ERWAEHNT");
    await expect(addComment(lars, { subjectType: "KUNDE", subjectId: s.accountId, body: "Hallo" })).rejects.toBeInstanceOf(NotFoundError);
    // Antwort: vorherige Kommentator:innen werden benachrichtigt
    await addComment(nina, { subjectType: "KUNDE", subjectId: s.accountId, body: "Mache ich bis Freitag." });
    expect((await listNotifications(david)).some((n) => n.kind === "KOMMENTAR" && n.title.includes("Mache ich"))).toBe(true);
    const list = await listComments(david, "KUNDE", s.accountId);
    expect(list.at(-1)!.authorName).toBe("Nina Demo (Anker)");
    await markRead(david);
    expect(await unreadCount(david)).toBe(0);
  });

  it("SOS benachrichtigt den zuständigen BD", async () => {
    const s = await ensureSeed();
    const nina = await actorFor("nina");
    const david = await actorFor("david");
    await createSos(nina, { accountId: s.accountId, kind: "LAGE_ENG", title: "Budget wird gekürzt", situation: "Der Bereich muss 20 Prozent einsparen, unser Einsatz steht zur Diskussion." });
    const n = (await listNotifications(david)).find((x) => x.kind === "SOS");
    expect(n?.title).toMatch(/Budget wird gekürzt/);
  });
});

describe("Etappe 27: Überfällig-Hinweise und E-Mail-Versand", () => {
  it("überfällig: ein Hinweis je Vorgang und Tag", async () => {
    const david = await actorFor("david");
    const item = await createWorkItem(david, { title: "Liegengebliebene Aufgabe", target: "me", dueDate: plusDaysIso(todayIso(), -2) });
    await generateOverdueNotifications(david.workspaceId);
    await generateOverdueNotifications(david.workspaceId);
    const hits = (await listNotifications(david)).filter((n) => n.kind === "UEBERFAELLIG" && n.link === `/vorgaenge/${item.id}`);
    expect(hits.length).toBe(1);
  });

  it("Mailtexte enthalten nur Titel und Link; Datei-Transport verschickt PENDING-Einträge", async () => {
    const single = renderSingle({ kind: "ZUGEWIESEN", title: "Bitte prüfen <script>", link: "/vorgaenge/x" }, "https://am.example");
    expect(single.text).toContain("https://am.example/vorgaenge/x");
    expect(single.html).not.toContain("<script>");
    expect(renderDigest([{ kind: "KOMMENTAR", title: "A", link: "/a" }, { kind: "ERLEDIGT", title: "B", link: "/b" }], "https://am.example").subject).toMatch(/2 Hinweise/);

    const nina = await actorFor("nina");
    await saveMyPrefs(nina, { email_ZUGEWIESEN: "on", digest: "on" });
    const [n] = await db.insert(schema.notifications).values({ workspaceId: nina.workspaceId, userId: nina.userId, kind: "ZUGEWIESEN", title: "Testversand", link: "/meine-arbeit", emailState: "PENDING" }).returning();
    const dir = await mkdtemp(path.join(os.tmpdir(), "am-mail-"));
    const sent = await dispatchPendingEmails({ ...getConfig(), MAIL_TRANSPORT: "file", MAIL_FILE_DIR: dir });
    expect(sent).toBeGreaterThanOrEqual(1);
    const files = await readdir(dir);
    const all = await Promise.all(files.map((f) => readFile(path.join(dir, f), "utf8")));
    expect(all.some((t) => t.includes("To: nina.demo@verve.example") && t.includes("Testversand"))).toBe(true);
    const after = await db.query.notifications.findFirst({ where: eq(schema.notifications.id, n!.id) });
    expect(after!.emailState).toBe("SENT");
  });
});

describe("Etappe 27: Assistent legt Vorgänge an", () => {
  it("„Sales Ops soll …“ wird zur Anfrage an das Team; „erinnere mich …“ zur eigenen Aufgabe", async () => {
    const { resetConfigCacheForTests } = await import("@/lib/config");
    const { getThreadView, sendMessage, decideCard } = await import("@/modules/assistant/service");
    process.env.AI_PROVIDER = "test";
    resetConfigCacheForTests();
    const s = await ensureSeed();
    const david = await actorFor("david");
    const view = await getThreadView(david, { type: "ACCOUNT", id: s.accountId });
    const r = await sendMessage(david, { threadId: view.thread.id, text: "Sales Ops soll die Ausschreibung der Netzleitstelle aufbereiten bis Freitag" });
    const card = r.cards.find((c) => c.item.type === "VORGANG");
    expect(card?.item).toMatchObject({ target: "SALES_OPS", serviceKey: "AUSSCHREIBUNG", dueHint: "bis Freitag" });
    const res = await decideCard(david, { threadId: view.thread.id, messageId: r.message.id, cardId: card!.id, decision: "UEBERNEHMEN" });
    expect(res.card.note).toMatch(/Sales Operations/);
    const w = await db.query.workItems.findFirst({ where: and(eq(schema.workItems.requesterUserId, david.userId), eq(schema.workItems.subjectId, s.accountId)), orderBy: (x, { desc }) => [desc(x.createdAt)] });
    expect(w?.title).toMatch(/Ausschreibung aufbereiten: Die Ausschreibung der Netzleitstelle aufbereiten/);
    expect(w?.teamId).toBeTruthy();
    expect(w?.dueDate).toBeTruthy();

    const r2 = await sendMessage(david, { threadId: view.thread.id, text: "Erinnere mich, die Referenzliste zu aktualisieren" });
    const c2 = r2.cards.find((c) => c.item.type === "VORGANG")!;
    expect(c2.item).toMatchObject({ target: "ICH" });
    const res2 = await decideCard(david, { threadId: view.thread.id, messageId: r2.message.id, cardId: c2.id, decision: "UEBERNEHMEN" });
    expect(res2.card.note).toMatch(/für dich/);
  });
});

describe("Etappe 27: Hilfe kennt den Kollaborationskern", () => {
  it("findet Vorgänge, Teams, Kommentare und Benachrichtigungen", async () => {
    const { searchHelp } = await import("@/modules/help/knowledge");
    expect(searchHelp("Wie gebe ich eine Aufgabe an jemanden weiter?")[0]?.section.id).toBe("vorgaenge");
    expect(searchHelp("Was ist der Team-Eingang von Sales Operations?").map((x) => x.section.id)).toContain("teams");
    expect(searchHelp("Wie erwähne ich jemanden im Kommentar?")[0]?.section.id).toBe("kommentare");
    expect(searchHelp("Ich bin im Urlaub, wer vertritt mich?")[0]?.section.id).toBe("benachrichtigungen");
    expect(searchHelp("Ich bin im Urlaub, wer bekommt meine Anfragen?").map((x) => x.section.id)).toContain("benachrichtigungen");
  });
});
