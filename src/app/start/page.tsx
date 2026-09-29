import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { buildDashboard, viewDescription, viewLabel, type DashboardView } from "@/modules/dashboard/service";
import { MATURITY, maturityLabel } from "@/modules/strategy/chancen";
import { STAGES, stageLabel } from "@/modules/strategy/analysis";
import { BarChart, CHART_COLORS } from "@/components/charts/BarChart";
import { Feedback, type SearchParams } from "@/components/Feedback";
import { Status } from "@/components/Status";
import { ProcessStepper } from "@/components/ProcessStepper";
import { fmtDate, goalStatusLabel } from "@/lib/labels";
import { ensureStandardTasksSafe, freelancerStats } from "@/modules/focus/standardTasks";
import { getFocus } from "@/modules/focus/service";
import { computeHealthFor } from "@/modules/health/service";
import { ensureRenewalRunsSafe, listRenewals } from "@/modules/health/renewal";
import { HealthBadge } from "@/components/HealthBadge";
import { createOpportunityAction, setDashboardViewAction, smartDumpAction } from "../actions";

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
  const d = await buildDashboard(actor, requested);
  const focus = await getFocus(actor.workspaceId);
  const fl = d && focus.freelancerLever ? await freelancerStats(actor, d.accounts.map((c) => c.accountId)) : null;
  const healthAll = d ? await computeHealthFor(d.accounts.map((c) => ({ id: c.accountId, name: c.accountName }))) : [];
  // Unübersehbar: Kunden, bei denen Angaben fehlen – zuerst die mit den meisten Einsätzen
  const healthGaps = healthAll.filter((h) => h.questions.length > 0).sort((a, b) => b.engagements.length - a.engagements.length || a.coverage - b.coverage);
  const renewals = d ? await listRenewals(d.accounts.map((c) => c.accountId)) : [];
  if (!d) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">Start</h1>
        <p className="muted text-sm">Für dein Konto ist keine fachliche Rolle hinterlegt. {actor.roles.has("ADMIN") ? <Link href="/verwaltung">Zur Verwaltung</Link> : "Bitte an die Betriebsverwaltung wenden."}</p>
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
      <p className="muted text-sm">{viewDescription[d.view]}</p>
      <Feedback params={params} />

      {d.empty && <p className="card text-sm">{d.empty}</p>}

      {d.accounts.length > 0 && (
        <section className="card">
          <h2 className="font-semibold mb-2">Wo stehen wir insgesamt? (Portfolio nach Prozessstufe)</h2>
          <BarChart
            title="Kunden je Prozessstufe"
            labelWidth={220}
            bars={STAGES.map((s, i) => ({
              label: stageLabel[s],
              value: d.accounts.filter((c) => c.stage === s).length,
              color: CHART_COLORS.sequential[Math.min(Math.floor((i / STAGES.length) * CHART_COLORS.sequential.length), CHART_COLORS.sequential.length - 1)],
              detail: "Kunde(n)",
            }))}
          />
          <p className="muted text-xs mt-2">Je Kunde zählt die am weitesten fortgeschrittene Stufe seiner Setups. Sicht: {viewLabel[d.view]} – jede Rolle sieht nur ihren eigenen Zuordnungsbereich.</p>
        </section>
      )}

      {healthGaps.length > 0 && (
        <section className="card" style={{ borderColor: "var(--warn)", borderWidth: 2, background: "var(--warn-soft)" }} aria-label="Health-Check: fehlende Angaben">
          <div className="flex flex-wrap items-baseline gap-3 mb-2">
            <h2 className="font-semibold" style={{ color: "var(--warn)" }}>Health-Check: Accountmeister braucht Angaben zu {healthGaps.length} Kunde(n)</h2>
            <span className="muted text-xs">Ohne diese Angaben ist die Sattelfestigkeit unklar – und Verlängerungen werden nicht rechtzeitig angestoßen.</span>
          </div>
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
        </section>
      )}

      {renewals.length > 0 && (
        <section className="card">
          <h2 className="font-semibold mb-2">Auslaufende Einsätze (nächste 12 Wochen)</h2>
          <table className="list">
            <thead><tr><th>Kunde · Einsatz</th><th>Ende</th><th>Verlängerung</th></tr></thead>
            <tbody>
              {renewals.map((r) => (
                <tr key={r.orderId}>
                  <td><Link href={`/bedarfe/${r.opportunityId}`}>{r.accountName} · {r.title}</Link></td>
                  <td className="text-sm" style={{ fontVariantNumeric: "tabular-nums" }}>{fmtDate(r.plannedEnd)} (noch {r.daysToEnd} Tage)</td>
                  <td className="text-sm">
                    {r.escalate && <Status label="Eskalation: ohne Fortschritt" />} {r.runStatus === "LAEUFT" ? `läuft – ${r.currentStep ?? "Schritt offen"}` : r.runStatus === "ABGESCHLOSSEN" ? "Vorgehen abgeschlossen" : "noch nicht gestartet"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted text-xs mt-2">Eskalation: weniger als 4 Wochen bis zum Ende und im Verlängerungsvorgehen noch kein Schritt erledigt.</p>
        </section>
      )}

      {fl && (
        <section className="card">
          <div className="flex flex-wrap items-baseline gap-3 mb-2">
            <h2 className="font-semibold">Freelancer-Hebel</h2>
            <span className="muted text-xs">Strategischer Fokus · {viewLabel[d.view]} · Zeitraum 90 Tage</span>
            <Link href="/vorgehen#fokus" className="muted text-xs ml-auto">Was ist der Fokus?</Link>
          </div>
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
        </section>
      )}

      <div className="grid lg:grid-cols-3 gap-6">
        <section className="card lg:col-span-1">
          <h2 className="font-semibold mb-2">Diese Woche dran</h2>
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
        </section>

        <section className="lg:col-span-2 space-y-4">
          <h2 className="font-semibold">Kunden – wo der nächste große Schritt hängt</h2>
          {d.accounts.length === 0 && !d.empty && <p className="muted text-sm card">Keine aktiven Setups im Bereich dieser Sicht.</p>}
          {d.accounts.slice(0, FOCUS).map((c) => (
            <article key={c.accountId} className="card">
              <div className="flex flex-wrap items-baseline gap-3">
                <h3 className="font-semibold text-lg"><Link href={`/kunden/${c.accountId}`}>{c.accountName}</Link></h3>
                <ProcessStepper steps={STAGES.map((s) => ({ key: s, label: stageLabel[s] }))} currentKey={c.stage} variant="compact" />
                <span className="muted text-sm">{c.setups.length} Setup(s){c.responsibleBdName ? ` · BD ${c.responsibleBdName}` : " · BD offen"} · letzte Änderung vor {c.daysSinceActivity} Tag(en)</span>
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
                      <Link href={`/setups/${s.setupId}`}>{s.setupName}</Link>{" "}
                      <ProcessStepper steps={STAGES.map((st) => ({ key: st, label: stageLabel[st] }))} currentKey={s.stage} variant="compact" />
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
                <thead><tr><th>Kunde</th><th>Stufe</th><th>Blockiert</th><th>Fehlt</th><th>Züge</th><th>Letzte Änderung</th></tr></thead>
                <tbody>
                  {d.accounts.slice(FOCUS).map((c) => (
                    <tr key={c.accountId}>
                      <td><Link href={`/kunden/${c.accountId}`}>{c.accountName}</Link></td>
                      <td><ProcessStepper steps={STAGES.map((s) => ({ key: s, label: stageLabel[s] }))} currentKey={c.stage} variant="compact" /></td>
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
        </section>
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        {d.view !== "CEO" && (
          <section className="card">
            <h2 className="font-semibold mb-2">Ideen aus den Quellen ({d.ideas.length})</h2>
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
          </section>
        )}
        {(d.view === "PRINCIPAL" || d.view === "CEO") && (
          <section className="card">
            <h2 className="font-semibold mb-2">Ziele ({d.goals.length})</h2>
            {d.goals.length === 0 ? (
              <p className="muted text-sm">Keine laufenden Ziele. <Link href="/ziele">Zu Ziele & Portfolio</Link></p>
            ) : (
              <ul className="space-y-1 text-sm">{d.goals.map((g, i) => <li key={i}><Link href={g.href}>{g.title}</Link> <Status label={goalStatusLabel[g.status] ?? g.status} /></li>)}</ul>
            )}
          </section>
        )}
      </div>
      {d.view === "PRINCIPAL" && (
        <section className="card">
          <h2 className="font-semibold mb-2">Zusammenarbeit der letzten Woche &amp; Top-Chancen je Kunde</h2>
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
        </section>
      )}

      {d.view === "PRINCIPAL" && (
        <section className="card">
          <h2 className="font-semibold mb-2">Hinweise der KI: möglicherweise neue Chancen ({d.opportunityHints.length})</h2>
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
        </section>
      )}

      {d.view === "BD" && d.bdPerformance && (
        <section className="card">
          <h2 className="font-semibold mb-2">Meine Performance</h2>
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
        </section>
      )}

      {d.view === "ANKER" && (
        <section className="card">
          <h2 className="font-semibold mb-2">Smart-Dump: Text einfügen</h2>
          <p className="muted text-sm mb-2">Notiz, E-Mail-Ausschnitt oder Gedächtnisprotokoll direkt einfügen – die KI schlägt daraus wie gewohnt Karten vor (Beobachtung, Person, Aktion, …), mit Textstelle belegt. Gespeichert wird nichts automatisch; die Vorschläge werden im Setup geprüft.</p>
          {d.accounts.every((c) => c.setups.length === 0) ? (
            <p className="muted text-sm">Noch kein Setup, dem ein Text zugeordnet werden könnte.</p>
          ) : (
            <form action={smartDumpAction} className="grid gap-3 text-sm">
              <div>
                <label className="label" htmlFor="dumpSetup">Setup</label>
                <select id="dumpSetup" name="setupId" className="select" required defaultValue="">
                  <option value="">– wählen –</option>
                  {d.accounts.map((c) => c.setups.map((s) => <option key={s.setupId} value={s.setupId}>{c.accountName} · {s.setupName}</option>))}
                </select>
              </div>
              <div><label className="label" htmlFor="dumpTitle">Titel (optional)</label><input id="dumpTitle" name="title" className="input" maxLength={200} /></div>
              <div><label className="label" htmlFor="dumpText">Text</label><textarea id="dumpText" name="text" className="textarea" required minLength={12} rows={6} placeholder="Text einfügen …" /></div>
              <div><button className="btn" type="submit">Einfügen und Vorschläge erzeugen</button></div>
            </form>
          )}
        </section>
      )}

      {d.view === "BD" && (
        <section className="card">
          <h2 className="font-semibold mb-2">Neue Idee zu einer Opportunity eintragen</h2>
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
        </section>
      )}

      <p className="muted text-xs">{d.note}</p>
    </div>
  );
}
