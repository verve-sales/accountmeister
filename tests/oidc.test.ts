import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { ForbiddenError } from "@/lib/errors";
import { assertSafeForEnvironment, getConfig, resetConfigCacheForTests } from "@/lib/config";
import { buildAuthorizationUrl, claimsFromPayload, createPendingLogin, resolveOidcUser, type DiscoveryDocument } from "@/modules/identity/oidc";
import { ensureSeed } from "./helpers";

const doc: DiscoveryDocument = {
  issuer: "https://login.microsoftonline.com/tenant-fiktiv/v2.0",
  authorization_endpoint: "https://login.microsoftonline.com/tenant-fiktiv/oauth2/v2.0/authorize",
  token_endpoint: "https://login.microsoftonline.com/tenant-fiktiv/oauth2/v2.0/token",
  jwks_uri: "https://login.microsoftonline.com/tenant-fiktiv/discovery/v2.0/keys",
};

function cfgWith(extra: Record<string, string>) {
  return { ...getConfig(), AUTH_MODE: "oidc" as const, OIDC_ISSUER: doc.issuer, OIDC_CLIENT_ID: "client-fiktiv", OIDC_CLIENT_SECRET: "geheim-fiktiv", OIDC_REDIRECT_URI: "https://sales.example/api/auth/callback", ...extra } as ReturnType<typeof getConfig>;
}

describe("Unternehmensanmeldung (OIDC / Microsoft Entra ID)", () => {
  it("Konfiguration: AUTH_MODE=oidc verlangt Aussteller, Client, Secret und Redirect", () => {
    resetConfigCacheForTests();
    expect(() => assertSafeForEnvironment({ NODE_ENV: "production", AUTH_MODE: "oidc", AI_PROVIDER: "disabled", SESSION_SECRET: "x".repeat(40) })).toThrow(/OIDC_ISSUER/);
    expect(() => assertSafeForEnvironment({ NODE_ENV: "production", AUTH_MODE: "oidc", AI_PROVIDER: "disabled", SESSION_SECRET: "x".repeat(40), OIDC_ISSUER: doc.issuer, OIDC_CLIENT_ID: "a", OIDC_CLIENT_SECRET: "b", OIDC_REDIRECT_URI: "https://sales.example/api/auth/callback" })).not.toThrow();
  });

  it("Autorisierungs-URL enthält PKCE (S256), State und Nonce; nur openid/profile/email", () => {
    const pending = createPendingLogin("/kunden");
    const url = new URL(buildAuthorizationUrl(doc, pending, cfgWith({})));
    expect(url.origin + url.pathname).toBe(doc.authorization_endpoint);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("state")).toBe(pending.state);
    expect(url.searchParams.get("nonce")).toBe(pending.nonce);
    expect(url.searchParams.get("scope")).toBe("openid profile email");
    expect(url.searchParams.get("client_id")).toBe("client-fiktiv");
    expect(pending.returnTo).toBe("/kunden");
    expect(createPendingLogin("https://boese.example").returnTo).toBe("/meine-arbeit");
  });

  it("Claims: Nonce muss passen, E-Mail wird normalisiert, oid vor sub", () => {
    const pending = createPendingLogin();
    expect(() => claimsFromPayload({ sub: "s", nonce: "falsch", email: "a@b.de" }, pending.nonce)).toThrow(ForbiddenError);
    const c = claimsFromPayload({ sub: "sub-1", oid: "oid-1", nonce: pending.nonce, preferred_username: "Ivo.Test@Verve.Example", name: "Ivo Test" }, pending.nonce);
    expect(c).toMatchObject({ subject: "oid-1", email: "ivo.test@verve.example", displayName: "Ivo Test" });
    expect(() => claimsFromPayload({ sub: "s", nonce: pending.nonce }, pending.nonce)).toThrow(/E-Mail/);
  });

  it("Zuordnung: Erst-Admin über ADMIN_EMAILS, bekannte E-Mail wird verknüpft, Unbekannte ohne Freigabe abgelehnt, Rollen nie aus dem Token", async () => {
    const s = await ensureSeed();
    resetConfigCacheForTests();
    // Unbekannt, keine Freigabe → kein Zugang
    await expect(resolveOidcUser({ subject: "oid-fremd", email: "fremd@verve.example", displayName: "Fremd" }, cfgWith({}))).rejects.toBeInstanceOf(ForbiddenError);
    // Erst-Admin
    const r = await resolveOidcUser({ subject: "oid-admin", email: "ivo.seifert@verve.example", displayName: "Ivo Seifert" }, cfgWith({ ADMIN_EMAILS: "Ivo.Seifert@verve.example" }));
    expect(r.created).toBe(true);
    expect(r.madeAdmin).toBe(true);
    const roles = await db.query.roleAssignments.findMany({ where: eq(schema.roleAssignments.userId, r.userId) });
    expect(roles.map((x) => x.role)).toEqual(["ADMIN"]);
    // Zweites Anmelden: gleicher Zugang, keine zweite ADMIN-Rolle
    const r2 = await resolveOidcUser({ subject: "oid-admin", email: "ivo.seifert@verve.example", displayName: "Ivo Seifert" }, cfgWith({ ADMIN_EMAILS: "ivo.seifert@verve.example" }));
    expect(r2.userId).toBe(r.userId);
    expect(r2.created).toBe(false);
    expect(r2.madeAdmin).toBe(false);
    expect((await db.query.roleAssignments.findMany({ where: and(eq(schema.roleAssignments.userId, r.userId), eq(schema.roleAssignments.role, "ADMIN")) })).length).toBe(1);
    // Bekannte Seed-Person (David) wird per E-Mail verknüpft, behält ihre Rollen, bekommt keine neuen
    const david = await db.query.users.findFirst({ where: eq(schema.users.id, s.users.david) });
    const before = await db.query.roleAssignments.findMany({ where: eq(schema.roleAssignments.userId, s.users.david) });
    const rd = await resolveOidcUser({ subject: "oid-david", email: david!.email.toUpperCase(), displayName: "David" }, cfgWith({}));
    expect(rd.userId).toBe(s.users.david);
    expect(rd.created).toBe(false);
    const after = await db.query.roleAssignments.findMany({ where: eq(schema.roleAssignments.userId, s.users.david) });
    expect(after.length).toBe(before.length);
    expect((await db.query.users.findFirst({ where: eq(schema.users.id, s.users.david) }))?.externalSubject).toBe("oid-david");
    // Gleiche E-Mail mit anderer Identität → abgelehnt (kein stilles Umhängen)
    await expect(resolveOidcUser({ subject: "oid-anders", email: david!.email, displayName: "X" }, cfgWith({}))).rejects.toBeInstanceOf(ForbiddenError);
    // Deaktivierter Zugang → abgelehnt
    await db.update(schema.users).set({ status: "INACTIVE" }).where(eq(schema.users.id, s.users.lars));
    const lars = await db.query.users.findFirst({ where: eq(schema.users.id, s.users.lars) });
    await expect(resolveOidcUser({ subject: "oid-lars", email: lars!.email, displayName: "Lars" }, cfgWith({}))).rejects.toThrow(/deaktiviert/);
    await db.update(schema.users).set({ status: "ACTIVE" }).where(eq(schema.users.id, s.users.lars));
    // Automatische Anlage ohne Rolle, wenn ausdrücklich erlaubt
    const ra = await resolveOidcUser({ subject: "oid-neu", email: "neu@verve.example", displayName: "Neu" }, cfgWith({ OIDC_AUTO_CREATE_USERS: "true" }));
    expect(ra.created).toBe(true);
    expect(await db.query.roleAssignments.findMany({ where: eq(schema.roleAssignments.userId, ra.userId) })).toHaveLength(0);
  });
});
