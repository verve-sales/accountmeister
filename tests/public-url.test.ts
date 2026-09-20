import { describe, expect, it } from "vitest";
import { resetConfigCacheForTests } from "@/lib/config";
import { publicUrl } from "@/lib/public-url";

describe("Öffentliche Adresse für Weiterleitungen hinter dem Proxy", () => {
  it("nimmt den Ursprung aus OIDC_REDIRECT_URI, sonst Forwarded-Header, sonst die Anfrage", () => {
    const req = (headers: Record<string, string>) => new Request("http://localhost:3000/api/auth/callback?code=x", { headers });
    process.env.OIDC_REDIRECT_URI = "https://accountmeister.verveconsulting.ai/api/auth/callback";
    resetConfigCacheForTests();
    expect(publicUrl("/meine-arbeit?ok=1", req({})).toString()).toBe("https://accountmeister.verveconsulting.ai/meine-arbeit?ok=1");
    delete process.env.OIDC_REDIRECT_URI;
    resetConfigCacheForTests();
    expect(publicUrl("/anmelden", req({ "x-forwarded-host": "app.example", "x-forwarded-proto": "https" })).toString()).toBe("https://app.example/anmelden");
    expect(publicUrl("/anmelden", req({ host: "localhost:3000" })).toString()).toBe("http://localhost:3000/anmelden");
  });
});
