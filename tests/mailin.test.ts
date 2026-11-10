import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { getConfig, resetConfigCacheForTests } from "@/lib/config";
import { forwardedParticipants, looksLikeApplication, runMailInbox, type InboxClient, type InboxMeta } from "@/modules/mailin/service";
import { DEMO_USERS } from "@/db/seed";
import { ensureSeed } from "./helpers";

class MemoryInbox implements InboxClient {
  bodyCalls: string[] = [];
  constructor(private mails: (InboxMeta & { body: string })[]) {}
  list = async () => this.mails.map(({ body: _b, ...m }) => (void _b, m));
  body = async (id: string) => {
    this.bodyCalls.push(id);
    return this.mails.find((m) => m.id === id)!.body;
  };
}

const now = () => new Date().toISOString();
const FWD = `Bitte einordnen, gehört zum Beispielkonzern.

Von: Anne Keller <anne.keller@beispielkonzern.example>
Gesendet: Montag, 9. November 2026 10:12
An: David Demo <${DEMO_USERS.david.email}>
Betreff: Testautomatisierung ab Januar

Hallo Herr Demo, wir brauchen ab Januar zwei weitere Testautomatisierer im Plattformteam. Können Sie mir bis Freitag Profile schicken? Viele Grüße, Anne Keller`;

describe("Etappe 49: Mail-Eingang (Weiterleitung an das Accountmeister-Postfach)", () => {
  it("ME01: Weiterleitung eines Nutzers wird ausgewertet (Kärtchen, Quelle, Hinweis); Fremde, Unbestätigte und Bewerbungen nicht – ohne Inhalt abzurufen; idempotent", async () => {
    process.env.AI_PROVIDER = "test";
    process.env.MAIL_INBOX_MODE = "fixture";
    process.env.MAIL_INBOX = "sales@verve.example";
    resetConfigCacheForTests();
    const s = await ensureSeed();
    const inbox = new MemoryInbox([
      { id: "m1", messageId: "<m1@x>", subject: "WG: Testautomatisierung ab Januar", fromEmail: DEMO_USERS.david.email, fromName: "David Demo", receivedAt: now(), internal: true, body: FWD },
      { id: "m2", messageId: "<m2@x>", subject: "Bewerbung als Consultant", fromEmail: "bewerber@extern.example", fromName: "Bea Bewerberin (fiktiv)", receivedAt: now(), internal: false, body: "Sehr geehrte Damen und Herren, anbei meine Bewerbung und mein Lebenslauf." },
      { id: "m3", messageId: "<m3@x>", subject: "WG: Anfrage", fromEmail: DEMO_USERS.david.email, fromName: "David Demo", receivedAt: now(), internal: false, body: FWD },
      { id: "m4", messageId: "<m4@x>", subject: "WG: Initiativbewerbung Max Muster", fromEmail: DEMO_USERS.david.email, fromName: "David Demo", receivedAt: now(), internal: true, body: "Zur Info.\n\nVon: Max Muster <max@extern.example>\nSehr geehrte Damen und Herren, hiermit bewerbe mich als Berater. Mein Lebenslauf liegt bei." },
    ]);
    const r = await runMailInbox({ client: inbox, cfg: getConfig() });
    expect(r).toMatchObject({ gesehen: 4, ausgewertet: 1, abgelehnt: 3, fehler: 0 });
    expect(r.karten).toBeGreaterThan(0);
    // Inhalt nur für angenommene Absender abgerufen (m1, m4) – nicht für die Bewerbung von außen und nicht für den unbestätigten Absender
    expect(inbox.bodyCalls.sort()).toEqual(["m1", "m4"]);
    const items = await db.query.mailInboxItems.findMany();
    const by = (id: string) => items.find((i) => i.messageId === id)!;
    expect(by("<m1@x>").status).toBe("AUSGEWERTET");
    expect(by("<m1@x>").userId).toBe(s.users.david);
    expect(by("<m2@x>")).toMatchObject({ status: "ABGELEHNT", subject: null, userId: null });
    expect(by("<m3@x>").reason).toMatch(/intern/);
    expect(by("<m4@x>").reason).toMatch(/Bewerbung/);
    const src = (await db.query.sources.findFirst({ where: eq(schema.sources.id, by("<m1@x>").sourceId!) }))!;
    expect(src.type).toBe("EMAIL");
    expect(src.ownerUserId).toBe(s.users.david);
    expect(src.setupId).toBeTruthy(); // über die Absenderdomäne/den Kundennamen dem Beispielkonzern zugeordnet
    const cards = (await db.query.suggestions.findMany({ where: eq(schema.suggestions.type, "KARTE") })).filter((c) => c.sourceIds.includes(src.id));
    expect(cards.length).toBe(r.karten);
    expect(cards.every((c) => c.status === "NEU")).toBe(true);
    const notes = await db.query.notifications.findMany({ where: eq(schema.notifications.userId, s.users.david) });
    expect(notes.some((n) => /Weitergeleitete Mail „Testautomatisierung ab Januar“: \d+ Vorschlag/.test(n.title))).toBe(true);
    expect(notes.some((n) => /sieht nach einer Bewerbung aus/.test(n.title))).toBe(true);
    // zweiter Abruf: nichts doppelt
    const r2 = await runMailInbox({ client: inbox, cfg: getConfig() });
    expect(r2.gesehen).toBe(0);
    expect((await db.query.mailInboxItems.findMany()).length).toBe(4);
  });

  it("ME02: Helfer – Beteiligte aus der Weiterleitung, Bewerbungserkennung (Ausschreibungen zählen nicht)", () => {
    expect(forwardedParticipants(FWD).map((p) => p.email)).toContain("anne.keller@beispielkonzern.example");
    expect(looksLikeApplication("WG: Bewerbung", "anbei mein Lebenslauf")).toBe(true);
    expect(looksLikeApplication("WG: Bewerbung auf die Ausschreibung Testmanagement", "unser Angebot")).toBe(false);
    expect(looksLikeApplication("WG: Verlängerung Frau Klein", "bitte verlängern")).toBe(false);
  });

  it("ME03: ausgeschaltet → kein Abruf", async () => {
    process.env.MAIL_INBOX_MODE = "off";
    resetConfigCacheForTests();
    const inbox = new MemoryInbox([{ id: "x", messageId: "<x@x>", subject: "s", fromEmail: DEMO_USERS.david.email, fromName: "", receivedAt: now(), internal: true, body: FWD }]);
    expect((await runMailInbox({ client: inbox, cfg: getConfig() })).gesehen).toBe(0);
  });
});
