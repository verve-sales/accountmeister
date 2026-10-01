import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import "./globals.css";
import { getConfig } from "@/lib/config";
import { getCurrentActor } from "@/modules/identity/session";
import { logoutAction } from "./actions";
import { roleLabel } from "@/lib/labels";
import { AssistantPanel } from "@/components/AssistantPanel";
import { provisionAccess } from "@/modules/provision/access";
import { unreadCount } from "@/modules/notifications/service";
import type { Actor } from "@/modules/identity/actor";

/** Navigationseintrag „Besetzung“ für BD, Principal, CEO und Sales Operations (keine Sicherheitsgrenze – die liegt in den Services). */
function staffingNav(actor: Actor): boolean {
  const roles = new Set<string>(actor.roles);
  for (const set of actor.accountRoles.values()) for (const r of set) roles.add(r);
  return ["BD", "PRINCIPAL", "CEO", "SALES_OPS"].some((r) => roles.has(r));
}

export const metadata: Metadata = { title: "Accountmeister – Verve AI", description: "Interne Sales-Arbeitsumgebung von Verve Consulting", icons: { icon: "/verve-ai-lockup.png" } };
export const dynamic = "force-dynamic";

const NAV = [
  { href: "/start", label: "Start" },
  { href: "/meine-arbeit", label: "Meine Arbeit" },
  { href: "/kunden", label: "Kunden" },
  { href: "/weeklys", label: "Weeklys" },
  { href: "/ziele", label: "Ziele & Portfolio" },
];

/** Weitere Bereiche – erreichbar, aber nicht in der ersten Reihe (E-043: fünf Einträge in der Hauptnavigation). */
const MORE = [
  { href: "/eingang", label: "Eingang" },
  { href: "/vorgehen", label: "Vorgehen" },
  { href: "/artefakte", label: "Artefakte" },
  { href: "/einstellungen", label: "Einstellungen" },
  { href: "/hilfe", label: "Hilfe" },
];

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const cfg = getConfig();
  const actor = await getCurrentActor();
  const roles = actor ? [...actor.roles].filter((r) => r !== "ADMIN").map((r) => roleLabel[r] ?? r) : [];
  if (actor && actor.accountRoles.size > 0) roles.push("kundenbezogene Rollen");
  const unread = actor ? await unreadCount(actor).catch(() => 0) : 0;
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
            <Link href="/start" className="no-underline flex items-center gap-3" style={{ color: "var(--text)" }} aria-label="Verve AI – Accountmeister, zur Startseite">
              {/* Logo: public/verve-ai-lockup.png (Verve AI Lockup); Höhe 32px, Breite folgt dem Seitenverhältnis 815:200 */}
              <Image src="/verve-ai-lockup.png" alt="Verve AI" width={130} height={32} priority style={{ height: 32, width: "auto" }} />
              <span className="font-semibold">Accountmeister</span>
            </Link>
            {actor && (
              <nav aria-label="Hauptnavigation" className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                {[...NAV, ...(actor?.roles.has("CEO") ? [{ href: "/ceo", label: "CEO-Dashboard" }] : []), ...(actor?.roles.has("ADMIN") ? [{ href: "/verwaltung", label: "Verwaltung" }] : [])].map((n) => (
                  <Link key={n.href} href={n.href}>
                    {n.label}
                  </Link>
                ))}
              </nav>
            )}
            <div className="ml-auto text-sm muted flex flex-wrap items-center gap-3">
              {actor ? (
                <>
                  <nav aria-label="Weitere Bereiche" className="flex flex-wrap gap-x-3 text-xs">
                    {[...(cfg.FEATURE_BESETZUNG === "true" && staffingNav(actor) ? [{ href: "/besetzung", label: "Besetzung" }] : []), ...MORE.slice(0, 3), ...(actor && provisionAccess(actor).allowed ? [{ href: "/provision", label: "Provisionsrechner" }] : []), ...MORE.slice(3)].map((n) => (
                      <Link key={n.href} href={n.href} className="muted">
                        {n.label}
                      </Link>
                    ))}
                  </nav>
                  <Link href="/benachrichtigungen" className="no-underline" aria-label={unread ? `Benachrichtigungen: ${unread} ungelesen` : "Benachrichtigungen"} title="Benachrichtigungen" style={{ color: "var(--text)", position: "relative", display: "inline-flex", alignItems: "center" }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
                      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
                    </svg>
                    {unread > 0 && (
                      <span style={{ position: "absolute", top: -6, right: -10, background: "#c0392b", color: "#fff", borderRadius: 999, fontSize: 10, lineHeight: "15px", minWidth: 15, padding: "0 4px", textAlign: "center", fontWeight: 700 }}>{unread > 99 ? "99+" : unread}</span>
                    )}
                  </Link>
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
        {actor ? <AssistantPanel signedIn /> : null}
      </body>
    </html>
  );
}
