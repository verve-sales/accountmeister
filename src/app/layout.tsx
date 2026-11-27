import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import "./globals.css";
import { getConfig } from "@/lib/config";
import { getCurrentActor } from "@/modules/identity/session";
import { cookies } from "next/headers";
import { logoutAction, setHatAction } from "./actions";
import { loadHat, viewLabel, viewDescription } from "@/modules/dashboard/service";
import { ALL_LINKS } from "@/modules/dashboard/hat";
import { canSetTargets } from "@/modules/principals/service";
import { canSeeRound } from "@/modules/rounds/service";
import { roleLabel } from "@/lib/labels";
import { AssistantButton, AssistantPanel } from "@/components/AssistantPanel";
import { provisionAccess } from "@/modules/provision/access";
import { canBrowsePortfolio } from "@/modules/portfolio/service";
import { unreadCount } from "@/modules/notifications/service";
import { CloseMenus } from "@/components/CloseMenus";
import { AppShell, type NavItem, type NavSection } from "@/components/AppShell";
import { SearchBox } from "@/components/SearchBox";
import { NotificationBell } from "@/components/NotificationBell";
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
  const unread = actor ? await unreadCount(actor).catch(() => 0) : 0;
  // Moco (Etappe 31): Link für Importberechtigte, wenn die Anbindung an ist, oder bei offenen Hinweisen für die Person
  const mocoLink = actor && cfg.MOCO_MODE !== "off" && (actor.roles.has("CEO") || actor.roles.has("PRINCIPAL") || (await (await import("@/modules/moco/sync")).openHintCount(actor).catch(() => 0)) > 0);
  const asgAllowed = actor ? await canUseAssignments(actor).catch(() => false) : false;
  // e67: Auftragseingang (Angebot und Bestellung hochladen) – BD, Principal, Sales Operations, Backoffice, GF
  const { canUseOrderIntake, intakeCounts } = await import("@/modules/o2o/service");
  const intakeAllowed = actor && staffing ? await canUseOrderIntake(actor).catch(() => false) : false;
  const intake = intakeAllowed && actor ? await intakeCounts(actor).catch(() => ({ drafts: 0, open: 0 })) : { drafts: 0, open: 0 };
  // e64: eine Oberfläche – Seitenleiste mit Bereichen (Accountmeister und Assignmentmanager), dieselben Ziele wie zuvor
  const L = (key: string, icon: string): NavItem | null => (allowed.has(key) ? { ...ALL_LINKS[key]!, icon } : null);
  // e66: sieben Bereiche statt bis zu 24 Menüpunkten – die Seiten eines Bereichs erscheinen als Reiter über dem Inhalt (alle Adressen bleiben)
  const only = (xs: Array<NavItem | null>) => xs.filter((x): x is NavItem => !!x);
  const sections: NavSection[] = actor
    ? [
        { label: "Heute", icon: "home", items: only([{ href: "/start", label: "Überblick", icon: "home" }, { href: "/meine-arbeit", label: "Meine Arbeit", icon: "check" }]) },
        { label: "Kunden", icon: "building", items: only([allowed.has("runde") ? { href: "/kunden", label: "Kundenliste", icon: "building" } : L("kunden", "building"), L("runde", "refresh")]) },
        { label: "Pipeline", icon: "target", items: only([{ href: "/chancen", label: "Chancen", icon: "target" }, L("besetzung", "userplus")]) },
        { label: "Einsätze", icon: "briefcase", items: only([allowed.has("einsaetze") ? { href: "/einsaetze", label: "Einsatzliste", icon: "briefcase" } : null, ...(intakeAllowed ? [{ href: "/auftragseingang", label: "Angebot & Bestellung", icon: "file", badge: intake.drafts }] : []), ...(asgAllowed ? [{ href: "/assignments/konditionen", label: "Laufzeiten & Konditionen", icon: "calendar" }, { href: "/assignments/checkins", label: "Check-ins", icon: "heart" }, { href: "/uebergaben", label: "Übergaben", icon: "swap" }] : [])]) },
        { label: "Steuerung", icon: "chart", items: only([L("ziele", "chart"), L("principals", "users"), ...(cfg.FEATURE_WEEKLYS === "true" ? [{ href: "/weeklys", label: "Weeklys", icon: "calendar" }] : [])]) },
        { label: "Operations", icon: "clipboard", items: only([L("bereinigung", "broom"), ...(mocoLink ? [{ href: "/moco", label: "Moco", icon: "link" }] : []), ...(asgAllowed && (actor.roles.has("CEO") || actor.roles.has("ADMIN")) ? [{ href: "/verwaltung/sharepoint", label: "SharePoint-Ablage", icon: "file" }] : []), ...(actor.roles.has("ADMIN") ? [{ href: "/verwaltung", label: "Verwaltung", icon: "settings" }] : [])]) },
        { label: "Wissen & Werkzeuge", icon: "book", items: [...(cfg.FEATURE_VORGEHEN === "true" ? [{ href: "/vorgehen", label: "Vorgehensmuster", icon: "route" }] : []), ...(cfg.FEATURE_ARTEFAKTE === "true" ? [{ href: "/artefakte", label: "Artefakte", icon: "book" }] : []), ...(provisionAccess(actor).allowed ? [{ href: "/provision", label: "Provisionsrechner", icon: "calculator" }] : []), { href: "/hilfe", label: "Hilfe", icon: "help" }] },
      ].filter((s) => s.items.length > 0)
    : [];
  const initials = actor ? actor.displayName.replace(/\(.*?\)/g, "").trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase() : "";
  const brand = (
    <Link href="/start" className="brand" aria-label="Verve AI – Accountmeister, zur Startseite">
      {/* Logo: public/verve-ai-lockup.png (Verve AI Lockup); Höhe 26px, Breite folgt dem Seitenverhältnis 815:200 */}
      <Image src="/verve-ai-lockup.png" alt="Verve AI" width={90} height={22} priority style={{ height: 22, width: "auto" }} />
      <span className="brand-name">Accountmeister</span>
    </Link>
  );
  const topbar = actor ? (
    <>
      <SearchBox />
      <div className="topbar-actions">
        <AssistantButton />
        <NotificationBell actor={actor} unread={unread} />
        {/* e62: ein Personenmenü – Name, Rolle bzw. Startseiten-Ansicht, Einstellungen, Abmelden */}
        <details className="nav-more nav-hat" aria-label="Mein Konto">
          <summary title="Mein Konto: Ansicht der Startseite, Einstellungen, Abmelden" className="user-chip">
            <span className="avatar" aria-hidden="true">{initials}</span>
            <span className="user-chip-text">
              <span className="user-chip-name">{actor.displayName}</span>
              {hat ? <span className="user-chip-role">{viewLabel[hat]}</span> : null}
            </span>
          </summary>
          <div className="nav-more-menu" style={{ minWidth: 260 }}>
            <span className="muted text-xs" style={{ padding: "4px 8px" }}>Rollen: {roles.join(", ") || "keine fachliche Rolle"}{actor.roles.has("ADMIN") ? " · Betriebsverwaltung" : ""}</span>
            {hat && available.length > 1 && (
              <form action={setHatAction} className="flex flex-col gap-1" style={{ padding: "4px 8px" }}>
                <span className="muted text-xs">Startseite zeigen als:</span>
                {available.map((v) => (
                  <button key={v} name="hat" value={v} type="submit" className={v === hat ? "btn btn-small" : "btn btn-secondary btn-small"} aria-pressed={v === hat} title={viewDescription[v]} style={{ textAlign: "left" }}>
                    {viewLabel[v]}
                  </button>
                ))}
              </form>
            )}
            <Link href="/einstellungen">Einstellungen</Link>
            <form action={logoutAction} style={{ padding: "4px 8px" }}>
              <button className="btn btn-secondary btn-small" type="submit" style={{ width: "100%" }}>
                Abmelden
              </button>
            </form>
          </div>
        </details>
      </div>
    </>
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
        {actor ? (
          <AppShell sections={sections} brand={brand} topbar={topbar}>
            {children}
          </AppShell>
        ) : (
          <>
            <header className="topbar topbar-public">{brand}</header>
            <main className="page page-public">{children}</main>
          </>
        )}
        {actor ? <AssistantPanel signedIn /> : null}
      </body>
    </html>
  );
}
