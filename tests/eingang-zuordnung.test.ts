import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { ConflictError, ValidationError } from "@/lib/errors";
import { resetConfigCacheForTests } from "@/lib/config";
import { createAccount } from "@/modules/accounts/service";
import { createSetup } from "@/modules/setups/service";
import { domainMatches, keyDomainOf, learnDomain, setAccountKeys, suggestedDomains } from "@/modules/accounts/keys";
import { createPerson } from "@/modules/people/service";
import { eingangFromText, reassignIntake, routeText } from "@/modules/eingang/service";
import { loadActor } from "@/modules/identity/actor";
import { actorFor, ensureSeed } from "./helpers";

const u = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

async function twoCustomers() {
  process.env.AI_PROVIDER = "test";
  process.env.FEATURE_BESETZUNG = "true";
  resetConfigCacheForTests();
  await ensureSeed();
  const david0 = await actorFor("david");
  const tag = u();
  const a = await createAccount(david0, { name: `Agent Platforms ${tag} AG (fiktiv)`, orgType: "KONZERN", responsibleBdUserId: david0.userId });
  const b = await createAccount(david0, { name: `Kreditbank Nord ${tag} (fiktiv)`, orgType: "KONZERN", responsibleBdUserId: david0.userId });
  const david = (await loadActor(david0.userId))!;
  const sa = await createSetup(david, { accountId: a.id, name: "KI-Plattform", bdUserId: david.userId, creatorContribution: "BD_ZUSTAENDIG" });
  const sb = await createSetup(david, { accountId: b.id, name: "Kernbank-Migration", bdUserId: david.userId, creatorContribution: "BD_ZUSTAENDIG" });
  return { david: (await loadActor(david.userId))!, a, b, sa, sb, tag };
}

describe("Etappe 42: Kunden-Kennungen – Eingänge eindeutig zuordnen", () => {
  it("K01: Kennungen pflegen – Freemail, eigene Domäne und doppelte Vergabe werden abgelehnt", async () => {
    const { david, a, b, tag } = await twoCustomers();
    expect(keyDomainOf("x@gmail.com", new Set())).toBeNull();
    expect(domainMatches("de.kunde.com", "kunde.com")).toBe(true);
    expect(domainMatches("nichtkunde.com", "kunde.com")).toBe(false);
    await expect(setAccountKeys(david, a.id, { domains: "gmail.com" })).rejects.toBeInstanceOf(ValidationError);
    await expect(setAccountKeys(david, a.id, { domains: "verve.example" })).rejects.toBeInstanceOf(ValidationError);
    await expect(setAccountKeys(david, a.id, { domains: "kein domain" })).rejects.toBeInstanceOf(ValidationError);
    const r = await setAccountKeys(david, b.id, { domains: `@KBN-${tag}.example, www.kbn-${tag}.example`, aliases: `KBN${tag}` });
    expect(r.domains).toEqual([`kbn-${tag}.example`]);
    await expect(setAccountKeys(david, a.id, { domains: `kbn-${tag}.example` })).rejects.toBeInstanceOf(ConflictError);
    // Vorschlag aus bekannten Personen
    await createPerson(david, { accountId: a.id, displayName: `Ada Agent ${tag}`, email: `ada@agent-${tag}.example` });
    expect(await suggestedDomains(a.id, david.workspaceId)).toEqual([`agent-${tag}.example`]);
  });

  it("K02: Kennung schlägt Namensähnlichkeit – „Agent Platforms“ im Text ordnet nicht mehr falsch zu", async () => {
    const { david, a, b, sb, tag } = await twoCustomers();
    // ohne Kennung: allgemeine Wörter im Kundennamen zählen nicht
    const plain = await routeText(david, "Wir bauen 2027 unsere Agent Platforms aus und suchen zwei Entwickler.");
    expect(plain.account?.id ?? null).not.toBe(a.id);
    // mit Kennung: Domäne des Absenders entscheidet eindeutig, auch wenn der Name eines anderen Kunden im Text steht
    await setAccountKeys(david, b.id, { domains: `kbn-${tag}.example` });
    const r = await routeText(david, "Thema Agent Platforms: wir brauchen Unterstützung.", [{ name: "Kim Kunde", email: `kim@it.kbn-${tag}.example` }]);
    expect(r.account?.id).toBe(b.id);
    expect(r.byKey).toBe(true);
    expect(r.confident).toBe(true);
    expect(r.ctx?.setup.id).toBe(sb.id);
    expect(r.reason).toMatch(/Kennung: Domäne/);
    // Kürzel
    await setAccountKeys(david, a.id, { aliases: `AP${tag}` });
    const r2 = await routeText(david, `Kurze Info aus dem Termin mit AP${tag} von heute.`);
    expect(r2.account?.id).toBe(a.id);
    expect(r2.byKey).toBe(true);
  });

  it("K03: Falsch zugeordnet → „Anderer Kunde“: neu ausgewertet im richtigen Setup, Domäne wandert als Kennung", async () => {
    const { david, a, b, sb, tag } = await twoCustomers();
    // falsche Kennung bei A sorgt für Fehlzuordnung
    await learnDomain(db, david.workspaceId, a.id, `kbn-${tag}.example`);
    const text = `Hallo Herr Beispiel,\nwir brauchen ab Januar zwei Scrum Master für die Kernbank-Migration. Nächster Schritt: Profile bis Ende des Monats schicken.\nViele Grüße\nKim Kunde\nkim@kbn-${tag}.example`;
    const r = await eingangFromText(david, { text, setupId: "AUTO" });
    expect(r.accountName).toBe(a.name);
    const cards = (await db.query.suggestions.findMany({ where: eq(schema.suggestions.type, "KARTE") })).filter((c) => c.sourceIds.includes(r.sourceId));
    expect(cards.length).toBeGreaterThan(0);
    const re = await reassignIntake(david, cards[0]!.id, sb.id, { learn: true });
    expect(re.accountName).toBe(b.name);
    expect(re.learned).toEqual([`kbn-${tag}.example`]);
    const [accA, accB] = await Promise.all([db.query.accounts.findFirst({ where: eq(schema.accounts.id, a.id) }), db.query.accounts.findFirst({ where: eq(schema.accounts.id, b.id) })]);
    expect(accA!.mailDomains).not.toContain(`kbn-${tag}.example`);
    expect(accB!.mailDomains).toContain(`kbn-${tag}.example`);
    const after = (await db.query.suggestions.findMany({ where: eq(schema.suggestions.type, "KARTE") })).filter((c) => c.sourceIds.includes(r.sourceId));
    expect(after.filter((c) => cards.some((o) => o.id === c.id)).every((c) => c.status === "UEBERHOLT")).toBe(true);
    expect(after.some((c) => c.status === "NEU" && c.setupId === sb.id)).toBe(true);
    // nächste Mail derselben Domäne landet direkt richtig
    expect((await routeText(david, "Kurze Rückfrage.", [{ name: "Kim", email: `kim@kbn-${tag}.example` }])).account?.id).toBe(b.id);
  });
});
