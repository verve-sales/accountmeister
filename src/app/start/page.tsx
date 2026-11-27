import Link from "next/link";
import { Segmented } from "@/components/ViewSwitch";
import { Hint } from "@/components/Hint";
import { KpiRow, KpiTile } from "@/components/Kpi";
import { pl } from "@/lib/labels";
import { PendingButton } from "@/components/PendingButton";
import { AutoRefresh } from "@/components/AutoRefresh";
import { listRunningEingang } from "@/modules/eingang/service";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { buildDashboard, loadHat, viewLabel } from "@/modules/dashboard/service";
import { canBrowsePortfolio } from "@/modules/portfolio/service";
import { hasAnyContentRole, hasRole, isCoach, isReadOnlyActor, type Actor } from "@/modules/identity/actor";
import { buildGfOverview } from "@/modules/overview/gf";
import { GfCustomers, GfExpiring, GfHeadsTrend, GfKpis, GfPipeline, GfTeam } from "@/components/GfStart";
import { canEditSetup, loadSetupContext } from "@/modules/identity/authz";
import { MATURITY, maturityLabel } from "@/modules/strategy/chancen";
import { CHANCE_STEPS } from "@/lib/chanceStages";
import { countChancesByStatus } from "@/modules/opportunities/service";
import { BarChart, CHART_COLORS } from "@/components/charts/BarChart";
import { Feedback, type SearchParams } from "@/components/Feedback";
import { Status } from "@/components/Status";
import { fmtDate, goalStatusLabel, opportunityStatusLabel, agoLabel } from "@/lib/labels";
import { ensureStandardTasksSafe, freelancerStats } from "@/modules/focus/standardTasks";
import { getFocus } from "@/modules/focus/service";
import { computeHealthFor } from "@/modules/health/service";
import { ensureRenewalRunsSafe, listRenewals } from "@/modules/health/renewal";
import { listRenewalCards, renewalStatusLabel } from "@/modules/engagements/care";
import { getConfig } from "@/lib/config";
import { HealthBadge } from "@/components/HealthBadge";
import { ensureInitiativeRemindersSafe } from "@/modules/agenda/service";
import { listOpenSosForActor } from "@/modules/sos/service";
import { SosBanner } from "@/components/SosPanel";
import { ensureOverdueNotificationsSafe, listMyWork } from "@/modules/work/service";
import { createActionAction, createOpportunityAction } from "../actions";
import { TaskTimeline, type TimelineTask } from "@/components/TaskTimeline";
import { canSeeTeamTimeline, teamTimeline, type TimelineScope } from "@/modules/tasks/timeline";
import { listMyCheckins } from "@/modules/engagements/care";
import { listMyOpenActions } from "@/modules/actions/service";
import { listMyHandovers } from "@/modules/handovers/service";
import { listMySupportRequests } from "@/modules/leadership/service";
import { getProviderStatus, listMySuggestions } from "@/modules/suggestions/service";
import { listHints } from "@/modules/moco/sync";
import { listVisibleAccounts } from "@/modules/accounts/service";
import { listSetupsForAccount } from "@/modules/setups/service";
import { db, schema } from "@/db/client";
import { buildPrincipalOverview, myPrincipalSummary } from "@/modules/principals/service";
import { roundTeaser } from "@/modules/rounds/service";
import { drillHref } from "@/modules/opportunities/drilldown";
import { TargetProgress } from "@/components/TargetProgress";
import { eq } from "drizzle-orm";
import { Vorschlaege } from "@/components/Arbeitsliste";
import { canUseAssignments } from "@/modules/assignments/service";

const DASHBOARD_VIEW_COOKIE = "am_sicht";
/** Sekunden seit einem Zeitpunkt (für Laufzeit-Hinweise; außerhalb der Komponente, damit das Rendern rein bleibt). */
function secondsSince(ms: number): number {
  return Math.max(1, Math.round((Date.now() - ms) / 1000));
}
/** So viele Kunden mit dem größten Aufmerksamkeitsbedarf werden ausführlich gezeigt. */
const FOCUS = 5;

export default async function StartPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  const store = await cookies();
  const { hat } = await loadHat(actor, store.get(DASHBOARD_VIEW_COOKIE)?.value ?? null);
  // Fällige Standardaufgaben (Fokus Freelancer) erzeugen, bevor „Diese Woche dran“ geladen wird
  await ensureStandardTasksSafe(actor);
  // Verlängerungsregel: am Auslösetag das Vorgehen „Verlängerung“ anstoßen (Etappe 23)
  await ensureRenewalRunsSafe(actor);
  await ensureInitiativeRemindersSafe(actor);
  await ensureOverdueNotificationsSafe(actor);
  const work = await listMyWork(actor);
  const openSos = await listOpenSosForActor(actor);
  const d = await buildDashboard(actor, hat);
  const staffing = getConfig().FEATURE_BESETZUNG === "true";
  const today = new Date().toISOString().slice(0, 10);
  const ai = getProviderStatus();
  const [renewalCards, checkins, actions, handovers, support, suggestions, hints, eingangJobs, users] = await Promise.all([
    staffing ? listRenewalCards(actor).catch(() => []) : Promise.resolve([]),
    staffing ? listMyCheckins(actor).catch(() => []) : Promise.resolve([]),
    listMyOpenActions(actor).catch(() => []),
    listMyHandovers(actor).catch(() => []),
    listMySupportRequests(actor).catch(() => []),
    ai.enabled ? listMySuggestions(actor).catch(() => []) : Promise.resolve([]),
    listHints(actor, { status: "OFFEN" }).catch(() => []),
    ai.enabled ? listRunningEingang(actor).catch(() => ({ running: [], lastError: null })) : Promise.resolve({ running: [], lastError: null }),
    db.query.users.findMany({ where: eq(schema.users.status, "ACTIVE"), columns: { id: true, displayName: true } }),
  ]);
  const userNames = new Map(users.map((u) => [u.id, u.displayName]));
  const openIncoming = handovers.filter((h) => h.receiverUserId === actor.userId && h.status === "ANGEFRAGT");
  const reviewItems = work.requested.filter((w) => w.status === "ZUR_PRUEFUNG");
  // Schnelleingabe: alle Projekte, die ich bearbeiten darf (auch ohne Dashboard-Sicht)
  // parallel statt nacheinander (e48: Start war langsam)
  const quickSetups: { id: string; label: string }[] = (
    await Promise.all(
      (await listVisibleAccounts(actor).catch(() => [])).map(async (a) =>
        Promise.all(
          (await listSetupsForAccount(actor, a.id).catch(() => []))
            .filter((st) => st.status !== "ARCHIVIERT")
            .map(async (st) => {
              const ctx = await loadSetupContext(actor, st.id).catch(() => null);
              return ctx && canEditSetup(actor, ctx) ? { id: st.id, label: `${a.name} · ${st.name}` } : null;
            }),
        ),
      ),
    )
  ).flat().filter((x): x is { id: string; label: string } => !!x);
  const back = "/start";
  // Hut (Etappe 37): die Arbeitsliste ist persönlich – Verlängerungen der BDs erscheinen bei Principal/GF nur „im Blick“
  // e49: Wer nicht im Assignmentmanager arbeitet (BD, Principal), gibt bei Verlängerungen nur das Signal
  const asgUser = await canUseAssignments(actor);
  const myRenewals = renewalCards.filter((c) => c.forMe && (asgUser || c.mode === "ANSTOSSEN"));
  const teamRenewals = renewalCards.filter((c) => !c.forMe);
  // e67: dieselbe Zählung wie „Meine Arbeit“ – jede Verlängerungsentscheidung, die an mich geht
  const nDecide = renewalCards.filter((c) => c.forMe && c.mode === "ENTSCHEIDEN").length + openIncoming.length + support.filter((x) => x.isAddressee && x.status === "ANGEFRAGT").length + reviewItems.length;
  const nTasks = work.assigned.length + checkins.length + actions.length + myRenewals.filter((c) => c.mode === "ANSTOSSEN").length + support.filter((x) => x.isAddressee && x.status === "ANGENOMMEN").length;
  const nSuggest = suggestions.length + hints.length + eingangJobs.running.length + (eingangJobs.lastError ? 1 : 0);
  const eingangStatus = (eingangJobs.running.length > 0 || eingangJobs.lastError) && (
    <div id="auswertung" className="text-sm">
      {eingangJobs.running.length > 0 && (
        <p className="card" style={{ borderLeft: "4px solid #2c5aa0" }}>
          <strong>KI wertet aus …</strong> {eingangJobs.running.length === 1 ? "Eine Auswertung läuft" : `${eingangJobs.running.length} Auswertungen laufen`} seit {secondsSince(Math.min(...eingangJobs.running.map((j) => j.startedAt.getTime())))} s – die Karten erscheinen hier von selbst, bitte nicht erneut einspielen.
          <AutoRefresh />
        </p>
      )}
      {eingangJobs.lastError && eingangJobs.running.length === 0 && (
        <p className="card" style={{ borderLeft: "4px solid #c0392b" }}><strong>Letzte Auswertung fehlgeschlagen</strong> ({agoLabel(Math.round(secondsSince(eingangJobs.lastError.at.getTime()) / 86400))}): {eingangJobs.lastError.error}. Bitte noch einmal auswerten; bleibt es dabei, an die Verwaltung melden.</p>
      )}
    </div>
  );
  const plus = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  const timelineTasks: TimelineTask[] = [
    ...actions.filter((x) => x.status !== "VORGESCHLAGEN").map((x) => ({ key: `a-${x.id}`, kind: "AUFGABE" as const, title: x.title, context: x.setupName, due: x.dueDate, priority: (x.priority as TimelineTask["priority"]) ?? "NORMAL", href: x.setupId ? `/setups/${x.setupId}#aktionen` : "/start#aufgaben" })),
    ...work.assigned.map((w) => ({ key: `w-${w.id}`, kind: "VORGANG" as const, title: w.title, context: w.accountName ?? "", due: w.dueDate, priority: (w.priority === "HOCH" ? "HOCH" : "NORMAL") as TimelineTask["priority"], href: `/vorgaenge/${w.id}` })),
    ...checkins.map((c) => ({ key: `c-${c.id}`, kind: "CHECKIN" as const, title: `Check-in ${c.side === "KUNDE" ? "Kunde" : "Freelancer"}: ${c.personName}`, context: c.accountName, due: c.dueDate, priority: "NORMAL" as const, href: `/einsaetze/${c.engagementId}#checkins` })),
    ...myRenewals.filter((r) => r.mode === "ANSTOSSEN").map((r) => ({ key: `r-${r.decisionId}`, kind: "VERLAENGERUNG" as const, title: `Verlängerung: ${r.person}`, context: r.accountName, due: r.currentEnd ? (plus(56) >= r.currentEnd ? today : new Date(Date.parse(`${r.currentEnd}T00:00:00Z`) - 56 * 86400000).toISOString().slice(0, 10)) : today, priority: (r.daysToEnd !== null && r.daysToEnd <= 28 ? "HOCH" : "NORMAL") as TimelineTask["priority"], href: `/einsaetze/${r.engagementId}#verlaengerung` })),
  ];
  const arbeitsliste =
    nDecide + nTasks + nSuggest === 0 ? (
      <section className="card text-sm" id="arbeitsliste">
        <strong>Keine persönlichen Aufgaben.</strong> <span className="muted">Für dich ist nichts zu entscheiden, nichts fällig und kein Vorschlag offen.</span>
      </section>
    ) : (
      <>
        {nDecide + nTasks > 0 ? (
          <ToDoSummary
            today={today}
            counts={[
              { label: "zu entscheiden", n: renewalCards.filter((c) => c.forMe && c.mode === "ENTSCHEIDEN").length + openIncoming.length + support.filter((x) => x.isAddressee && x.status === "ANGEFRAGT").length + reviewItems.length, href: "/meine-arbeit#entscheidungen" },
              { label: "Check-ins", n: checkins.length, href: "/meine-arbeit#checkins" },
              { label: "Aufgaben", n: actions.length + work.assigned.length, href: "/meine-arbeit#aktionen" },
              { label: "Verlängerungen anzustoßen", n: myRenewals.filter((r) => r.mode === "ANSTOSSEN").length, href: "/meine-arbeit#entscheidungen" },
            ]}
            next={[...timelineTasks].sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999")).slice(0, 5)}
          />
        ) : null}
        {nSuggest > 0 ? <Vorschlaege suggestions={suggestions} hints={hints} userNames={userNames} users={users} back={back} aiEnabled={ai.enabled} status={eingangStatus || null} /> : null}
        {[nDecide ? null : "nichts zu entscheiden", nTasks ? null : "nichts fällig", nSuggest ? null : "keine offenen Vorschläge"].filter(Boolean).length > 0 && (
          <p className="muted text-sm">Außerdem: {[nDecide ? null : "nichts zu entscheiden", nTasks ? null : "nichts fällig", nSuggest ? null : "keine offenen Vorschläge"].filter(Boolean).join(" · ")}.</p>
        )}
      </>
    );
  const readOnly = isReadOnlyActor(actor);
  // e50: Zeitleiste der eigenen Aufgaben (Wunsch der BDs) – ganz oben bei der Erfassung
  const taskEntry = !readOnly && quickSetups.length > 0 && (
    <form action={createActionAction} className="flex flex-wrap gap-2 items-end text-sm mb-3">
      <input type="hidden" name="back" value="/start#zeitleiste" />
      <input type="hidden" name="ownerUserId" value={actor.userId} />
      <div style={{ flex: "2 1 16rem" }}><label className="label" htmlFor="tlTitle">Neue Aufgabe</label><input id="tlTitle" name="title" className="input" required minLength={3} maxLength={300} placeholder="z. B. Profil an Frau Keller schicken" /></div>
      <div style={{ flex: "1 1 12rem" }}><label className="label" htmlFor="tlSetup">Kunde · Projekt</label><select id="tlSetup" name="setupId" className="select" required defaultValue={quickSetups.length === 1 ? quickSetups[0]!.id : ""}><option value="" disabled>Bitte wählen …</option>{quickSetups.map((q) => <option key={q.id} value={q.id}>{q.label}</option>)}</select></div>
      <div><label className="label" htmlFor="tlDue">Fällig</label><input id="tlDue" type="date" name="dueDate" className="input" required defaultValue={plus(7)} /></div>
      <div><label className="label" htmlFor="tlPrio">Priorität</label><select id="tlPrio" name="priority" className="select" defaultValue="NORMAL"><option value="HOCH">hoch</option><option value="NORMAL">normal</option><option value="NIEDRIG">niedrig</option></select></div>
      <PendingButton className="btn btn-small" busy="Speichere …">Eintragen</PendingButton>
    </form>
  );
  // e50: Aufgaben je Rolle – Principal und GF schalten auf „Team“
  const teamAllowed = canSeeTeamTimeline(actor, hat);
  const scope: TimelineScope = teamAllowed && (params as { zl?: string }).zl === "team" ? "team" : "mine";
  const shownTasks = scope === "team" ? await teamTimeline(actor, hat) : timelineTasks;
  const scopeSwitch = teamAllowed ? (
    <Segmented label="Wessen Aufgaben" className="mb-2" items={[{ href: "/start#zeitleiste", label: "Meine", active: scope === "mine" }, { href: "/start?zl=team#zeitleiste", label: hat === "CEO" ? "Ganzes Team" : "Team meiner Kunden", active: scope === "team" }]} />
  ) : null;
  const timeline = !readOnly && hasAnyContentRole(actor) && <TaskTimeline tasks={shownTasks} today={today} title={scope === "team" ? (hat === "CEO" ? "Aufgaben im Team" : "Aufgaben an meinen Kunden") : undefined}>{scopeSwitch}{scope === "mine" ? taskEntry : null}</TaskTimeline>;

  if (!d) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">Start</h1>
        <Feedback params={params} />
        {actor.roles.has("SALES_OPS") && <SalesOpsKpis actor={actor} />}
        {timeline}
        {arbeitsliste}
        {actor.roles.has("SALES_OPS") ? (
          <SalesOpsStart actor={actor} />
        ) : (
          <p className="muted text-sm">Für dein Konto ist keine fachliche Rolle hinterlegt. {actor.roles.has("ADMIN") ? <Link href="/verwaltung">Zur Verwaltung</Link> : "Bitte an die Betriebsverwaltung wenden."}</p>
        )}
      </div>
    );
  }
  // GF-Hut (e48): eine Seite, nichts eingeklappt – Kennzahlen, Entscheidungen, Auslaufendes, Kunden, Pipeline, Team
  if (d.view === "CEO" && hasRole(actor, "CEO")) {
    const o = await buildGfOverview(actor);
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">Start</h1>
        <Feedback params={params} />
        <SosBanner sos={openSos} />
        <GfKpis o={o} />
        {timeline}
        {arbeitsliste}
        <GfHeadsTrend o={o} />
        <GfExpiring o={o} />
        <GfCustomers o={o} />
        <GfPipeline o={o} />
        <GfTeam o={o} />
      </div>
    );
  }
  const focus = await getFocus(actor.workspaceId);
  const fl = focus.freelancerLever ? await freelancerStats(actor, d.accounts.map((c) => c.accountId)) : null;
  const healthAll = await computeHealthFor(d.accounts.map((c) => ({ id: c.accountId, name: c.accountName })));
  // Unübersehbar: Kunden, bei denen Angaben fehlen – zuerst die mit den meisten Einsätzen
  const healthGaps = healthAll.filter((h) => h.questions.length > 0).sort((a, b) => b.engagements.length - a.engagements.length || a.coverage - b.coverage);
  const renewals = await listRenewals(d.accounts.map((c) => c.accountId));
  const healthBy = new Map(healthAll.map((h) => [h.accountId, h]));
  const chanceCounts = await countChancesByStatus(d.accounts.map((c) => c.accountId));
  // Principal/GF-Hut: erst „Bei deinen BDs im Blick“, dann die persönliche Arbeitsliste
  const leader = d.view === "PRINCIPAL" || d.view === "CEO";
  const round = d.view === "CEO" || d.view === "PRINCIPAL" ? await roundTeaser(actor).catch(() => null) : null;
  const principalsQ = d.view === "CEO" ? await buildPrincipalOverview(actor).catch(() => null) : null;
  const mine = d.view === "PRINCIPAL" ? await myPrincipalSummary(actor).catch(() => null) : null;
  const atRisk = healthAll.filter((h) => h.level === "GEFAEHRDET").sort((a, b) => (a.score ?? 0) - (b.score ?? 0));
  const quiet = d.accounts.filter((c) => c.daysSinceActivity > 14).sort((a, b) => b.daysSinceActivity - a.daysSinceActivity);
  const kindLabel: Record<string, string> = { AKTION: "Aktion", UEBERGABE: "Übergabe", VORSCHLAG: "Vorschlag", UNTERSTUETZUNG: "Unterstützung", REVIEW: "Weekly", FRAGE: "Frage" };

  // e64: dieselbe Zählung wie „Einsätze › enden in 8 Wochen“ (laufende Einsätze, nicht nur bestätigte Aufträge)
  const in56 = new Date(Date.parse(`${today}T00:00:00Z`) + 56 * 86400000).toISOString().slice(0, 10);
  const endingSoon = new Set(healthAll.flatMap((h) => h.engagements.filter((x) => x.plannedEnd && x.plannedEnd >= today && x.plannedEnd <= in56).map((x) => x.engagementId ?? x.orderId))).size;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline gap-4">
        <h1 className="text-2xl font-semibold">Start</h1>
      </div>
      <Feedback params={params} />
      <SosBanner sos={openSos} />
      {d.view === "SALES_OPS" ? <SalesOpsKpis actor={actor} /> : (
        <KpiRow>
          <KpiTile value={d.accounts.length} label={d.view === "BD" ? "meine Kunden" : "Kunden im Blick"} href="/kunden" />
          <KpiTile value={Object.entries(chanceCounts).filter(([k]) => !["BEAUFTRAGT", "ZURUECKGESTELLT", "BEENDET"].includes(k)).reduce((a, [, b]) => a + b, 0)} label="offene Chancen" href="#uebersicht-chancen" />
          <KpiTile value={endingSoon} label="Einsätze enden in 8 Wochen" href="/einsaetze?f=enden_8w" tone={endingSoon ? "warn" : null} />
          <KpiTile value={healthGaps.length} label="Kunden mit fehlenden Health-Angaben" href="#uebersicht-health" tone={healthGaps.length ? "warn" : null} />
          <KpiTile value={timelineTasks.filter((t) => t.due && t.due < today).length} label="überfällige Aufgaben" href="#zeitleiste" tone={timelineTasks.some((t) => t.due && t.due < today) ? "danger" : null} />
        </KpiRow>
      )}
      {timeline}
      {readOnly ? (
        <section className="card text-sm">
          <strong>Coach-Zugang (nur lesen).</strong> Zum Durchgehen: <Link href="/meine-bds">Meine BDs</Link> (Kunden je BD mit Stand) · <Link href="/kunden">Kunden</Link> · <Link href="/einsaetze">Einsätze</Link>. Unten die Übersichten zum Aufklappen. Änderungen sind in diesem Zugang nicht möglich.
        </section>
      ) : (
        <>
          {hat === "COACH" && (isCoach(actor) || [...actor.accountRoles.values()].some((r) => r.has("COACH"))) && (
            <section className="card text-sm">
              <strong>Coach-Zugang.</strong> Echte Kunden siehst du nur lesend; in deinem Testkunden darfst du alles ausprobieren. Zum Durchgehen: <Link href="/meine-bds">Meine BDs</Link> · <Link href="/kunden">Kunden</Link> · <Link href="/einsaetze">Einsätze</Link>.
            </section>
          )}
          {leader ? null : arbeitsliste}
        </>
      )}
      {(d.view === "PRINCIPAL" || d.view === "CEO") && (
        <section className="card" id="im-blick" aria-label="Bei deinen BDs im Blick">
          <div className="flex flex-wrap items-baseline gap-3">
            <h2 className="font-semibold">Bei deinen BDs im Blick</h2>
            {canBrowsePortfolio(actor) && <Link href="/meine-bds" className="text-sm ml-auto">Kunden je BD durchgehen</Link>}
          </div>
          {teamRenewals.length + atRisk.length + quiet.length === 0 ? (<p className="empty">Keine offenen Verlängerungen bei den BDs, kein gefährdeter Kunde, überall Bewegung in den letzten 14 Tagen.</p>
          ) : (
            <div className="grid md:grid-cols-3 gap-4 mt-2 text-sm">
              <div>
                <div className="font-medium mb-1">Verlängerungen offen ({teamRenewals.length})</div>
                {teamRenewals.length === 0 ? <p className="muted">Keine.</p> : (
                  <ul className="space-y-1">
                    {teamRenewals.slice(0, 5).map((c) => (
                      <li key={c.decisionId}>
                        <Link href={`/einsaetze/${c.engagementId}#verlaengerung`}>{c.person} · {c.accountName}</Link>
                        <span className="muted"> · {c.mode === "ENTSCHEIDEN" ? "zu entscheiden" : "anzustoßen"}{c.bdName ? ` von ${c.bdName}` : ""}{c.daysToEnd !== null ? ` · Ende in ${c.daysToEnd} T.` : ""}</span>
                      </li>
                    ))}
                    {teamRenewals.length > 5 && <li className="muted">… und {teamRenewals.length - 5} weitere</li>}
                  </ul>
                )}
              </div>
              <div>
                <div className="font-medium mb-1">Gefährdete Kunden ({atRisk.length})</div>
                {atRisk.length === 0 ? <p className="muted">Keiner.</p> : (
                  <ul className="space-y-1">
                    {atRisk.slice(0, 5).map((h) => (
                      <li key={h.accountId} className="flex flex-wrap gap-2 items-center"><Link href={`/kunden/${h.accountId}/health`}>{h.accountName}</Link><HealthBadge score={h.score} level={h.level} coverage={h.coverage} /></li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <div className="font-medium mb-1">Seit über 14 Tagen nichts dokumentiert ({quiet.length})</div>
                {quiet.length === 0 ? <p className="muted">Überall Bewegung.</p> : (
                  <ul className="space-y-1">
                    {quiet.slice(0, 5).map((c) => (
                      <li key={c.accountId}><Link href={`/kunden/${c.accountId}`}>{c.accountName}</Link><span className="muted"> · {c.responsibleBdName ? `BD ${c.responsibleBdName}` : "BD offen"} · {agoLabel(c.daysSinceActivity)}</span></li>
                    ))}
                    {quiet.length > 5 && <li className="muted">… und {quiet.length - 5} weitere</li>}
                  </ul>
                )}
              </div>
            </div>
          )}
        </section>
      )}
      {leader && !readOnly ? arbeitsliste : null}
      {round && round.accounts + (round.radar ?? 0) > 0 && (
        <section className="card flex flex-wrap items-center gap-4 text-sm" aria-label="Kundenrunde">
          <strong>Kundenrunde</strong>
          <span>{round.accounts} Bestandskunden</span>
          {round.red > 0 && <span style={{ color: "var(--danger)", fontWeight: 600 }}>{round.red} rot</span>}
          {round.yellow > 0 && <span style={{ color: "#b7791f", fontWeight: 600 }}>{round.yellow} gelb</span>}
          <span className={round.prepared < round.accounts ? undefined : "muted"}>{round.prepared < round.accounts ? `${round.accounts - round.prepared} noch vorzubereiten` : "alle vorbereitet"}</span>
          <span className="muted">{round.lastRound ? `letzte Runde ${fmtDate(round.lastRound.heldOn)}` : "noch keine Runde"}</span>
          <Link href="/kundenrunde" className="btn btn-small ml-auto">{d.view === "CEO" ? "Zur Kundenrunde" : "Vorbereiten"}</Link>
        </section>
      )}
      {d.view === "CEO" && principalsQ && (
        <section className="card" id="ziele" aria-label="Principals im Quartal">
          <div className="flex flex-wrap items-baseline gap-3">
            <h2 className="font-semibold">Kundenverantwortliche {principalsQ.quarter.label}</h2>
            <span className="muted text-xs">Köpfe · Neukunden · Verlängerungsquote gegen Ziel</span>
            <Link href="/meine-principals" className="text-sm ml-auto">Kundenverantwortliche</Link>
          </div>
          {principalsQ.rows.length === 0 ? <p className="empty">Noch keine Principals zugeordnet.</p> : (
            <div className="table-wrap"><table className="list text-sm mt-1">
              <tbody>
                {principalsQ.rows.map((r) => (
                  <tr key={r.principal.userId}>
                    <td><Link href={`/meine-principals/${r.principal.userId}`}><strong>{r.principal.name}</strong></Link></td>
                    <td><TargetProgress actual={r.actuals.ref ? r.actuals.headsTotal : null} target={r.targets.headsTotal} /></td>
                    <td><TargetProgress actual={r.actuals.ref ? r.actuals.newCustomers.length : null} target={r.targets.newCustomers} /></td>
                    <td><TargetProgress actual={r.actuals.renewals.quote} target={r.targets.renewalQuote} unit=" %" /></td>
                    <td className="text-xs">{r.overdueAgreements ? <span style={{ color: "var(--danger)", fontWeight: 600 }}>{pl(r.overdueAgreements, "Vereinbarung", "Vereinbarungen")} überfällig</span> : r.openAgreements ? `${pl(r.openAgreements, "Vereinbarung", "Vereinbarungen")} offen` : null}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
          {d.goals.length > 0 && <p className="muted text-xs mt-2">Weitere Ziele: <Link href="/ziele">{d.goals.length} unter Ziele & Portfolio</Link></p>}
        </section>
      )}
      {d.view === "PRINCIPAL" && mine && (
        <section className="card" id="meine-ziele" aria-label="Meine Ziele">
          <div className="flex flex-wrap items-baseline gap-3">
            <h2 className="font-semibold">Meine Ziele {mine.quarter.label}</h2>
            <Link href={`/meine-principals/${actor.userId}`} className="text-sm ml-auto">Details & Vereinbarungen</Link>
          </div>
          <div className="grid sm:grid-cols-4 gap-3 mt-2 text-sm">
            <div><div className="muted text-xs">Köpfe</div><TargetProgress actual={mine.actuals.ref ? mine.actuals.headsTotal : null} target={mine.targets.headsTotal} /></div>
            <div><div className="muted text-xs">Neukunden</div><TargetProgress actual={mine.actuals.ref ? mine.actuals.newCustomers.length : null} target={mine.targets.newCustomers} /></div>
            <div><div className="muted text-xs">Verlängerungsquote</div><TargetProgress actual={mine.actuals.renewals.quote} target={mine.targets.renewalQuote} unit=" %" /></div>
            <div><div className="muted text-xs">Vereinbarungen</div>{mine.openAgreements ? <span>{mine.openAgreements} offen{mine.overdueAgreements ? <span style={{ color: "var(--danger)", fontWeight: 600 }}> · {mine.overdueAgreements} überfällig</span> : null}</span> : <span className="muted">keine offen</span>}</div>
          </div>
        </section>
      )}
      {work.myTeams.length > 0 && (
        <p className="text-sm muted">{work.myTeams.map((t) => <Link key={t.id} href={`/team/${t.id}`} className="mr-3">{work.queue.filter((q) => q.teamId === t.id).length} im Eingang {t.name}</Link>)}</p>
      )}

      {d.empty && <p className="card text-sm">{d.empty}</p>}
      {d.accounts.length > 0 && (
        <details className="card" open>
          <summary className="font-semibold" id="uebersicht-chancen">Chancen je Stufe ({Object.values(chanceCounts).reduce((a, b) => a + b, 0)})</summary>
          <BarChart
            title="Chancen je Stufe"
            labelWidth={220}
            bars={[...CHANCE_STEPS, "ZURUECKGESTELLT"].map((s, i) => ({
              label: opportunityStatusLabel[s] ?? s,
              value: chanceCounts[s] ?? 0,
              color: s === "ZURUECKGESTELLT" ? CHART_COLORS.track : CHART_COLORS.sequential[Math.min(Math.floor((i / CHANCE_STEPS.length) * CHART_COLORS.sequential.length), CHART_COLORS.sequential.length - 1)],
              detail: "Chancen",
            }))}
          />
          <p className="text-sm mt-2 flex flex-wrap gap-x-4 gap-y-1">{[...CHANCE_STEPS, "ZURUECKGESTELLT"].filter((st) => (chanceCounts[st] ?? 0) > 0).map((st) => <Link key={st} href={drillHref({ sicht: d.view, stufe: st })}>{opportunityStatusLabel[st] ?? st}: {chanceCounts[st]}</Link>)}</p>
          <Hint>Jede Chance zählt mit ihrem eigenen Stand – ein Kunde mit drei Chancen erscheint dreimal. Sicht: {viewLabel[d.view]} – jede Rolle sieht nur ihren eigenen Zuordnungsbereich.</Hint>
        </details>
      )}

      {/* e68: alles Weitere eine Ebene tiefer – Start zeigt Kennzahlen, Zu erledigen, Wochenplan und Pipeline */}
      <details className="overview-more" id="uebersichten">
        <summary>
          <span className="font-semibold">Weitere Übersichten</span>
          <span className="muted text-sm"> · Health-Check, Verlängerungen, Ausbaupotenzial, Ideen, Performance und mehr · als {viewLabel[d.view]}: {d.accounts.length} Kunden</span>
        </summary>
        <div className="space-y-4 mt-3">
          {d.available.length > 1 && <p className="muted text-xs">Den Hut wechselst du oben rechts neben deinem Namen. Er bestimmt Navigation und Übersichten, nicht deine Rechte.</p>}

      {healthGaps.length > 0 && (
        <details className="card" aria-label="Health-Check: fehlende Angaben" id="uebersicht-health">
          <summary className="font-semibold" style={{ color: "var(--warn)" }}>Health-Check: Angaben fehlen bei {pl(healthGaps.length, "Kunde", "Kunden")}</summary>
          <Hint>Ohne diese Angaben ist der Health-Check unklar – und Verlängerungen werden nicht rechtzeitig angestoßen.</Hint>
          <ul className="space-y-2">
            {healthGaps.slice(0, 3).map((h) => (
              <li key={h.accountId} className="flex flex-wrap items-center gap-3 text-sm">
                <strong>{h.accountName}</strong>
                <HealthBadge score={h.score} level={h.level} coverage={h.coverage} />
                <span className="grow">{h.questions.slice(0, 2).map((q) => q.text).join(" · ")}</span>
                <Link href={`/kunden/${h.accountId}/health#interview`} className="btn btn-small">Interview starten</Link>
              </li>
            ))}
          </ul>
          {healthGaps.length > 3 && <p className="text-sm mt-2">… und {healthGaps.length - 3} weitere Kunden.</p>}
        </details>
      )}

      {renewals.length > 0 && (
        <details className="card">
          <summary className="font-semibold" id="uebersicht-auslaufend">Auslaufende Einsätze – nächste 8 Wochen ({renewals.length}){renewals.some((r) => r.escalate) ? <span style={{ color: "var(--danger)" }}> · {renewals.filter((r) => r.escalate).length} eskaliert</span> : null}</summary>
          <div className="table-wrap"><table className="list">
            <thead><tr><th>Person · Kunde</th><th>Einsatz</th><th>Ende</th><th>Verlängerung</th></tr></thead>
            <tbody>
              {renewals.map((r) => (
                <tr key={r.orderId}>
                  <td>{r.engagementId ? <Link href={`/einsaetze/${r.engagementId}`}><strong>{r.person ?? "?"}</strong></Link> : <strong>{r.person ?? "?"}</strong>} · {r.accountName}</td>
                  <td className="text-sm muted"><Link href={r.engagementId ? `/einsaetze/${r.engagementId}` : `/bedarfe/${r.opportunityId}`}>{r.title}</Link></td>
                  <td className="text-sm" style={{ fontVariantNumeric: "tabular-nums" }}>{fmtDate(r.plannedEnd)} (noch {r.daysToEnd} Tage)</td>
                  <td className="text-sm">
                    {r.escalate && <Status label="Eskalation: ohne Fortschritt" />} {r.decisionStatus ? `${renewalStatusLabel[r.decisionStatus] ?? r.decisionStatus}${r.decisionTo ? ` bis ${fmtDate(r.decisionTo)}` : ""}` : r.runStatus === "LAEUFT" ? `Vorgehen läuft – ${r.currentStep ?? "Schritt offen"}` : r.runStatus === "ABGESCHLOSSEN" ? "Vorgehen abgeschlossen" : "offen"}
                    {r.engagementId && (!r.decisionStatus || r.decisionStatus === "ZU_KLAEREN") && <> · <Link href={`/einsaetze/${r.engagementId}#verlaengerung`} className="btn btn-small btn-quiet">anstoßen</Link></>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
          <Hint>Stand aus der Einsatzakte. Eskalation: weniger als 4 Wochen bis zum Ende und noch nichts angestoßen.</Hint>
        </details>
      )}

      {fl && (
        <details className="card">
          <summary className="font-semibold">Ausbaupotenzial <span className="muted text-xs font-normal">– strategischer Fokus, 90 Tage · <Link href="/vorgehen#fokus">Was ist der Fokus?</Link></span></summary>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            {[
              { v: fl.openFreelancerChances, l: "offene Freelancer-Chancen", href: drillHref({ sicht: d.view, art: "FREELANCER_EXPERTE", stufe: "offen" }) },
              { v: fl.newFreelancerChances90d, l: "neue Freelancer-Chancen (90 Tage)", href: drillHref({ sicht: d.view, art: "FREELANCER_EXPERTE", neu: "90" }) },
              { v: fl.presentedOffers90d, l: "vorgestellte Angebote/Profile (90 Tage)", href: drillHref({ sicht: d.view, art: "FREELANCER_EXPERTE", vorgestellt: "90" }) },
              { v: `${fl.accountsWithoutFreelancerChance} / ${fl.accountsTotal}`, l: "Kunden ohne Freelancer-Chance", href: drillHref({ sicht: d.view, ohne: "FREELANCER_EXPERTE" }) },
              { v: fl.openChecks, l: "offene Freelancer-Standardaufgaben", href: "/meine-arbeit" },
            ].map((t) => (
              <div key={t.l} className="p-3" style={{ background: "var(--surface-2)", borderRadius: 8 }}>
                <div className="text-2xl font-semibold" style={{ fontVariantNumeric: "tabular-nums" }}>{t.href ? <Link href={t.href}>{t.v}</Link> : t.v}</div>
                <div className="muted text-xs">{t.l}</div>
              </div>
            ))}
          </div>
          <Hint>Nur Zählungen aus dokumentierten Chancen und Angeboten der Art „Freelancer-Experte“ – keine Umsatz- oder Wahrscheinlichkeitswerte.</Hint>
        </details>
      )}

      <div className="space-y-4">
        <details className="card">
          <summary className="font-semibold">Diese Woche dran ({d.week.length})</summary>
          {d.week.length === 0 ? (<p className="empty">Nichts Fälliges bis Wochenende. Unten steht, wo der nächste große Schritt hängt.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {d.week.map((w, i) => (
                <li key={i} className="flex gap-2 items-baseline" style={w.overdue ? { color: "#a12b1e" } : w.today ? { fontWeight: 600 } : undefined}>
                  <span className="status shrink-0">{kindLabel[w.kind] ?? w.kind}</span>
                  <span>
                    <Link href={w.href}>{w.text}</Link>
                    {w.due && <span className="muted"> · {w.overdue ? "überfällig seit" : w.today ? "heute" : "fällig"} {w.today ? "" : w.due}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </details>

        <details className="card space-y-4">
          <summary className="font-semibold">Kunden – wo der nächste große Schritt hängt ({d.accounts.length})</summary>
          {d.accounts.length === 0 && !d.empty && <p className="muted text-sm card">Keine aktiven Projekte im Bereich dieser Sicht.</p>}
          {d.accounts.slice(0, FOCUS).map((c) => (
            <article key={c.accountId} className="card">
              <div className="flex flex-wrap items-baseline gap-3">
                <h3 className="font-semibold text-lg"><Link href={`/kunden/${c.accountId}`}>{c.accountName}</Link></h3>
                {healthBy.get(c.accountId) && <HealthBadge score={healthBy.get(c.accountId)!.score} level={healthBy.get(c.accountId)!.level} coverage={healthBy.get(c.accountId)!.coverage} />}
                <span className="muted text-sm">{pl(c.chanceCount, "Chance", "Chancen")} · {pl(c.setups.length, "Projekt", "Projekte")}{c.responsibleBdName ? ` · BD ${c.responsibleBdName}` : " · BD offen"} · letzte Änderung {agoLabel(c.daysSinceActivity)}</span>
              </div>
              <p className="text-sm mt-2"><span className="muted">Wofür: </span>{c.chanceCount ? <strong>{c.purpose}</strong> : <span style={{ color: "#8a6d1f" }}>{c.purpose}</span>}</p>
              <p className="text-sm mt-1"><span className="muted">Nächster großer Schritt: </span>{c.nextStep}</p>
              <div className="grid sm:grid-cols-3 gap-4 mt-3 text-sm">
                <div>
                  <div className="font-medium mb-1">Blockiert</div>
                  {c.blockers.length === 0 ? <p className="muted">Nichts Dokumentiertes.</p> : <ul className="space-y-1">{c.blockers.map((b, i) => <li key={i} style={{ color: "#a12b1e" }}>{b}</li>)}</ul>}
                </div>
                <div>
                  <div className="font-medium mb-1">Was fehlt</div>
                  {c.missing.length === 0 ? <p className="muted">Grundlagen vollständig.</p> : <ul className="space-y-1">{c.missing.map((m, i) => <li key={i}>{m}</li>)}</ul>}
                </div>
                <div>
                  <div className="font-medium mb-1">Naheliegende Züge</div>
                  {c.moves.length === 0 ? <p className="muted">Nichts vorbereitet – Assistent fragen.</p> : <ul className="space-y-1">{c.moves.map((m, i) => <li key={i}><Link href={m.href}>{m.text}</Link></li>)}</ul>}
                </div>
              </div>
              <details className="mt-3 text-sm">
                <summary className="muted">Projekte im Detail</summary>
                <ul className="mt-2 space-y-1">
                  {c.setups.map((s) => (
                    <li key={s.setupId}>
                      <Link href={`/setups/${s.setupId}`}>{s.setupName}</Link>
                      <span className="muted"> · {pl(s.counts.openActions, "Aktion", "Aktionen")}{s.counts.overdueActions ? `, ${s.counts.overdueActions} überfällig` : ""} · {pl(s.counts.opportunities, "Chance", "Chancen")} · {pl(s.counts.persons, "Person", "Personen")}{s.counts.openSuggestions ? ` · ${s.counts.openSuggestions} Vorschläge` : ""}</span>
                      <span className="ml-2"><Link href={`/setups/${s.setupId}/strategie`}>Strategiefaden</Link> · <Link href={`/setups/${s.setupId}?assistent=1`}>Assistent</Link></span>
                    </li>
                  ))}
                </ul>
              </details>
            </article>
          ))}
          {d.accounts.length > FOCUS && (
            <details className="card">
              <summary>Weitere Kunden ({d.accounts.length - FOCUS}) – weniger Aufmerksamkeit nötig</summary>
              <div className="table-wrap"><table className="list mt-2 text-sm">
                <thead><tr><th>Kunde</th><th>Health-Check</th><th>Blockiert</th><th>Fehlt</th><th>Züge</th><th>Letzte Änderung</th></tr></thead>
                <tbody>
                  {d.accounts.slice(FOCUS).map((c) => (
                    <tr key={c.accountId}>
                      <td><Link href={`/kunden/${c.accountId}`}>{c.accountName}</Link></td>
                      <td>{healthBy.get(c.accountId) ? <HealthBadge score={healthBy.get(c.accountId)!.score} level={healthBy.get(c.accountId)!.level} coverage={healthBy.get(c.accountId)!.coverage} /> : "–"}</td>
                      <td>{c.blockers.length}</td>
                      <td>{c.missing.length}</td>
                      <td>{c.moves.length}</td>
                      <td>{agoLabel(c.daysSinceActivity)}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            </details>
          )}
        </details>
      </div>

      <div className="space-y-4">
        {d.view !== "CEO" && (
          <details className="card">
            <summary className="font-semibold">Ideen aus den Quellen ({d.ideas.length})</summary>
            {d.ideas.length === 0 ? (<p className="empty">Keine offenen KI-Vorschläge im Bereich. Neue entstehen aus Weekly-Notizen, Dokumenten und dem Assistenten.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {d.ideas.map((i, k) => (
                  <li key={k}>
                    <Link href={i.href}>{i.text}</Link>
                    <span className="muted"> · {i.setupName}</span>
                    {i.detail && <div className="muted text-xs">{i.detail.slice(0, 160)}</div>}
                  </li>
                ))}
              </ul>
            )}
          </details>
        )}
        {d.view === "PRINCIPAL" && (
          <details className="card">
            <summary className="font-semibold">Ziele ({d.goals.length})</summary>
            {d.goals.length === 0 ? (<p className="empty">Keine laufenden Ziele. <Link href="/ziele">Zu Ziele & Portfolio</Link></p>
            ) : (
              <ul className="space-y-1 text-sm">{d.goals.map((g, i) => <li key={i}><Link href={g.href}>{g.title}</Link> <Status label={goalStatusLabel[g.status] ?? g.status} /></li>)}</ul>
            )}
          </details>
        )}
      </div>
      {d.view === "PRINCIPAL" && (
        <details className="card">
          <summary className="font-semibold">Zusammenarbeit der letzten Woche &amp; Top-Chancen je Kunde</summary>
          {d.activity.length === 0 ? (<p className="empty">Keine sichtbaren Kunden mit Aktivität.</p>
          ) : (
            <>
            <BarChart
              title="Aktivitätskoeffizient je Kunde"
              bars={d.activity.map((a) => ({ label: a.accountName, value: a.coefficient, detail: "Aktivitätskoeffizient" }))}
            />
            <div className="table-wrap"><table className="list text-sm">
              <thead>
                <tr>
                  <th>Kunde</th>
                  <th>Kontaktpate</th>
                  <th>BD</th>
                  <th>Koeffizient</th>
                  <th>Top-Chancen</th>
                </tr>
              </thead>
              <tbody>
                {d.activity.map((a) => {
                  const total = (c: (typeof a.byRole)["ANKER"]) => c.weeklysBestaetigt + c.beobachtungenErfasst + c.aktionenErfasstOderErledigt + c.vorschlaegeEntschieden + c.kontakteGepflegt;
                  const chances = d.topOpportunities[a.accountId] ?? [];
                  return (
                    <tr key={a.accountId}>
                      <td><Link href={`/kunden/${a.accountId}`}>{a.accountName}</Link></td>
                      <td>{total(a.byRole.ANKER)}</td>
                      <td>{total(a.byRole.BD)}</td>
                      <td>{a.coefficient}</td>
                      <td>{chances.length === 0 ? <span className="muted">keine aktive Chance</span> : chances.map((c) => `${c.title} (${maturityLabel[c.maturity]})`).join("; ")}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table></div>
            </>
          )}
          <Hint>Aktivität der letzten 7 Tage, gezählt aus dokumentierten Objekten (Weeklys, Beobachtungen, Aktionen, Vorschläge, Kontakte). Aktivitätskoeffizient: Menge × Anzahl beteiligter Rollen (Principal, BD, Kontaktpate) ÷ 3.</Hint>
        </details>
      )}

      {d.view === "PRINCIPAL" && (
        <details className="card">
          <summary className="font-semibold">Hinweise der KI: möglicherweise neue Chancen ({d.opportunityHints.length})</summary>
          {d.opportunityHints.length === 0 ? (<p className="empty">Keine offenen Beobachtungen, die auf eine neue Chance hindeuten.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {d.opportunityHints.map((h, i) => (
                <li key={i}>
                  <Link href={h.href}>{h.text}</Link>
                  <span className="muted"> · {h.accountName}</span>
                  {h.detail && <div className="muted text-xs">{h.detail.slice(0, 160)}</div>}
                </li>
              ))}
            </ul>
          )}
          <Hint>Unentschiedene, von der KI abgeleitete Beobachtungen (Kategorie „Neue Information“) aus Weekly-Notizen und Dokumenten – ein Hinweis, keine Vorhersage; ob daraus eine Chance wird, entscheidest du im Projekt.</Hint>
        </details>
      )}

      {d.view === "BD" && d.bdPerformance && (
        <details className="card" open>
          <summary className="font-semibold">Meine Performance</summary>
          <div className="grid sm:grid-cols-2 gap-4 text-sm">
            <div>
              <div className="font-medium mb-1">Eigene Aktivität (letzte {d.bdPerformance.sinceDays} Tage): {d.bdPerformance.totalMyActivities}</div>
              <ul className="space-y-1">
                <li>Beobachtungen erfasst: {d.bdPerformance.myActivities.beobachtungenErfasst}</li>
                <li>Aktionen erfasst/erledigt: {d.bdPerformance.myActivities.aktionenErfasstOderErledigt}</li>
                <li>Vorschläge entschieden: {d.bdPerformance.myActivities.vorschlaegeEntschieden}</li>
                <li>Weeklys bestätigt: {d.bdPerformance.myActivities.weeklysBestaetigt}</li>
                <li>Kontakte gepflegt: {d.bdPerformance.myActivities.kontakteGepflegt}</li>
              </ul>
            </div>
            <div>
              <div className="font-medium mb-1">Eigene Chancen: {d.bdPerformance.opportunities.active} aktiv, davon {d.bdPerformance.opportunities.converted} beauftragt · {d.bdPerformance.opportunities.createdRecently} neu diese Woche</div>
              <BarChart
                title="Eigene Chancen nach Reifegrad"
                bars={MATURITY.map((m, i) => ({ label: maturityLabel[m], value: d.bdPerformance!.opportunities.byMaturity[m], color: CHART_COLORS.sequential[i], detail: "eigene Chancen" }))}
              />
            </div>
          </div>
          {d.bdPerformance.accounts.length > 0 && (
            <div className="table-wrap"><table className="list text-sm mt-3">
              <thead><tr><th>Kunde</th><th>Eigene Aktivität</th><th>Aktive Chancen</th><th>Konvertiert</th></tr></thead>
              <tbody>
                {d.bdPerformance.accounts.map((a) => (
                  <tr key={a.accountId}>
                    <td><Link href={`/kunden/${a.accountId}`}>{a.accountName}</Link></td>
                    <td>{a.totalMyActivities}</td>
                    <td>{a.activeOpportunities}</td>
                    <td>{a.convertedOpportunities}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
          <Hint>{d.bdPerformance.note} Personenbezogen (nicht rollengebündelt): nur eigene dokumentierte Ereignisse und eigene Chancen (Verantwortlich = ich).</Hint>
        </details>
      )}

      {d.teamActivity.map((t) => (
        <details className="card" key={t.teamId}>
          <summary className="font-semibold">Mein Team: {t.teamName}</summary>
          <Hint>Aktivitätsindex der letzten {t.days} Tage je Mitglied – Zählungen dokumentierter Ereignisse (Beobachtungen, Aktionen, Vorschläge, Weeklys, Kontakte, Check-ins). Nur Zahlen, keine Inhalte; die Sichtbarkeit von Kunden und Projekte bleibt unverändert.</Hint>
          <div className="table-wrap"><table className="list text-sm">
            <thead><tr><th>Mitglied</th><th>Index</th><th>Vorperiode</th><th>Beobachtungen</th><th>Aktionen</th><th>Kontakte</th><th>Check-ins</th><th>Zuletzt aktiv</th></tr></thead>
            <tbody>
              {t.members.map((m) => (
                <tr key={m.userId} style={m.total === 0 ? { color: "var(--danger)" } : undefined}>
                  <td>{m.name}</td>
                  <td><strong>{m.total}</strong></td>
                  <td>{m.previousTotal}{m.total > m.previousTotal ? " ↑" : m.total < m.previousTotal ? " ↓" : ""}</td>
                  <td>{m.current.beobachtungenErfasst}</td>
                  <td>{m.current.aktionenErfasstOderErledigt}</td>
                  <td>{m.current.kontakteGepflegt}</td>
                  <td>{m.checkinsErledigt}</td>
                  <td>{m.lastActivityDays === null ? "noch nie" : m.lastActivityDays === 0 ? "heute" : `vor ${m.lastActivityDays} Tagen`}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </details>
      ))}

      {d.view === "BD" && (
        <details className="card">
          <summary className="font-semibold">Neue Idee zu einer Opportunity eintragen</summary>
          <p className="muted text-sm mb-2">Wird als antizipierte Chance angelegt – vom Kunden noch nicht ausgesprochen; im Projekt dann bestätigen, sobald der Kunde den Bedarf ausspricht.</p>
          {d.accounts.every((c) => c.setups.length === 0) ? (
            <p className="muted text-sm">Noch kein Projekt, dem eine Idee zugeordnet werden könnte.</p>
          ) : (
            <form action={createOpportunityAction} className="grid sm:grid-cols-2 gap-3 text-sm">
              <input type="hidden" name="anticipated" value="true" />
              <input type="hidden" name="back" value="/start" />
              <div className="sm:col-span-2">
                <label className="label" htmlFor="ideaSetup">Projekt</label>
                <select id="ideaSetup" name="setupId" className="select" required defaultValue="">
                  <option value="">– wählen –</option>
                  {d.accounts.map((c) => c.setups.map((s) => <option key={s.setupId} value={s.setupId}>{c.accountName} · {s.setupName}</option>))}
                </select>
              </div>
              <div className="sm:col-span-2"><label className="label" htmlFor="ideaTitle">Titel</label><input id="ideaTitle" name="title" className="input" required minLength={3} maxLength={200} /></div>
              <div className="sm:col-span-2"><label className="label" htmlFor="ideaNeed">Beschreibung in Kundensprache</label><textarea id="ideaNeed" name="needDescription" className="textarea" required minLength={10} rows={3} /></div>
              <div className="sm:col-span-2"><button className="btn" type="submit">Idee als Chance anlegen</button></div>
            </form>
          )}
        </details>
      )}

        </div>
      </details>

      <Hint>{d.note}</Hint>
    </div>
  );
}

/** e64: Sales Operations sieht auf dem Start dieselben Kennzahlen wie in der Sales-Ops-Sicht (keine leere Startseite). */
async function SalesOpsKpis({ actor }: { actor: Actor }) {
  const { canUseSalesOps, salesOpsOverview } = await import("@/modules/salesops/service");
  if (getConfig().FEATURE_BESETZUNG !== "true" || !canUseSalesOps(actor)) return null;
  const k = (await salesOpsOverview(actor)).kpis;
  const t = (n: number) => (n > 0 ? ("warn" as const) : null);
  // e68 (E3): Wertblick wie bei der Geschäftsführung – laufender Monatsumsatz und was in 8 Wochen ohne Entscheidung ausläuft
  const { listEngagements } = await import("@/modules/engagements/service");
  const { revenueKpis } = await import("@/modules/overview/gf");
  const running = (await listEngagements(actor, "laufend").catch(() => ({ items: [] as { id: string; daysToEnd: number | null; renewalStatus: string | null }[] }))).items;
  const rev = await revenueKpis(running.map((e) => e.id), new Set(running.filter((e) => e.daysToEnd !== null && e.daysToEnd <= 56 && !["BESTAETIGT", "ABGELEHNT", "ERLEDIGT"].includes(e.renewalStatus ?? "")).map((e) => e.id)));
  const eur = (n: number) => `${new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 }).format(n)} €`;
  return (
    <KpiRow>
      {rev.revenueMonth != null && <KpiTile value={eur(rev.revenueMonth)} label={`Umsatz je Monat, laufend${rev.expiringMonth ? ` · ${eur(rev.expiringMonth)} davon ohne Entscheidung` : ""}`} href="/einsaetze?f=enden_8w" />}
      <KpiTile value={k.anzustossen} label="Verlängerung anzustoßen" href="/vertragsbuero#anstossen" tone={t(k.anzustossen)} />
      <KpiTile value={k.ohneAnsprechpartner} label="ohne Verlängerungs-Ansprechpartner" href="/einsaetze?f=ohne_ansprechpartner" tone={t(k.ohneAnsprechpartner)} />
      <KpiTile value={k.unterlagenOffen} label="Unterlagen offen" href="/einsaetze?f=vertrag_offen" tone={t(k.unterlagenOffen)} />
      <KpiTile value={k.endeUeberschritten} label="Ende überschritten" href="/einsaetze?f=ende_ueberschritten" tone={t(k.endeUeberschritten)} />
      <KpiTile value={k.uebergabenOffen} label="Übergaben ans Backoffice offen" href="/uebergaben" tone={t(k.uebergabenOffen)} />
      <KpiTile value={k.laufend} label="laufende Einsätze" href="/einsaetze" />
    </KpiRow>
  );
}

function SalesOpsStart({ actor }: { actor: Actor }) {
  void actor;
  return (
    <section className="card text-sm">
      <h2 className="font-semibold">Weiter zu</h2>
      <div className="flex flex-wrap gap-2 mt-1">
        <Link href="/vertragsbuero" className="btn btn-secondary btn-small">Sales-Ops-Sicht</Link>
        <Link href="/einsaetze" className="btn btn-secondary btn-small">Alle Einsätze</Link>
        <Link href="/besetzung" className="btn btn-secondary btn-small">Besetzung</Link>
        <Link href="/meine-arbeit" className="btn btn-secondary btn-small">Meine Arbeit</Link>
      </div>
    </section>
  );
}

/** e65: Start zeigt die Lage – was ansteht, mit Zählern und den nächsten fünf Punkten; abgearbeitet wird in „Meine Arbeit“. */
function ToDoSummary({ counts, next, today }: { counts: { label: string; n: number; href: string }[]; next: TimelineTask[]; today: string }) {
  const total = counts.reduce((s, c) => s + c.n, 0);
  return (
    <section className="card" id="arbeitsliste">
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className="font-semibold">Zu erledigen ({total})</h2>
        <Link href="/meine-arbeit" className="btn btn-small ml-auto">In Meine Arbeit abarbeiten</Link>
      </div>
      <div className="flex flex-wrap gap-2 mt-2">
        {counts.filter((c) => c.n > 0).map((c) => <Link key={c.label} href={c.href} className="chip"><strong>{c.n}</strong> {c.label}</Link>)}
      </div>
      {next.length > 0 && (
        <ul className="todo-next">
          {next.map((t) => (
            <li key={t.key}>
              <Link href={t.href}>{t.title}</Link>
              <span className="muted text-xs">{t.context}</span>
              <span className={`text-xs todo-due${t.due && t.due < today ? " tone-danger" : ""}`}>{t.due ? (t.due < today ? `überfällig seit ${fmtDate(t.due)}` : `fällig ${fmtDate(t.due)}`) : "ohne Termin"}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
