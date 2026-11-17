import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import "./globals.css";
import { getConfig } from "@/lib/config";
import { getCurrentActor } from "@/modules/identity/session";
import { cookies } from "next/headers";
import { logoutAction, setHatAction } from "./actions";
import { loadHat, viewLabel, viewDescription } from "@/modules/dashboard/service";
import { splitNav } from "@/modules/dashboard/hat";
import { canSetTargets } from "@/modules/principals/service";
import { canSeeRound } from "@/modules/rounds/service";
import { roleLabel } from "@/lib/labels";
import { AssistantPanel } from "@/components/AssistantPanel";
import { provisionAccess } from "@/modules/provision/access";
import { canBrowsePortfolio } from "@/modules/portfolio/service";
import { unreadCount } from "@/modules/notifications/service";
import { CloseMenus } from "@/components/CloseMenus";
import { AppChrome } from "@/components/AppChrome";
import { canUseAssignments } from "@/modules/assignments/service";
import type { Actor } from "@/modules/identity/actor";

/** Navigationseintrag „Besetzung“ für BD, Principal, CEO und Sales Operations (keine Sicherheitsgrenze – die liegt in den Services). */
function staffingNav(actor: Actor): boolean {
  const roles = new Set<string>(actor.roles);
  for (const set of actor.accountRoles.values()) for (const r of set) roles.add(r);
  return ["BD", "PRINCIPAL", "CEO", "SALES_OPS"].some((r) => roles.has(r));
}

/** Coach liest Einsätze mit, aber keine Besetzungs-Pipeline. */
function coachNav(actor: Actor): boolean {
  if (actor.roles.has("COACH")) return true;
  for (const set of actor.accountRoles.values()) if (set.has("COACH")) return true;
  return false;
}

export const metadata: Metadata = { title: "Accountmeister – Verve AI", description: "Interne Sales-Arbeitsumgebung von Verve Consulting", icons: { icon: "/verve-ai-lockup.png" } };
import { canUseSalesOps } from "@/modules/salesops/service";
import { canClean } from "@/modules/cleanup/service";

export const dynamic = "force-dynamic";

/** Weitere Bereiche – immer unter „Mehr“. Die erste Reihe folgt dem Hut (Etappe 37, modules/dashboard/hat.ts). */
const MORE = [
  { href: "/vorgehen", label: "Vorgehen" },
  { href: "/einstellungen", label: "Einstellungen" },
  { href: "/hilfe", label: "Hilfe" },
];

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const cfg = getConfig();
  const actor = await getCurrentActor();
  const roles = actor ? [...actor.roles].filter((r) => r !== "ADMIN").map((r) => roleLabel[r] ?? r) : [];
  if (actor && actor.accountRoles.size > 0) roles.push("kundenbezogene Rollen");
  const { hat, available } = actor ? await loadHat(actor, (await cookies()).get("am_sicht")?.value ?? null).catch(() => ({ hat: null, available: [] })) : { hat: null, available: [] };
  const staffing = cfg.FEATURE_BESETZUNG === "true";
  const allowed = new Set<string>(["start", "kunden", "ziele"]);
  if (actor && canBrowsePortfolio(actor)) allowed.add("bds");
  if (actor && canSetTargets(actor)) allowed.add("principals");
  if (actor && canSeeRound(actor)) allowed.add("runde");
  if (actor && staffing && (staffingNav(actor) || coachNav(actor))) allowed.add("einsaetze");
  if (actor && staffing && staffingNav(actor)) allowed.add("besetzung");
  if (actor && staffing && canUseSalesOps(actor)) allowed.add("salesops");
  if (actor && canClean(actor)) allowed.add("bereinigung");
  const nav = splitNav(hat, allowed);
  const unread = actor ? await unreadCount(actor).catch(() => 0) : 0;
  // Moco (Etappe 31): Link für Importberechtigte, wenn die Anbindung an ist, oder bei offenen Hinweisen für die Person
  const mocoLink = actor && cfg.MOCO_MODE !== "off" && (actor.roles.has("CEO") || actor.roles.has("PRINCIPAL") || (await (await import("@/modules/moco/sync")).openHintCount(actor).catch(() => 0)) > 0);
  const asgAllowed = actor ? await canUseAssignments(actor).catch(() => false) : false;
  const initialApp = (await cookies()).get("vm_app")?.value === "asg" && asgAllowed ? "asg" : "am";
  const switcher = asgAllowed ? (
    <div className="app-switch" role="group" aria-label="Anwendung wechseln">
      <Link href="/start" data-app-link="am">Accountmeister</Link>
      <Link href="/assignments" data-app-link="asg">Assignmentmanager</Link>
    </div>
  ) : null;
  const rightSide = (
            <div className="ml-auto text-sm muted flex flex-wrap items-center gap-3">
              {actor ? (
                <>
                  <form method="get" action="/suche" role="search" className="flex items-center">
                    <input name="q" className="input" placeholder="Suchen: Kunde, Person, Einsatz …" aria-label="Suchen" style={{ minWidth: 220, padding: "2px 8px", fontSize: 13 }} />
                  </form>
                  <Link href="/benachrichtigungen" className="no-underline" aria-label={unread ? `Benachrichtigungen: ${unread} ungelesen` : "Benachrichtigungen"} title="Benachrichtigungen" style={{ color: "var(--text)", position: "relative", display: "inline-flex", alignItems: "center" }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
                      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
                    </svg>
                    {unread > 0 && (
                      <span style={{ position: "absolute", top: -6, right: -10, background: "#c0392b", color: "#fff", borderRadius: 999, fontSize: 10, lineHeight: "15px", minWidth: 15, padding: "0 4px", textAlign: "center", fontWeight: 700 }}>{unread > 99 ? "99+" : unread}</span>
                    )}
                  </Link>
                  {hat && available.length > 1 ? (
                    <details className="nav-more nav-hat" aria-label="Hut wechseln">
                      <summary title="Ich arbeite gerade als … – bestimmt Navigation und Startseite, nicht deine Rechte">
                        {actor.displayName} · <strong style={{ color: "var(--text)" }}>als {viewLabel[hat]}</strong> ▾
                      </summary>
                      <form action={setHatAction} className="nav-more-menu" style={{ minWidth: 260 }}>
                        <span className="muted text-xs" style={{ padding: "4px 8px" }}>Ich arbeite als:</span>
                        {available.map((v) => (
                          <button key={v} name="hat" value={v} type="submit" className={v === hat ? "btn btn-small" : "btn btn-secondary btn-small"} aria-pressed={v === hat} title={viewDescription[v]} style={{ textAlign: "left" }}>
                            {viewLabel[v]}
                          </button>
                        ))}
                      </form>
                    </details>
                  ) : (
                    <span>
                      {actor.displayName} · {roles.join(", ") || "keine Rolle"}
                    </span>
                  )}
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
  );
  const amHeader = (
        <header className="border-b" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
          <div className="mx-auto max-w-6xl px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-2">
            <Link href="/start" className="no-underline flex items-center gap-3" style={{ color: "var(--text)" }} aria-label="Verve AI – Accountmeister, zur Startseite">
              {/* Logo: public/verve-ai-lockup.png (Verve AI Lockup); Höhe 32px, Breite folgt dem Seitenverhältnis 815:200 */}
              <Image src="/verve-ai-lockup.png" alt="Verve AI" width={130} height={32} priority style={{ height: 32, width: "auto" }} />
              <span className="font-semibold">Accountmeister</span>
            </Link>
            {actor && (
              <nav aria-label="Hauptnavigation" className="flex flex-wrap gap-x-4 gap-y-1 text-sm items-center">
                {nav.main.map((n) => (
                  <Link key={n.href} href={n.href}>
                    {n.label}
                  </Link>
                ))}
                <details className="nav-more">
                  <summary>Mehr ▾</summary>
                  <div className="nav-more-menu">
                    {[...nav.more, ...MORE.slice(0, 1), ...(cfg.FEATURE_ARTEFAKTE === "true" ? [{ href: "/artefakte", label: "Artefakte" }] : []), ...(mocoLink ? [{ href: "/moco", label: "Moco" }] : []), ...(provisionAccess(actor).allowed ? [{ href: "/provision", label: "Provisionsrechner" }] : []), ...(actor.roles.has("ADMIN") ? [{ href: "/verwaltung", label: "Verwaltung" }] : []), ...MORE.slice(1)].map((n) => (
                      <Link key={n.href} href={n.href}>
                        {n.label}
                      </Link>
                    ))}
                  </div>
                </details>
              </nav>
            )}
            {switcher}
            {rightSide}
          </div>
        </header>
  );
  const asgHeader = asgAllowed && actor ? (
    <header className="border-b" style={{ borderColor: "var(--border)", background: "var(--surface)", borderTop: "3px solid var(--accent)" }}>
      <div className="mx-auto max-w-6xl px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-2">
        <Link href="/assignments" className="no-underline flex items-center gap-3" style={{ color: "var(--text)" }} aria-label="Verve AI – Assignmentmanager, zur Übersicht">
          <Image src="/verve-ai-lockup.png" alt="Verve AI" width={130} height={32} priority style={{ height: 32, width: "auto" }} />
          <span className="font-semibold">Assignmentmanager</span>
        </Link>
        <nav aria-label="Hauptnavigation" className="flex flex-wrap gap-x-4 gap-y-1 text-sm items-center">
          <Link href="/assignments">Übersicht</Link>
          <Link href="/assignments/konditionen">Laufzeiten &amp; Konditionen</Link>
          <Link href="/assignments/checkins">Check-ins</Link>
          <Link href="/uebergaben">Übergaben</Link>
          <details className="nav-more">
            <summary>Mehr ▾</summary>
            <div className="nav-more-menu">
              <Link href="/vertragsbuero#erfassen">Assignment erfassen</Link>
              {cfg.MOCO_MODE !== "off" && <Link href="/moco">Moco</Link>}
              {(actor.roles.has("CEO") || actor.roles.has("ADMIN")) && <Link href="/verwaltung/sharepoint">SharePoint-Ablage</Link>}
              <Link href="/einstellungen">Einstellungen</Link>
              <Link href="/hilfe">Hilfe</Link>
            </div>
          </details>
        </nav>
        {switcher}
        {rightSide}
      </div>
    </header>
  ) : null;
  return (
    <html lang="de">
      <body className="min-h-screen">
        <CloseMenus />
        {cfg.AUTH_MODE === "development" && (
          <div className="notice-dev" role="status">
            Entwicklungsmodus: Anmeldung ohne Passwort, ausschließlich fiktive Daten. KI-Anbieter: {cfg.AI_PROVIDER === "disabled" ? "deaktiviert" : "Testanbieter"}. Kein Produktivbetrieb.
          </div>
        )}
        <AppChrome initial={initialApp} am={amHeader} asg={asgHeader}>
          <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
          {actor ? <AssistantPanel signedIn /> : null}
        </AppChrome>
      </body>
    </html>
  );
}
