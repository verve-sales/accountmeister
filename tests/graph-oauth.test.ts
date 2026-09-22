import { describe, expect, it, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { resetConfigCacheForTests } from "@/lib/config";
import { decryptRefreshToken, encryptRefreshToken } from "@/modules/integrations/graph/tokenCrypto";
import { buildAuthorizationUrl, createPendingMailConnect, exchangeCodeForGraphTokens, graphOAuthAvailable, graphRedirectUri, graphTenantId, refreshGraphAccessToken } from "@/modules/integrations/graph/oauth";
import { fetchGraphMe, fetchRealSource, listRealSelectable } from "@/modules/integrations/graph/client";
import { AdapterError } from "@/modules/integrations/adapter";
import { beginMailboxConnect, completeMailboxConnect, connectMailbox, getMyConnection } from "@/modules/integrations/service";
import { actorFor, ensureSeed } from "./helpers";

/**
 * Etappe 18 Fortsetzung: echte Microsoft-Graph-Anbindung (Entscheidung E-018, seit Pilotfreigabe erlaubt).
 * Die App-Registrierung selbst kann in Tests nicht angesprochen werden – alle HTTP-Aufrufe an Microsoft und
 * an Graph werden deshalb über die vorgesehenen `fetchImpl`-Parameter bzw. `global.fetch` durch Fixtures ersetzt.
 */

const OIDC_ENV = {
  AUTH_MODE: "oidc",
  OIDC_ISSUER: "https://login.microsoftonline.com/tenant-fiktiv/v2.0",
  OIDC_CLIENT_ID: "client-fiktiv",
  OIDC_CLIENT_SECRET: "geheim-fiktiv",
  OIDC_REDIRECT_URI: "https://accountmeister.example/api/auth/callback",
};

async function withOidcEnv<T>(fn: () => T | Promise<T>): Promise<T> {
  const before = { ...process.env };
  Object.assign(process.env, OIDC_ENV);
  resetConfigCacheForTests();
  try {
    return await fn();
  } finally {
    process.env = before;
    resetConfigCacheForTests();
  }
}

describe("Token-Verschlüsselung (Refresh-Token, AES-256-GCM aus SESSION_SECRET)", () => {
  it("verschlüsselt und entschlüsselt verlustfrei; manipulierte Werte werden abgelehnt", () => {
    const blob = encryptRefreshToken("mein-geheimes-refresh-token");
    expect(blob).not.toContain("mein-geheimes-refresh-token");
    expect(decryptRefreshToken(blob)).toBe("mein-geheimes-refresh-token");
    const tampered = blob.slice(0, -4) + "abcd";
    expect(() => decryptRefreshToken(tampered)).toThrow();
    expect(() => decryptRefreshToken("unsinn")).toThrow();
  });
});

describe("Microsoft-Graph-OAuth (Autorisierungs-URL, Mandant, Redirect)", () => {
  it("Mandant wird aus OIDC_ISSUER erkannt; ohne Konfiguration ist nichts verfügbar", () => {
    expect(graphTenantId({ OIDC_ISSUER: "https://login.microsoftonline.com/abc-123/v2.0" } as ReturnType<typeof import("@/lib/config").getConfig>)).toBe("abc-123");
    expect(graphTenantId({} as ReturnType<typeof import("@/lib/config").getConfig>)).toBeNull();
    expect(graphOAuthAvailable({} as ReturnType<typeof import("@/lib/config").getConfig>)).toBe(false);
  });

  it("graphOAuthAvailable/graphRedirectUri: erst vollständig, wenn Aussteller, Client, Secret und Redirect gesetzt sind", async () => {
    await withOidcEnv(() => {
      expect(graphOAuthAvailable()).toBe(true);
      expect(graphRedirectUri()).toBe("https://accountmeister.example/api/integrations/microsoft/callback");
    });
  });

  it("Autorisierungs-URL enthält PKCE (S256), State, die Graph-Scopes (nur lesend) und die zweite Umleitungs-URI", async () => {
    await withOidcEnv(() => {
      const pending = createPendingMailConnect();
      const redirectUri = graphRedirectUri()!;
      const url = new URL(buildAuthorizationUrl(redirectUri, pending));
      expect(url.hostname).toBe("login.microsoftonline.com");
      expect(url.pathname).toBe("/tenant-fiktiv/oauth2/v2.0/authorize");
      expect(url.searchParams.get("redirect_uri")).toBe(redirectUri);
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("state")).toBe(pending.state);
      const scope = url.searchParams.get("scope") ?? "";
      expect(scope).toContain("Mail.Read");
      expect(scope).toContain("Calendars.Read");
      expect(scope).not.toContain("Mail.ReadWrite");
      expect(scope).not.toContain("Send");
    });
  });

  it("Code-Tausch und Refresh: reichen Client-Zugangsdaten und Verifier korrekt durch; Fehlerantwort wirft", async () => {
    await withOidcEnv(async () => {
      const redirectUri = graphRedirectUri()!;
      const calls: { url: string; body: string }[] = [];
      const okFetch = (async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), body: String(init?.body) });
        return new Response(JSON.stringify({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, scope: "Mail.Read Calendars.Read" }), { status: 200 });
      }) as typeof fetch;
      const tokens = await exchangeCodeForGraphTokens(redirectUri, "code-123", "verifier-123", undefined, okFetch);
      expect(tokens.access_token).toBe("at-1");
      expect(tokens.refresh_token).toBe("rt-1");
      expect(calls[0]!.url).toContain("/tenant-fiktiv/oauth2/v2.0/token");
      expect(calls[0]!.body).toContain("code_verifier=verifier-123");

      const failFetch = (async () => new Response("nein", { status: 400 })) as typeof fetch;
      await expect(exchangeCodeForGraphTokens(redirectUri, "x", "y", undefined, failFetch)).rejects.toThrow();

      const rotatingFetch = (async () => new Response(JSON.stringify({ access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 }), { status: 200 })) as typeof fetch;
      const refreshed = await refreshGraphAccessToken("rt-1", undefined, rotatingFetch);
      expect(refreshed.access_token).toBe("at-2");
      expect(refreshed.refresh_token).toBe("rt-2");

      const nonRotatingFetch = (async () => new Response(JSON.stringify({ access_token: "at-3", expires_in: 3600 }), { status: 200 })) as typeof fetch;
      const kept = await refreshGraphAccessToken("rt-1", undefined, nonRotatingFetch);
      expect(kept.refresh_token).toBe("rt-1"); // kein neues Refresh-Token geliefert → altes bleibt gültig
    });
  });
});

describe("Graph-Client (echte, ausschließlich lesende Aufrufe)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("listRealSelectable bildet Mails und Termine auf SelectableItem ab; 401 wird als AUTH-Fehler erkannt", async () => {
    const mailFetch = (async () =>
      new Response(
        JSON.stringify({ value: [{ id: "m1", subject: "Re: Kapazitäten", from: { emailAddress: { name: "Keller, Anne", address: "keller@beispiel.example" } }, toRecipients: [], receivedDateTime: "2026-09-20T08:00:00Z", bodyPreview: "Kurzer Auszug", hasAttachments: false }] }),
        { status: 200 },
      )) as typeof fetch;
    const items = await listRealSelectable("at-gueltig", "MAIL", undefined, 10, mailFetch);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "MAIL", externalId: "m1", subject: "Re: Kapazitäten", from: { name: "Keller, Anne", email: "keller@beispiel.example" } });

    const authFail = (async () => new Response("", { status: 401 })) as typeof fetch;
    await expect(listRealSelectable("abgelaufen", "MAIL", undefined, 10, authFail)).rejects.toMatchObject({ kind: "AUTH" });
    await expect(listRealSelectable("abgelaufen", "MAIL", undefined, 10, authFail)).rejects.toBeInstanceOf(AdapterError);
  });

  it("fetchRealSource liefert Volltext und einen stabilen Inhalts-Hash für die Änderungserkennung", async () => {
    const eventFetch = (async () =>
      new Response(
        JSON.stringify({ id: "e1", subject: "Abstimmung", organizer: { emailAddress: { name: "Brandt, Julia" } }, attendees: [], start: { dateTime: "2026-09-24T09:00:00Z" }, body: { content: "Einladungstext" }, responseStatus: { response: "accepted" } }),
        { status: 200 },
      )) as typeof fetch;
    const source = await fetchRealSource("at-gueltig", "TERMIN", "e1", eventFetch);
    expect(source.bodyText).toBe("Einladungstext");
    expect(source.meetingAcceptedByUser).toBe(true);
    expect(source.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("fetchGraphMe liefert die Postfachkennung für den Verbindungsstatus", async () => {
    const meFetch = (async () => new Response(JSON.stringify({ displayName: "David Demo", mail: "david.demo@verve.example" }), { status: 200 })) as typeof fetch;
    const me = await fetchGraphMe("at-gueltig", meFetch);
    expect(me.mail).toBe("david.demo@verve.example");
  });
});

describe("Echter Verbindungsaufbau über den Service (zweistufig, Callback trennt Autorisierung und Speicherung)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("beginMailboxConnect verlangt eine fachliche Rolle und eine konfigurierte App-Registrierung", async () => {
    const s = await ensureSeed();
    const david = await actorFor("david");
    // Ohne OIDC-Konfiguration (Standard-Testumgebung): ehrlich abgewiesen, nicht stillschweigend Fixtures.
    await expect(beginMailboxConnect(david)).rejects.toMatchObject({ code: "ADAPTER_NOT_CONFIGURED" });
    void s;
  });

  it("beginMailboxConnect liefert eine Autorisierungs-URL, wenn die App-Registrierung vorhanden ist; completeMailboxConnect tauscht Code gegen Tokens und legt eine echte Verbindung an", async () => {
    await withOidcEnv(async () => {
      const david = await actorFor("david");
      const { authorizationUrl, pending } = await beginMailboxConnect(david);
      expect(new URL(authorizationUrl).hostname).toBe("login.microsoftonline.com");
      expect(pending.state).toBeTruthy();

      let call = 0;
      vi.stubGlobal("fetch", vi.fn(async (url: string) => {
        call += 1;
        if (String(url).includes("/oauth2/v2.0/token")) {
          return new Response(JSON.stringify({ access_token: "at-echt", refresh_token: "rt-echt", expires_in: 3600, scope: "Mail.Read Calendars.Read User.Read offline_access" }), { status: 200 });
        }
        if (String(url).includes("graph.microsoft.com/v1.0/me")) {
          return new Response(JSON.stringify({ mail: "david.demo@verve.example", displayName: "David Demo" }), { status: 200 });
        }
        throw new Error("Unerwarteter Aufruf: " + url);
      }));

      const row = await completeMailboxConnect(david, "code-echt", pending.verifier);
      expect(call).toBeGreaterThanOrEqual(2);
      expect(row?.fixtureMode).toBe(false);
      expect(row?.status).toBe("VERBUNDEN");
      expect(row?.accountLabel).toBe("david.demo@verve.example");
      expect(row?.tokenRef).not.toBe("rt-echt"); // nie der Klartext-Token in der Spalte
      expect(row?.tokenRef ? decryptRefreshToken(row.tokenRef) : null).toBe("rt-echt");

      const mine = await getMyConnection(david);
      expect(mine.state.fixtureMode).toBe(false);
      expect(mine.state.connected).toBe(true);

      // Aufräumen für andere Tests, die vom Fixture-Zustand ausgehen
      await db.update(schema.integrationConnections).set({ status: "WIDERRUFEN", tokenRef: null }).where(eq(schema.integrationConnections.userId, david.userId));
    });
  });
});

describe("Bestehendes Verhalten bleibt unverändert (Fixture-Modus, ehrliche Abweisung ohne Konfiguration)", () => {
  it("connectMailbox(fixture:true) funktioniert weiterhin unverändert", async () => {
    await ensureSeed();
    const david = await actorFor("david");
    const conn = await connectMailbox(david, { fixture: true });
    expect(conn?.fixtureMode).toBe(true);
    await db.update(schema.integrationConnections).set({ status: "WIDERRUFEN", tokenRef: null }).where(eq(schema.integrationConnections.userId, david.userId));
  });
});
