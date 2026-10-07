import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { buildDashboard, viewLabel, type DashboardView } from "@/modules/dashboard/service";
import { MATURITY, maturityLabel } from "@/modules/strategy/chancen";
import { CHANCE_STEPS } from "@/lib/chanceStages";
import { countChancesByStatus } from "@/modules/opportunities/service";
import { BarChart, CHART_COLORS } from "@/components/charts/BarChart";
import { Feedback, type SearchParams } from "@/components/Feedback";
import { Status } from "@/components/Status";
import { fmtDate, goalStatusLabel, opportunityStatusLabel } from "@/lib/labels";
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
import { createOpportunityAction, setDashboardViewAction, smartDumpAction } from "../actions";
import { listMyCheckins } from "@/modules/engagements/care";
import { listMyOpenActions } from "@/modules/actions/service";
import { listMyHandovers } from "@/modules/handovers/service";
import { listMySupportRequests } from "@/modules/leadership/service";
import { getProviderStatus, listMySuggestions } from "@/modules/suggestions/service";
import { listHints } from "@/modules/moco/sync";
import { listVisibleAccounts } from "@/modules/accounts/service";
import { listSetupsForAccount } from "@/modules/setups/service";
import { db, schema } from "@/db/client";
import { eq } from "drizzle-orm";
import { Aufgaben, Entscheidungen, Vorschlaege } from "@/components/Arbeitsliste";

const DASHBOARD_VIEW_COOKIE = "am_sicht";
/** So viele Kunden mit dem größten Aufmerksamkeitsbedarf werden ausführlich gezeigt. */
const FOCUS = 5;

export default async function StartPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  const store = await cookies();
  const requested = store.get(DASHBOARD_VIEW_COOKIE)?.value ?? null;
  // Fällige Standardaufgaben (Fokus Freelancer) erzeugen, bevor „Diese Woche dran“ geladen wird
  await ensureStandardTasksSafe(actor);
  // Verlängerungsregel: am Auslösetag das Vorgehen „Verlängerung“ anstoßen (Etappe 23)
  await ensureRenewalRunsSafe(actor);
  await ensureInitiativeRemindersSafe(actor);
  await ensureOverdueNotificationsSafe(actor);
  const work = await listMyWork(actor);
  const openSos = await listOpenSosForActor(actor);
  const d = await buildDashboard(actor, requested);
  const focus = await getFocus(actor.workspaceId);
  const fl = d && focus.freelancerLever ? await freelancerStats(actor, d.accounts.map((c) => c.accountId)) : null;
  const healthAll = d ? await computeHealthFor(d.accounts.map((c) => ({ id: c.accountId, name: c.accountName }))) : [];
  // Unübersehbar: Kunden, bei denen Angaben fehlen – zuerst die mit den meisten Einsätzen
  const healthGaps = healthAll.filter((h) => h.questions.length > 0).sort((a, b) => b.engagements.length - a.engagements.length || a.coverage - b.coverage);
  const renewals = d ? await listRenewals(d.accounts.map((c) => c.accountId)) : [];
  const healthBy = new Map(healthAll.map((h) => [h.accountId, h]));
  const chanceCounts = d ? await countChancesByStatus(d.accounts.map((c) => c.accountId)) : {};
  const staffing = getConfig().FEATURE_BESETZUNG === "true";
  const today = new Date().toISOString().slice(0, 10);
  const ai = getProviderStatus();
  const [renewalCards, checkins, actions, handovers, support, suggestions, hints, users] = await Promise.all([
    staffing ? listRenewalCards(actor).catch(() => []) : Promise.resolve([]),
    staffing ? listMyCheckins(actor).catch(() => []) : Promise.resolve([]),
    listMyOpenActions(actor).catch(() => []),
    listMyHandovers(actor).catch(() => []),
    listMySupportRequests(actor).catch(() => []),
    ai.enabled ? listMySuggestions(actor).catch(() => []) : Promise.resolve([]),
    listHints(actor, { status: "OFFEN" }).catch(() => []),
    db.query.users.findMany({ where: eq(schema.users.status, "ACTIVE"), columns: { id: true, displayName: true } }),
  ]);
  const userNames = new Map(users.map((u) => [u.id, u.displayName]));
  const openIncoming = handovers.filter((h) => h.receiverUserId === actor.userId && h.status === "ANGEFRAGT");
  const reviewItems = work.requested.filter((w) => w.status === "ZUR_PRUEFUNG");
  // Schnelleingabe: alle Setups, die ich bearbeiten darf (auch ohne Dashboard-Sicht)
  const quickSetups: { id: string; label: string }[] = [];
  for (const a of await listVisibleAccounts(actor).catch(() => [])) {
    for (const st of await listSetupsForAccount(actor, a.id).catch(() => [])) if (st.status !== "ARCHIVIERT") quickSetups.push({ id: st.id, label: `${a.name} · ${st.name}` });
  }
  const back = "/start";
  const arbeitsliste = (
    <>
      <Entscheidungen renewals={renewalCards} handovers={openIncoming} support={support} review={reviewItems} back={back} />
      <Aufgaben work={work.assigned} checkins={checkins} actions={actions} renewals={renewalCards} support={support} back={back} today={today} />
      <Vorschlaege suggestions={suggestions} hints={hints} userNames={userNames} users={users} back={back} aiEnabled={ai.enabled} />
    </>
  );
  const quickEntry = quickSetups.length > 0 && (
    <section className="card" id="neues">
      <form action={smartDumpAction} className="flex flex-wrap gap-2 items-end text-sm">
        <input type="hidden" name="back" value="/start#vorschlaege" />
        <div style={{ flex: "1 1 24rem" }}>
          <label className="label" htmlFor="quickText">Was gibt es Neues? <span className="muted font-normal">Notiz, Mail-Ausschnitt, Gesprächsergebnis – die KI macht Vorschläge, du übernimmst mit einem Klick.</span></label>
          <textarea id="quickText" name="text" className="textarea" rows={2} required minLength={12} placeholder="z. B. Frau Keller sagt, ab Q1 brauchen sie zwei weitere Tester; Budget kommt aus dem Programm ELBE." />
        </div>
        <div>
          <label className="label" htmlFor="quickSetup">Kunde · Setup</label>
          <select id="quickSetup" name="setupId" className="select" required defaultValue={quickSetups.length === 1 ? quickSetups[0]!.id : ""}>
            <option value="" disabled>– wählen –</option>
            {quickSetups.map((q) => <option key={q.id} value={q.id}>{q.label}</option>)}
          </select>
        </div>
        <button className="btn" type="submit">Einspielen</button>
      </form>
    </section>
  );
  if (!d) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">Start</h1>
        <Feedback params={params} />
        {quickEntry}
        {arbeitsliste}
        {actor.roles.has("SALES_OPS") ? (
          <p className="text-sm">Sales Operations: <Link href="/einsaetze">alle Einsätze</Link> (Person, Kunde, Ende, Stimmung, Verlängerung) · <Link href="/besetzung">Besetzungen</Link> · <Link href="/meine-arbeit">Meine Arbeit</Link>.</p>
        ) : (
          <p className="muted text-sm">Für dein Konto ist keine fachliche Rolle hinterlegt. {actor.roles.has("ADMIN") ? <Link href="/verwaltung">Zur Verwaltung</Link> : "Bitte an die Betriebsverwaltung wenden."}</p>
        )}
      </div>
    );
  }
  const kindLabel: Record<string, string> = { AKTION: "Aktion", UEBERGABE: "Übergabe", VORSCHLAG: "Vorschlag", UNTERSTUETZUNG: "Unterstützung", REVIEW: "Weekly", FRAGE: "Frage" };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline gap-4">
        <h1 className="text-2xl font-semibold">Start</h1>
        {d.available.length > 1 && (
          <form action={setDashboardViewAction} className="flex flex-wrap items-center gap-2 text-sm" aria-label="Sicht wählen">
            <span className="muted">Sicht:</span>
            {d.available.map((v: DashboardView) => (
              <button key={v} name="view" value={v} type="submit" className={v === d.view ? "btn btn-small" : "btn btn-secondary btn-small"} aria-pressed={v === d.view}>
                {viewLabel[v]}
              </button>
            ))}
          </form>
        )}
        <Link href="/meine-arbeit" className="muted text-sm ml-auto">Alle Listen (Meine Arbeit)</Link>
      </div>
      <Feedback params={params} />
      <SosBanner sos={openSos} />
      {quickEntry}
      {arbeitsliste}
      {work.myTeams.length > 0 && (
        <p className="text-sm muted">{work.myTeams.map((t) => <Link key={t.id} href={`/team/${t.id}`} className="mr-3">{work.queue.filter((q) => q.teamId === t.id).length} im Eingang {t.name}</Link>)}</p>
      )}

      <h2 className="font-semibold text-lg pt-2" id="uebersichten">Übersichten <span className="muted text-sm font-normal">– zum Aufklappen; Sicht {viewLabel[d.view]}</span></h2>
      {d.empty && <p className="card text-sm">{d.empty}</p>}

      {d.accounts.length > 0 && (
        <details className="card">
          <summary className="font-semibold">Chancen je Stufe ({Object.values(chanceCounts).reduce((a, b) => a + b, 0)})</summary>
          <BarChart
            title="Chancen je Stufe"
            labelWidth={220}
            bars={[...CHANCE_STEPS, "ZURUECKGESTELLT"].map((s, i) => ({
              label: opportunityStatusLabel[s] ?? s,
              value: chanceCounts[s] ?? 0,
              color: s === "ZURUECKGESTELLT" ? CHART_COLORS.track : CHART_COLORS.sequential[Math.min(Math.floor((i / CHANCE_STEPS.length) * CHART_COLORS.sequential.length), CHART_COLORS.sequential.length - 1)],
              detail: "Chance(n)",
            }))}
          />
          <p className="muted text-xs mt-2">Jede Chance zählt mit ihrem eigenen Stand – ein Kunde mit drei Chancen erscheint dreimal. Sicht: {viewLabel[d.view]} – jede Rolle sieht nur ihren eigenen Zuordnungsbereich.</p>
        </details>
      )}

      {healthGaps.length > 0 && (
        <details className="card" aria-label="Health-Check: fehlende Angaben">
          <summary className="font-semibold" style={{ color: "var(--warn)" }}>Health-Check: Angaben fehlen bei {healthGaps.length} Kunde(n)</summary>
          <p className="muted text-xs mb-2">Ohne diese Angaben ist die Sattelfestigkeit unklar – und Verlängerungen werden nicht rechtzeitig angestoßen.</p>
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
          <summary className="font-semibold">Auslaufende Einsätze – nächste 3 Monate ({renewals.length}){renewals.some((r) => r.escalate) ? <span style={{ color: "#c0392b" }}> · {renewals.filter((r) => r.escalate).length} eskaliert</span> : null}</summary>
          <table className="list">
            <thead><tr><th>Person · Kunde</th><th>Einsatz</th><th>Ende</th><th>Verlängerung</th></tr></thead>
            <tbody>
              {renewals.map((r) => (
                <tr key={r.orderId}>
                  <td>{r.engagementId ? <Link href={`/einsaetze/${r.engagementId}`}><strong>{r.person ?? "?"}</strong></Link> : <strong>{r.person ?? "?"}</strong>} · {r.accountName}</td>
                  <td className="text-sm muted"><Link href={r.engagementId ? `/einsaetze/${r.engagementId}` : `/bedarfe/${r.opportunityId}`}>{r.title}</Link></td>
                  <td className="text-sm" style={{ fontVariantNumeric: "tabular-nums" }}>{fmtDate(r.plannedEnd)} (noch {r.daysToEnd} Tage)</td>
                  <td className="text-sm">
                    {r.escalate && <Status label="Eskalation: ohne Fortschritt" />} {r.decisionStatus ? `${renewalStatusLabel[r.decisionStatus] ?? r.decisionStatus}${r.decisionTo ? ` bis ${fmtDate(r.decisionTo)}` : ""}` : r.runStatus === "LAEUFT" ? `Vorgehen läuft – ${r.currentStep ?? "Schritt offen"}` : r.runStatus === "ABGESCHLOSSEN" ? "Vorgehen abgeschlossen" : "offen"}
                    {r.engagementId && (!r.decisionStatus || r.decisionStatus === "ZU_KLAEREN") && <> · <Link href={`/einsaetze/${r.engagementId}#verlaengerung`}>anstoßen</Link></>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted text-xs mt-2">Stand aus der Einsatzakte. Eskalation: weniger als 4 Wochen bis zum Ende und noch nichts angestoßen.</p>
        </details>
      )}

      {fl && (
        <details className="card">
          <summary className="font-semibold">Freelancer-Hebel <span className="muted text-xs font-normal">– strategischer Fokus, 90 Tage · <Link href="/vorgehen#fokus">Was ist der Fokus?</Link></span></summary>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            {[
              { v: fl.openFreelancerChances, l: "offene Freelancer-Chancen" },
              { v: fl.newFreelancerChances90d, l: "neue Freelancer-Chancen (90 Tage)" },
              { v: fl.presentedOffers90d, l: "vorgestellte Angebote/Profile (90 Tage)" },
              { v: `${fl.accountsWithoutFreelancerChance} / ${fl.accountsTotal}`, l: "Kunden ohne Freelancer-Chance" },
              { v: fl.openChecks, l: "offene Freelancer-Standardaufgaben", href: "/meine-arbeit" },
            ].map((t) => (
              <div key={t.l} className="p-3" style={{ background: "var(--surface-2)", borderRadius: 8 }}>
                <div className="text-2xl font-semibold" style={{ fontVariantNumeric: "tabular-nums" }}>{t.href ? <Link href={t.href}>{t.v}</Link> : t.v}</div>
                <div className="muted text-xs">{t.l}</div>
              </div>
            ))}
          </div>
          <p className="muted text-xs mt-2">Nur Zählungen aus dokumentierten Chancen und Angeboten der Art „Freelancer-Experte“ – keine Umsatz- oder Wahrscheinlichkeitswerte.</p>
        </details>
      )}

      <div className="space-y-4">
        <details className="card">
          <summary className="font-semibold">Diese Woche dran ({d.week.length})</summary>
          {d.week.length === 0 ? (
            <p className="muted text-sm">Nichts Fälliges bis Wochenende. Unten steht, wo der nächste große Schritt hängt.</p>
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
          {d.accounts.length === 0 && !d.empty && <p className="muted text-sm card">Keine aktiven Setups im Bereich dieser Sicht.</p>}
          {d.accounts.slice(0, FOCUS).map((c) => (
            <article key={c.accountId} className="card">
              <div className="flex flex-wrap items-baseline gap-3">
                <h3 className="font-semibold text-lg"><Link href={`/kunden/${c.accountId}`}>{c.accountName}</Link></h3>
                {healthBy.get(c.accountId) && <HealthBadge score={healthBy.get(c.accountId)!.score} level={healthBy.get(c.accountId)!.level} coverage={healthBy.get(c.accountId)!.coverage} />}
                <span className="muted text-sm">{c.chanceCount} Chance(n) · {c.setups.length} Setup(s){c.responsibleBdName ? ` · BD ${c.responsibleBdName}` : " · BD offen"} · letzte Änderung vor {c.daysSinceActivity} Tag(en)</span>
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
                <summary className="muted">Setups im Detail</summary>
                <ul className="mt-2 space-y-1">
                  {c.setups.map((s) => (
                    <li key={s.setupId}>
                      <Link href={`/setups/${s.setupId}`}>{s.setupName}</Link>
                      <span className="muted"> · {s.counts.openActions} Aktion(en){s.counts.overdueActions ? `, ${s.counts.overdueActions} überfällig` : ""} · {s.counts.opportunities} Chance(e) · {s.counts.persons} Person(en){s.counts.openSuggestions ? ` · ${s.counts.openSuggestions} Vorschläge` : ""}</span>
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
              <table className="list mt-2 text-sm">
                <thead><tr><th>Kunde</th><th>Sattelfestigkeit</th><th>Blockiert</th><th>Fehlt</th><th>Züge</th><th>Letzte Änderung</th></tr></thead>
                <tbody>
                  {d.accounts.slice(FOCUS).map((c) => (
                    <tr key={c.accountId}>
                      <td><Link href={`/kunden/${c.accountId}`}>{c.accountName}</Link></td>
                      <td>{healthBy.get(c.accountId) ? <HealthBadge score={healthBy.get(c.accountId)!.score} level={healthBy.get(c.accountId)!.level} coverage={healthBy.get(c.accountId)!.coverage} /> : "–"}</td>
                      <td>{c.blockers.length}</td>
                      <td>{c.missing.length}</td>
                      <td>{c.moves.length}</td>
                      <td>vor {c.daysSinceActivity} Tag(en)</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
        </details>
      </div>

      <div className="space-y-4">
        {d.view !== "CEO" && (
          <details className="card">
            <summary className="font-semibold">Ideen aus den Quellen ({d.ideas.length})</summary>
            {d.ideas.length === 0 ? (
              <p className="muted text-sm">Keine offenen KI-Vorschläge im Bereich. Neue entstehen aus Weekly-Notizen, Dokumenten und dem Assistenten.</p>
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
        {(d.view === "PRINCIPAL" || d.view === "CEO") && (
          <details className="card">
            <summary className="font-semibold">Ziele ({d.goals.length})</summary>
            {d.goals.length === 0 ? (
              <p className="muted text-sm">Keine laufenden Ziele. <Link href="/ziele">Zu Ziele & Portfolio</Link></p>
            ) : (
              <ul className="space-y-1 text-sm">{d.goals.map((g, i) => <li key={i}><Link href={g.href}>{g.title}</Link> <Status label={goalStatusLabel[g.status] ?? g.status} /></li>)}</ul>
            )}
          </details>
        )}
      </div>
      {d.view === "PRINCIPAL" && (
        <details className="card">
          <summary className="font-semibold">Zusammenarbeit der letzten Woche &amp; Top-Chancen je Kunde</summary>
          {d.activity.length === 0 ? (
            <p className="muted text-sm">Keine sichtbaren Kunden mit Aktivität.</p>
          ) : (
            <>
            <BarChart
              title="Aktivitätskoeffizient je Kunde"
              bars={d.activity.map((a) => ({ label: a.accountName, value: a.coefficient, detail: "Aktivitätskoeffizient" }))}
            />
            <table className="list text-sm">
              <thead>
                <tr>
                  <th>Kunde</th>
                  <th>Anker</th>
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
            </table>
            </>
          )}
          <p className="muted text-xs mt-2">Aktivität der letzten 7 Tage, gezählt aus dokumentierten Objekten (Weeklys, Beobachtungen, Aktionen, Vorschläge, Kontakte). Aktivitätskoeffizient: Menge × Anzahl beteiligter Rollen (Principal, BD, Anker) ÷ 3.</p>
        </details>
      )}

      {d.view === "PRINCIPAL" && (
        <details className="card">
          <summary className="font-semibold">Hinweise der KI: möglicherweise neue Chancen ({d.opportunityHints.length})</summary>
          {d.opportunityHints.length === 0 ? (
            <p className="muted text-sm">Keine offenen Beobachtungen, die auf eine neue Chance hindeuten.</p>
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
          <p className="muted text-xs mt-2">Unentschiedene, von der KI abgeleitete Beobachtungen (Kategorie „Neue Information“) aus Weekly-Notizen und Dokumenten – ein Hinweis, keine Vorhersage; ob daraus eine Chance wird, entscheidest du im Setup.</p>
        </details>
      )}

      {d.view === "BD" && d.bdPerformance && (
        <details className="card">
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
            <table className="list text-sm mt-3">
              <thead><tr><th>Kunde</th><th>Eigene Aktivität</th><th>Aktive Chancen</th><th>Beauftragt</th></tr></thead>
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
            </table>
          )}
          <p className="muted text-xs mt-2">{d.bdPerformance.note} Personenbezogen (nicht rollengebündelt): nur eigene dokumentierte Ereignisse und eigene Chancen (Verantwortlich = ich).</p>
        </details>
      )}

      {d.teamActivity.map((t) => (
        <details className="card" key={t.teamId}>
          <summary className="font-semibold">Mein Team: {t.teamName}</summary>
          <p className="muted text-xs mb-2">Aktivitätsindex der letzten {t.days} Tage je Mitglied – Zählungen dokumentierter Ereignisse (Beobachtungen, Aktionen, Vorschläge, Weeklys, Kontakte, Check-ins). Nur Zahlen, keine Inhalte; die Sichtbarkeit von Kunden und Setups bleibt unverändert.</p>
          <table className="list text-sm">
            <thead><tr><th>Mitglied</th><th>Index</th><th>Vorperiode</th><th>Beobachtungen</th><th>Aktionen</th><th>Kontakte</th><th>Check-ins</th><th>Zuletzt aktiv</th></tr></thead>
            <tbody>
              {t.members.map((m) => (
                <tr key={m.userId} style={m.total === 0 ? { color: "#c0392b" } : undefined}>
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
          </table>
        </details>
      ))}

      {d.view === "BD" && (
        <details className="card">
          <summary className="font-semibold">Neue Idee zu einer Opportunity eintragen</summary>
          <p className="muted text-sm mb-2">Wird als antizipierte Chance angelegt – vom Kunden noch nicht ausgesprochen; im Setup dann bestätigen, sobald der Kunde den Bedarf ausspricht.</p>
          {d.accounts.every((c) => c.setups.length === 0) ? (
            <p className="muted text-sm">Noch kein Setup, dem eine Idee zugeordnet werden könnte.</p>
          ) : (
            <form action={createOpportunityAction} className="grid sm:grid-cols-2 gap-3 text-sm">
              <input type="hidden" name="anticipated" value="true" />
              <input type="hidden" name="back" value="/start" />
              <div className="sm:col-span-2">
                <label className="label" htmlFor="ideaSetup">Setup</label>
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

      <p className="muted text-xs">{d.note}</p>
    </div>
  );
}
