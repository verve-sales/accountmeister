import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { getConfig } from "@/lib/config";
import { getCurrentActor } from "@/modules/identity/session";
import { logoutAction } from "./actions";
import { roleLabel } from "@/lib/labels";

export const metadata: Metadata = { title: "Verve Sales-Arbeitsumgebung (Pilot)", description: "Interne Sales-Arbeitsumgebung – Pilot mit fiktiven Daten" };
export const dynamic = "force-dynamic";

const NAV = [
  { href: "/meine-arbeit", label: "Meine Arbeit" },
  { href: "/kunden", label: "Kunden" },
  { href: "/weeklys", label: "Weeklys" },
  { href: "/ziele", label: "Ziele & Portfolio" },
  { href: "/eingang", label: "Eingang" },
  { href: "/einstellungen", label: "Einstellungen" },
];

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const cfg = getConfig();
  const actor = await getCurrentActor();
  const roles = actor ? [...actor.roles].filter((r) => r !== "ADMIN").map((r) => roleLabel[r] ?? r) : [];
  if (actor && actor.accountRoles.size > 0) roles.push("kundenbezogene Rollen");
  return (
    <html lang="de">
      <body className="min-h-screen">
        {cfg.AUTH_MODE === "development" && (
          <div className="notice-dev" role="status">
            Entwicklungsmodus: Anmeldung ohne Passwort, ausschließlich fiktive Daten. KI-Anbieter: {cfg.AI_PROVIDER === "disabled" ? "deaktiviert" : "Testanbieter"}. Kein Produktivbetrieb.
          </div>
        )}
        <header className="border-b" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
          <div className="mx-auto max-w-6xl px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-2">
            <Link href="/meine-arbeit" className="font-semibold no-underline" style={{ color: "var(--text)" }}>
              Verve Sales
            </Link>
            {actor && (
              <nav aria-label="Hauptnavigation" className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                {NAV.map((n) => (
                  <Link key={n.href} href={n.href}>
                    {n.label}
                  </Link>
                ))}
              </nav>
            )}
            <div className="ml-auto text-sm muted flex items-center gap-3">
              {actor ? (
                <>
                  <span>
                    {actor.displayName} · {roles.join(", ") || "keine Rolle"}
                  </span>
                  <form action={logoutAction}>
                    <button className="btn btn-secondary btn-small" type="submit">
                      Abmelden
                    </button>
                  </form>
                </>
              ) : (
                <Link href="/anmelden">Anmelden</Link>
              )}
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
