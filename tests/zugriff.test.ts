import { describe, expect, it } from "vitest";
import { NotFoundError, ForbiddenError } from "@/lib/errors";
import { getSetupDetail, createSetup } from "@/modules/setups/service";
import { getSource } from "@/modules/knowledge/service";
import { getAccount, listVisibleAccounts } from "@/modules/accounts/service";
import { takeOverSignal } from "@/modules/signals/service";
import { assertSafeForEnvironment, normalizeEnv } from "@/lib/config";
import { actorFor, ensureSeed } from "./helpers";

describe("Zugriff (Briefing 16.2, S01/S02/S09)", () => {
  it("S01: direkter Aufruf fremder Objekt-IDs wird verweigert – ohne Metadatenleckage", async () => {
    const s = await ensureSeed();
    const lars = await actorFor("lars"); // BD für einen anderen Kunden
    await expect(getSetupDetail(lars, s.setupId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getAccount(lars, s.accountId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getSource(lars, s.privateSourceId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(takeOverSignal(lars, s.signalId, 1)).rejects.toBeInstanceOf(NotFoundError);
    const visible = await listVisibleAccounts(lars);
    expect(visible.map((a) => a.id)).not.toContain(s.accountId);
    expect(visible.map((a) => a.id)).toContain(s.otherAccountId);
  });

  it("S02: CEO sieht Setup-Zusammenfassung, aber keine Rohquellen durch den Führungstitel", async () => {
    const s = await ensureSeed();
    const ceo = await actorFor("clemens");
    const detail = await getSetupDetail(ceo, s.setupId);
    expect(detail.setup.id).toBe(s.setupId);
    expect(detail.sources).toHaveLength(0);
    expect(detail.hiddenSourceCount).toBeGreaterThan(0);
    await expect(getSource(ceo, s.privateSourceId)).rejects.toBeInstanceOf(NotFoundError);
    expect(detail.canEdit).toBe(false);
  });

  it("Persönliche Quelle: nur der Quelleninhaber, nicht die Setup-Kollegin", async () => {
    const s = await ensureSeed();
    const david = await actorFor("david");
    const nina = await actorFor("nina");
    const own = await getSource(david, s.privateSourceId);
    expect(own.source.accessClass).toBe("PERSOENLICH");
    await expect(getSource(nina, s.privateSourceId)).rejects.toBeInstanceOf(NotFoundError);
    // Ninas Setup-Sicht enthält die persönliche Quelle Davids nicht, wohl aber die Setup-Notiz
    const detail = await getSetupDetail(nina, s.setupId);
    expect(detail.sources.some((x) => x.id === s.privateSourceId)).toBe(false);
    expect(detail.sources.some((x) => x.accessClass === "SETUP")).toBe(true);
  });

  it("ADMIN (Betrieb) hat keinen automatischen Inhaltszugriff", async () => {
    const s = await ensureSeed();
    const admin = await actorFor("admin");
    await expect(getSetupDetail(admin, s.setupId)).rejects.toBeInstanceOf(NotFoundError);
    expect(await listVisibleAccounts(admin)).toHaveLength(0);
    await expect(createSetup(admin, { accountId: s.accountId, name: "Admin-Setup", bdUserId: "" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("Anker ohne Account-Bezug kann für fremde Kunden kein Setup anlegen", async () => {
    const s = await ensureSeed();
    const nina = await actorFor("nina");
    await expect(createSetup(nina, { accountId: s.otherAccountId, name: "Fremdkunde", bdUserId: "" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("Etappe 24: Principal (arbeitsraumweit) darf Setups sehen und bearbeiten – ein fremder BD weiterhin nicht", async () => {
    const s = await ensureSeed();
    const petra = await actorFor("petra");
    const lars = await actorFor("lars");
    const detail = await getSetupDetail(petra, s.setupId);
    expect(detail.canEdit).toBe(true);
    await expect(takeOverSignal(lars, s.signalId, 1)).rejects.toThrow();
    const taken = await takeOverSignal(petra, s.signalId, 1);
    expect(taken.ownerUserId).toBe(petra.userId);
  });

  it("S09: Produktion mit Entwicklungsanmeldung oder Test-KI wird verhindert", () => {
    const base = { NODE_ENV: "production" as const, SESSION_SECRET: "x".repeat(40), OIDC_ISSUER: "https://login.microsoftonline.com/t/v2.0", OIDC_CLIENT_ID: "c", OIDC_CLIENT_SECRET: "s", OIDC_REDIRECT_URI: "https://sales.example/api/auth/callback" };
    expect(() => assertSafeForEnvironment({ ...base, AUTH_MODE: "development", AI_PROVIDER: "disabled" })).toThrow(/AUTH_MODE/);
    expect(() => assertSafeForEnvironment({ ...base, AUTH_MODE: "oidc", AI_PROVIDER: "test" })).toThrow(/AI_PROVIDER/);
    expect(() => assertSafeForEnvironment({ ...base, AUTH_MODE: "oidc", AI_PROVIDER: "disabled", SESSION_SECRET: "entwicklung-nur-lokal-bitte-ersetzen-0123456789abcdef" })).toThrow(/SESSION_SECRET/);
    expect(() => assertSafeForEnvironment({ ...base, AUTH_MODE: "oidc", AI_PROVIDER: "disabled" })).not.toThrow();
    // OIDC ohne Anbieterdaten: auch außerhalb Produktion abgelehnt (statt stiller Fehlfunktion)
    expect(() => assertSafeForEnvironment({ NODE_ENV: "development", AUTH_MODE: "oidc", AI_PROVIDER: "disabled", SESSION_SECRET: "x".repeat(40) })).toThrow(/OIDC_ISSUER/);
    expect(() => assertSafeForEnvironment({ NODE_ENV: "development", AUTH_MODE: "development", AI_PROVIDER: "test", SESSION_SECRET: "entwicklung-x".padEnd(40, "0") })).not.toThrow();
    // Langdock ohne Schlüssel wird abgelehnt; leere Werte aus Compose (`LANGDOCK_API_KEY=`) gelten als nicht gesetzt
    expect(() => assertSafeForEnvironment({ ...base, AUTH_MODE: "oidc", AI_PROVIDER: "langdock" })).toThrow(/LANGDOCK_API_KEY/);
    expect(normalizeEnv({ A: "", B: "  ", C: "wert", D: undefined })).toEqual({ C: "wert" });
  });
});
