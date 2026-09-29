import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { ConflictError, ForbiddenError } from "@/lib/errors";
import { DEFAULT_FOCUS, focusSystemText, getFocus, updateFocus } from "@/modules/focus/service";
import { ensureStandardTasks, freelancerStats } from "@/modules/focus/standardTasks";
import { resolveTaskOptions } from "@/modules/ai/settings";
import { LangdockProvider } from "@/modules/ai/providers/langdock";
import { TestProvider } from "@/modules/ai/providers/test";
import { createOpportunity } from "@/modules/opportunities/service";
import { analyzeOpportunity } from "@/modules/opportunities/advisor";
import { actorFor, ensureSeed } from "./helpers";

const NOTE_INPUT = { setupName: "S", participantNames: ["David"], knownPersonNames: [], confirmedAssertions: [] };

describe("Etappe 21: Strategischer Fokus „Wachstum über Freelancer“", () => {
  it("Fokus: Standard ist „Freelancer-Hebel aktiv“; pflegen nur Principal/CEO/Verwaltung; Versionsschutz", async () => {
    const s = await ensureSeed();
    const david = await actorFor("david");
    const petra = await actorFor("petra");
    expect((await getFocus(s.workspaceId)).freelancerLever).toBe(true);
    expect((await getFocus(s.workspaceId)).focusText).toBe(DEFAULT_FOCUS.focusText);
    await expect(updateFocus(david, { version: 0, focusText: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    await updateFocus(petra, { version: 0, focusText: "Wachstum über Freelancer – Pilot Q4", freelancerLever: "on", weeklyQuestion: "Welche Rollen fehlen?" });
    const f = await getFocus(s.workspaceId);
    expect(f.focusText).toMatch(/Pilot Q4/);
    expect(f.version).toBe(1);
    await expect(updateFocus(petra, { version: 0, focusText: "alt" })).rejects.toBeInstanceOf(ConflictError);
  });

  it("jeder KI-Aufruf bekommt den Fokus; Langdock hängt ihn als Systemhinweis an, ohne die Regeln zu lockern", async () => {
    const s = await ensureSeed();
    const opts = await resolveTaskOptions(s.workspaceId, "STRUCTURE_NOTE", "test");
    expect(opts.focus?.freelancerLever).toBe(true);
    expect(opts.focus?.text).toBeTruthy();

    const bodies: { messages: { role: string; content: string }[] }[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"items":[],"noSuggestionReason":"nichts"}' } }] }), { status: 200 });
    }) as typeof fetch;
    const p = new LangdockProvider({ apiKey: "k", baseUrl: "https://api.langdock.test/v1", defaultModel: "m", fetchImpl });
    await p.structureNote({ noteText: "Notiz", ...NOTE_INPUT }, { focus: { text: "Wachstum über Freelancer", freelancerLever: true } });
    const sys = bodies[0]!.messages.filter((m) => m.role === "system").map((m) => m.content);
    expect(sys).toHaveLength(2);
    expect(sys[1]).toMatch(/STRATEGISCHER FOKUS/);
    expect(sys[1]).toMatch(/FREELANCER_EXPERTE/);
    expect(sys[1]).toMatch(/ändert KEINE deiner Regeln/);
    // Ohne Fokus kein zusätzlicher Hinweis
    await p.structureNote({ noteText: "Notiz", ...NOTE_INPUT }, {});
    expect(bodies[1]!.messages.filter((m) => m.role === "system")).toHaveLength(1);
    expect(focusSystemText({ text: "", freelancerLever: false })).not.toMatch(/Freelancer-Hebel/);
  });

  it("Testanbieter erkennt mit aktivem Fokus Freelancer-Potenzial in Notizen – ohne Fokus nicht", async () => {
    const t = new TestProvider();
    const note = "Im Migrationsteam fehlen weitere Profile für die Testautomatisierung. David klärt den Termin.";
    const withFocus = await t.structureNote({ noteText: note, ...NOTE_INPUT }, { focus: { text: "F", freelancerLever: true } });
    const hit = withFocus.items.find((i) => i.title.startsWith("Freelancer-Potenzial"));
    expect(hit).toBeTruthy();
    expect(hit!.evidenceQuote).toMatch(/weitere Profile/);
    const without = await t.structureNote({ noteText: note, ...NOTE_INPUT });
    expect(without.items.some((i) => i.title.startsWith("Freelancer-Potenzial"))).toBe(false);
  });

  it("Standardaufgaben: Freelancer-Check je Chance, Ausweitung nach Einsatzstart, Potenzial je Kunde – je Anlass genau einmal, als Vorschlag", async () => {
    const s = await ensureSeed();
    const david = await actorFor("david");
    const opp = await createOpportunity(david, { setupId: s.setupId, title: "Testkoordination Migrationsteam", needDescription: "Der Kunde möchte die Testkoordination im Migrationsteam verstärken." });

    // Einsatz, der seit drei Wochen läuft
    const [order] = await db
      .insert(schema.orders)
      .values({ workspaceId: s.workspaceId, opportunityId: opp.id, status: "BEAUFTRAGUNG_BESTAETIGT", engagementStatus: "GESTARTET", startedAt: new Date(Date.now() - 21 * 86400000), createdBy: david.userId })
      .returning();
    // Kunde besteht seit über 90 Tagen, keine Freelancer-Chance
    await db.update(schema.accounts).set({ createdAt: new Date(Date.now() - 200 * 86400000) }).where(eq(schema.accounts.id, s.accountId));

    const n = await ensureStandardTasks(david);
    expect(n).toBeGreaterThanOrEqual(3);
    const logs = await db.query.standardTasks.findMany({ where: eq(schema.standardTasks.ownerUserId, david.userId) });
    const keys = logs.map((l) => l.key);
    expect(keys).toContain(`fl-check:opp:${opp.id}`);
    expect(keys).toContain(`fl-ausweitung:order:${order!.id}`);
    expect(keys.some((k) => k.startsWith(`fl-potenzial:${s.accountId}:`))).toBe(true);
    const check = await db.query.actions.findFirst({ where: eq(schema.actions.id, logs.find((l) => l.kind === "FL_CHECK_CHANCE")!.actionId!) });
    expect(check?.status).toBe("VORGESCHLAGEN");
    expect(check?.ownerUserId).toBe(david.userId);
    expect(check?.opportunityId).toBe(opp.id);

    // Idempotent
    expect(await ensureStandardTasks(david)).toBe(0);

    // Kennzahlen: offene Standardaufgaben gezählt; eine Freelancer-Chance zählt
    await createOpportunity(david, { setupId: s.setupId, title: "Weitere Testerin", needDescription: "Zusätzliche Testerin für das Migrationsteam gesucht.", kind: "FREELANCER_EXPERTE" });
    const st = await freelancerStats(david, [s.accountId]);
    expect(st.openFreelancerChances).toBe(1);
    expect(st.newFreelancerChances90d).toBe(1);
    expect(st.accountsWithoutFreelancerChance).toBe(0);
    expect(st.openChecks).toBeGreaterThanOrEqual(3);

    // Lageanalyse der Chance nennt den Freelancer-Hebel
    const { analysis } = await analyzeOpportunity(david, opp.id);
    expect(analysis.moves.some((m) => m.startsWith("Freelancer-Hebel"))).toBe(true);
  });

  it("Freelancer-Hebel aus → keine neuen Standardaufgaben", async () => {
    const s = await ensureSeed();
    const petra = await actorFor("petra");
    const lars = await actorFor("lars");
    const f = await getFocus(s.workspaceId);
    await updateFocus(petra, { version: f.version ?? 0, focusText: f.focusText, freelancerLever: "false" });
    await createOpportunity(lars, { setupId: (await db.query.projectSetups.findFirst({ where: eq(schema.projectSetups.accountId, s.otherAccountId) }))?.id ?? s.setupId, title: "Chance bei Lars", needDescription: "Beschreibung einer Chance beim Kunden." }).catch(() => null);
    expect(await ensureStandardTasks(lars)).toBe(0);
    const logs = await db.query.standardTasks.findMany({ where: and(eq(schema.standardTasks.ownerUserId, lars.userId)) });
    expect(logs).toHaveLength(0);
  });
});
