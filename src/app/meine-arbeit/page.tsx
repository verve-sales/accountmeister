import Link from "next/link";
import { Hint } from "@/components/Hint";
import { TechRef } from "@/components/TechDetails";
import { Term } from "@/components/Term";
import { redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { ensureStandardTasksSafe } from "@/modules/focus/standardTasks";
import { ensureInitiativeRemindersSafe } from "@/modules/agenda/service";
import { ensureRenewalRunsSafe } from "@/modules/health/renewal";
import { listMySetups } from "@/modules/setups/service";
import { listMyOpenActions } from "@/modules/actions/service";
import { listMyHandovers } from "@/modules/handovers/service";
import { listReviews } from "@/modules/reviews/service";
import { listMySupportRequests } from "@/modules/leadership/service";
import { listMyOpportunities } from "@/modules/opportunities/service";
import { getProviderStatus, listMySuggestions } from "@/modules/suggestions/service";
import { SuggestionCard } from "@/components/SuggestionCard";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { Feedback } from "@/components/Feedback";
import { Status } from "@/components/Status";
import { actionStatusLabel, fmtDate, handoverStatusLabel, reviewStatusLabel, setupStatusLabel, supportStatusLabel, opportunityStatusLabel } from "@/lib/labels";
import { listMyWork, workFilterValues, workTargets, ensureOverdueNotificationsSafe, type WorkFilter } from "@/modules/work/service";
import { WorkList } from "@/components/Work";
import { listMyCheckins, listRenewalCards } from "@/modules/engagements/care";
import { RenewalCards } from "@/components/Renewal";
import { CheckinRow } from "@/components/Arbeitsliste";
import { plusDaysIso } from "@/modules/work/calendar";
import { getConfig } from "@/lib/config";
import { WorkCreateForm } from "@/components/WorkCreateForm";
import { bulkActionStatusAction, changeActionStatusAction, respondHandoverAction, respondSupportRequestAction } from "../actions";

const TABS = [
  { key: "mir", label: "Mir zugewiesen" },
  { key: "beauftragt", label: "Von mir beauftragt" },
  { key: "team", label: "Team-Eingang" },
  { key: "beobachtet", label: "Beobachtet" },
] as const;
const FILTERS = [
  { key: "alle", label: "alle" },
  { key: "heute", label: "heute fällig" },
  { key: "ueberfaellig", label: "überfällig" },
  { key: "woche", label: "diese Woche" },
] as const;

export default async function MeineArbeitPage({ searchParams }: { searchParams: Promise<{ fehler?: string; ok?: string; v?: string; f?: string }> }) {
  const params = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  // Fällige Standardaufgaben (Fokus Freelancer) vor dem Laden der Aktionen erzeugen
  await ensureStandardTasksSafe(actor);
  await ensureInitiativeRemindersSafe(actor);
  await ensureRenewalRunsSafe(actor);
  await ensureOverdueNotificationsSafe(actor);
  const tab = (TABS.find((t) => t.key === params.v)?.key ?? "beauftragt") as (typeof TABS)[number]["key"];
  const filter = (workFilterValues as readonly string[]).includes(params.f ?? "") ? (params.f as WorkFilter) : "alle";
  const [work, targets] = await Promise.all([listMyWork(actor, filter), workTargets(actor)]);
  const checkins = getConfig().FEATURE_BESETZUNG === "true" ? await listMyCheckins(actor) : [];
  const tabItems = { mir: work.assigned, beauftragt: work.requested, team: work.queue, beobachtet: work.watched }[tab];
  const tabCount = { mir: work.counts.assigned, beauftragt: work.counts.requested, team: work.counts.queue, beobachtet: work.counts.watched };
  const [setups, actions, handovers, reviews, support] = await Promise.all([listMySetups(actor), listMyOpenActions(actor), listMyHandovers(actor), listReviews(actor), listMySupportRequests(actor)]);
  const myOpportunities = await listMyOpportunities(actor);
  const openSupport = support.filter((s) => s.status === "ANGEFRAGT" || s.status === "ANGENOMMEN");
  const nextReviews = [...reviews.open, ...reviews.upcoming].slice(0, 5);
  const ai = getProviderStatus();
  const mySuggestions = ai.enabled ? await listMySuggestions(actor) : [];
  const allUsers = ai.enabled ? await db.query.users.findMany({ where: eq(schema.users.status, "ACTIVE") }) : [];
  const userNames = new Map(allUsers.map((u) => [u.id, u.displayName]));
  const openIncoming = handovers.filter((h) => h.receiverUserId === actor.userId && h.status === "ANGEFRAGT");
  const outgoing = handovers.filter((h) => h.senderUserId === actor.userId && (h.status === "ANGEFRAGT" || h.status === "ANGENOMMEN"));
  const back = "/meine-arbeit";
  const renewalCards = getConfig().FEATURE_BESETZUNG === "true" ? await listRenewalCards(actor).catch(() => []) : [];

  // e69 (E2): eine Liste für alles, was an mich geht – Aktionen, Vorgänge, Übernahmen, Unterstützungsaufträge
  const todayStr = new Date().toISOString().slice(0, 10);
  const others = [
    ...work.assigned.map((w) => ({ key: `w-${w.id}`, kind: "Vorgang", title: w.title, from: w.requesterName, context: w.accountName ?? "", status: w.status === "ANGEFRAGT" ? "angefragt" : w.status === "BLOCKIERT" ? "blockiert" : w.status === "ZUR_PRUEFUNG" ? "zur Prüfung" : "in Arbeit", due: w.dueDate, href: `/vorgaenge/${w.id}` })),
    ...openIncoming.map((h) => ({ key: `h-${h.id}`, kind: "Übernahme", title: h.responsibility, from: h.senderName, context: "", status: "angefragt", due: h.dueDate, href: "#uebernahmen" })),
    ...openSupport.filter((x) => x.isAddressee).map((x) => ({ key: `s-${x.id}`, kind: "Unterstützung", title: x.task, from: x.requesterName, context: x.setupName, status: x.status === "ANGEFRAGT" ? "angefragt" : "angenommen", due: (x as { dueDate?: string | null }).dueDate ?? null, href: "#unterstuetzung" })),
  ].sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"));
  // e65: gleiche Erläuterung bei vielen Standardaufgaben nur einmal aufklappbar statt in jeder Zeile
  const agreementCount = new Map<string, number>();
  for (const a of actions) if (a.agreement) agreementCount.set(a.agreement, (agreementCount.get(a.agreement) ?? 0) + 1);
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Meine Arbeit</h1>
      <Feedback params={params} />
      {/* e67: hier nur, was an mich geht – Verlängerungen des Teams stehen eingeklappt darunter (wie auf Start „im Blick“) */}
      <RenewalCards cards={renewalCards.filter((c) => c.forMe)} back="/meine-arbeit#entscheidungen" />
      {renewalCards.some((c) => !c.forMe) && (
        <details className="card">
          <summary className="font-semibold">Verlängerungen im Team ({renewalCards.filter((c) => !c.forMe).length}) <span className="muted text-sm font-normal">– zur Kenntnis, entscheiden die Zuständigen</span></summary>
          <div className="mt-2"><RenewalCards id="entscheidungen-team" cards={renewalCards.filter((c) => !c.forMe)} back="/meine-arbeit#entscheidungen" /></div>
        </details>
      )}

      <section className="card" id="aktionen">
        <h2 className="font-semibold mb-2">Meine Aufgaben ({actions.length + others.length})</h2>
        {actions.length + others.length === 0 ? (<p className="empty">Keine offenen Aufgaben.</p>
        ) : (
          <>
          {[...agreementCount.entries()].filter(([, n]) => n > 1).map(([text, n]) => (
            <div key={text} className="callout text-sm mb-3" style={{ flexWrap: "wrap" }}>
              <details style={{ flex: "1 1 20rem" }}>
                <summary><strong>{n} Aktionen mit gleichem Hintergrund</strong> <span className="muted">– worum es geht</span></summary>
                <p className="mt-1">{text}</p>
              </details>
              {actions.some((a) => a.agreement === text && a.status === "VORGESCHLAGEN") && (
                <form action={bulkActionStatusAction} className="flex gap-2 items-center">
                  <input type="hidden" name="back" value="/meine-arbeit#aktionen" />
                  {actions.filter((a) => a.agreement === text && a.status === "VORGESCHLAGEN").map((a) => <input key={a.id} type="hidden" name="item" value={`${a.id}:${a.version}`} />)}
                  <button className="btn btn-small" name="status" value="ANGENOMMEN">Alle {actions.filter((a) => a.agreement === text && a.status === "VORGESCHLAGEN").length} annehmen</button>
                  <button className="btn btn-secondary btn-small" name="status" value="VERWORFEN">Alle verwerfen</button>
                </form>
              )}
            </div>
          ))}
          <table className="list">
            <thead><tr><th>Aufgabe</th><th>Projekt · Kunde</th><th>Status</th><th>Fällig</th><th>Nächster Schritt</th></tr></thead>
            <tbody>
              {others.map((o) => (
                <tr key={o.key}>
                  <td><span className="chip" style={{ marginRight: 6 }}>{o.kind}</span>{o.title}{o.from && <div className="muted text-xs">von {o.from}</div>}</td>
                  <td>{o.context || "–"}</td>
                  <td><Status label={o.status} /></td>
                  <td style={o.due && o.due < todayStr ? { color: "var(--danger)" } : undefined}>{o.due ? fmtDate(o.due) : "–"}</td>
                  <td><Link href={o.href} className="btn btn-secondary btn-small">Öffnen</Link></td>
                </tr>
              ))}
              {actions.map((a) => (
                <tr key={a.id}>
                  <td><span className="chip" style={{ marginRight: 6 }}>Aktion</span>{a.title}{a.agreement && agreementCount.get(a.agreement)! === 1 && <div className="muted text-sm">{a.agreement}</div>}</td>
                  <td>{a.setupId ? <Link href={`/setups/${a.setupId}`}>{a.setupName}</Link> : "–"}</td>
                  <td><Status label={actionStatusLabel[a.status] ?? a.status} /></td>
                  <td>{fmtDate(a.dueDate)}</td>
                  <td>
                    <form action={changeActionStatusAction} className="row-actions">
                      <input type="hidden" name="actionId" value={a.id} />
                      <input type="hidden" name="version" value={a.version} />
                      <input type="hidden" name="back" value={back} />
                      {a.status === "VORGESCHLAGEN" ? <button className="btn btn-small" name="status" value="ANGENOMMEN">Annehmen</button> : <button className="btn btn-small" name="status" value="ERLEDIGT">Erledigt</button>}
                      <details className="row-more">
                        <summary className="btn btn-secondary btn-small" aria-label="Weitere Aktionen">Mehr</summary>
                        <div className="row-more-menu">
                          <input name="result" className="input" placeholder="Ergebnis / Blocker" aria-label="Ergebnis oder Blocker" />
                          {(a.status === "ANGENOMMEN" || a.status === "BLOCKIERT") && <button className="btn btn-secondary btn-small" name="status" value="IN_ARBEIT">In Arbeit</button>}
                          {(a.status === "ANGENOMMEN" || a.status === "IN_ARBEIT") && <button className="btn btn-secondary btn-small" name="status" value="BLOCKIERT">Blockiert</button>}
                          {a.status !== "VORGESCHLAGEN" && <button className="btn btn-secondary btn-small" name="status" value="ERLEDIGT">Erledigt mit Ergebnis</button>}
                          <button className="btn btn-secondary btn-small" name="status" value="VERWORFEN">Verwerfen</button>
                        </div>
                      </details>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </>
        )}
      </section>

      <section className="card" id="vorgaenge">
        <div className="flex flex-wrap items-baseline gap-2 mb-2">
          <h2 className="font-semibold">Vorgänge</h2>
          <span className="muted text-xs">Aufträge an andere und an Teams; was an dich geht, steht unter „Meine Aufgaben“.</span>
          {work.myTeams.map((t) => (
            <Link key={t.id} href={`/team/${t.id}`} className="text-xs">
              Eingang {t.name}
            </Link>
          ))}
        </div>
        <nav aria-label="Ansicht" className="flex flex-wrap gap-2 text-sm mb-2">
          {TABS.filter((t) => t.key !== "team" || work.myTeams.length).map((t) => (
            <Link key={t.key} href={`/meine-arbeit?v=${t.key}&f=${filter}#vorgaenge`} className="chip" aria-current={tab === t.key ? "page" : undefined}>
              {t.label} ({tabCount[t.key]})
            </Link>
          ))}
        </nav>
        <nav aria-label="Filter" className="flex flex-wrap gap-3 text-xs mb-3">
          {FILTERS.map((f) => (
            <Link key={f.key} href={`/meine-arbeit?v=${tab}&f=${f.key}#vorgaenge`} style={filter === f.key ? { fontWeight: 700 } : undefined}>
              {f.label}
            </Link>
          ))}
        </nav>
        <WorkList items={tabItems} empty={filter === "alle" ? "Nichts offen." : "Nichts in diesem Filter."} perspective={tab === "mir" ? "assignee" : tab === "beauftragt" ? "requester" : "queue"} />
        <details className="mt-3">
          <summary>Neuer Vorgang<Term k="VORGANG" /></summary>
          <WorkCreateForm users={targets.users} teams={targets.teams} back="/meine-arbeit?v=beauftragt#vorgaenge" idPrefix="ma" />
        </details>
      </section>

      {checkins.length > 0 && (() => {
        const today = new Date().toISOString().slice(0, 10);
        const soon = checkins.filter((c) => c.overdue || c.dueDate <= plusDaysIso(today, 7));
        const later = checkins.filter((c) => !soon.includes(c));
        return (
          <section className="card" id="checkins">
            <details open={soon.length > 0}>
              <summary className="font-semibold">Meine Check-ins ({checkins.length}){soon.length ? ` – ${soon.length} fällig bis ${fmtDate(plusDaysIso(today, 7))}` : " – nichts in den nächsten 7 Tagen"}</summary>
              <Hint>Ein Klick auf die Stimmung erledigt den Check-in mit heutigem Datum; der nächste wird automatisch nach dem eingestellten Abstand (Standard 6 Wochen) fällig. Details (Termin, Ergebnis, Sales-Hinweis) über „mehr“.</Hint>
              <ul className="space-y-2 text-sm">{soon.map((c) => <CheckinRow key={c.id} c={c} back="/meine-arbeit#checkins" />)}</ul>
              {later.length > 0 && (
                <details className="mt-2">
                  <summary className="text-sm muted">Später fällig ({later.length})</summary>
                  <ul className="space-y-2 text-sm mt-2">{later.map((c) => <CheckinRow key={c.id} c={c} back="/meine-arbeit#checkins" />)}</ul>
                </details>
              )}
            </details>
          </section>
        );
      })()}

      <section className="card" id="uebernahmen">
        {openIncoming.length === 0 ? (<p className="muted text-sm"><strong className="text-[var(--text)]">Offene Übernahmen an mich:</strong> keine.</p>
        ) : (
          <>
          <h2 className="font-semibold mb-2">Offene Übernahmen an mich ({openIncoming.length})</h2>
          <ul className="space-y-3">
            {openIncoming.map((h) => (
              <li key={h.id} className="border rounded-md p-3" style={{ borderColor: "var(--border)" }}>
                <div className="flex flex-wrap gap-2 items-baseline">
                  <strong>{h.responsibility}</strong>
                  <Status label={handoverStatusLabel[h.status] ?? h.status} />
                  <span className="muted text-sm">von {h.senderName} · Termin {fmtDate(h.dueDate)}</span>
                </div>
                <p className="text-sm mt-1">{h.context}</p>
                <dl className="text-sm mt-2 grid sm:grid-cols-2 gap-x-6 gap-y-1">
                  <div><dt className="muted">Belegt</dt><dd>{h.proven ?? "–"}</dd></div>
                  <div><dt className="muted">Offen</dt><dd>{h.open ?? "–"}</dd></div>
                  <div><dt className="muted">Darf verwendet werden</dt><dd>{h.allowedUse ?? "–"}</dd></div>
                  <div><dt className="muted">Rückmeldung über</dt><dd>{h.feedbackChannel ?? "–"}</dd></div>
                </dl>
                {h.setupId && <p className="text-sm mt-1"><Link href={`/setups/${h.setupId}`}>Zum Projekt</Link></p>}
                <form action={respondHandoverAction} className="mt-3 flex flex-wrap gap-2 items-end">
                  <input type="hidden" name="handoverId" value={h.id} />
                  <input type="hidden" name="version" value={h.version} />
                  <input type="hidden" name="back" value={back} />
                  <div className="grow min-w-60">
                    <label className="label" htmlFor={`note-${h.id}`}>Rückfrage / Begründung (bei Rückgabe erforderlich)</label>
                    <input id={`note-${h.id}`} name="responseNote" className="input" />
                  </div>
                  <button className="btn btn-small" type="submit" name="decision" value="ANNEHMEN">Annehmen</button>
                  <button className="btn btn-secondary btn-small" type="submit" name="decision" value="ZURUECKGEBEN">Zurückgeben</button>
                </form>
              </li>
            ))}
          </ul>
          </>
        )}
      </section>

      {openSupport.length > 0 && (
        <section className="card">
          <h2 className="font-semibold mb-2" id="unterstuetzung">Unterstützungsaufträge ({openSupport.length} offen)</h2>
          <ul className="space-y-2">
            {openSupport.map((s) => (
              <li key={s.id} className="border rounded-md p-3 text-sm" style={{ borderColor: "var(--border)" }}>
                <div className="flex flex-wrap gap-2 items-baseline"><strong>{s.task}</strong><Status label={supportStatusLabel[s.status] ?? s.status} /><span className="muted">{s.isAddressee ? `von ${s.requesterName}` : `an ${s.addresseeName}`}{s.setupName && <> · <Link href={`/setups/${s.setupId}`}>{s.setupName}</Link></>}{s.dueDate && ` · bis ${fmtDate(s.dueDate)}`}</span></div>
                {s.context && <p className="muted mt-1">{s.context}</p>}
                <form action={respondSupportRequestAction} className="mt-2 flex flex-wrap gap-1 items-end">
                  <input type="hidden" name="requestId" value={s.id} />
                  <input type="hidden" name="version" value={s.version} />
                  <input type="hidden" name="back" value={back} />
                  <input name="note" className="input" style={{ width: "18rem" }} placeholder="Ergebnis / Begründung" aria-label="Ergebnis oder Begründung" />
                  {s.isAddressee && s.status === "ANGEFRAGT" && <button className="btn btn-small" name="decision" value="ANNEHMEN">Annehmen</button>}
                  {s.isAddressee && s.status === "ANGENOMMEN" && <button className="btn btn-small" name="decision" value="ERLEDIGEN">Ergebnis melden</button>}
                  {s.isAddressee && <button className="btn btn-secondary btn-small" name="decision" value="ZURUECKGEBEN">Zurückgeben</button>}
                  {s.isRequester && s.status === "ANGEFRAGT" && <button className="btn btn-secondary btn-small" name="decision" value="ZURUECKZIEHEN">Zurückziehen</button>}
                </form>
              </li>
            ))}
          </ul>
        </section>
      )}


      {myOpportunities.filter((o) => o.status !== "BEAUFTRAGT").length > 0 && (
        <section className="card">
          <h2 className="font-semibold mb-2">Meine Chancen in Arbeit ({myOpportunities.filter((o) => o.status !== "BEAUFTRAGT").length}){myOpportunities.some((o) => o.status === "BEAUFTRAGT") ? <span className="muted text-sm font-normal"> · {myOpportunities.filter((o) => o.status === "BEAUFTRAGT").length} beauftragt – siehe <Link href="/einsaetze">Einsätze</Link></span> : null}</h2>
          <table className="list">
            <thead><tr><th>Chance</th><th>Kunde</th><th>Status</th><th>Geändert</th></tr></thead>
            <tbody>{myOpportunities.filter((o) => o.status !== "BEAUFTRAGT").map((o) => <tr key={o.id}><td><Link href={`/bedarfe/${o.id}`}>{o.title}</Link>{o.fastTrack && <span className="muted text-sm"> · direkte Anfrage</span>}</td><td>{o.accountName}</td><td><Status label={opportunityStatusLabel[o.status] ?? o.status} /></td><td>{fmtDate(o.updatedAt)}</td></tr>)}</tbody>
          </table>
        </section>
      )}

      {getConfig().FEATURE_WEEKLYS === "true" && (
      <section className="card">
        {nextReviews.length === 0 ? <p className="muted text-sm"><strong className="text-[var(--text)]">Nächste Weeklys:</strong> keine anstehenden. <Link href="/weeklys">Weekly anlegen</Link></p> : (
          <>
          <h2 className="font-semibold mb-2">Nächste Weeklys ({nextReviews.length})</h2>
          <ul className="text-sm space-y-1">
            {nextReviews.map((r) => <li key={r.id}><Link href={`/weeklys/${r.id}`}>{r.title}</Link> · {fmtDate(r.scheduledFor)} · <Status label={reviewStatusLabel[r.status] ?? r.status} /></li>)}
          </ul>
          </>
        )}
      </section>
      )}

      <section className="card">
        <details>
        <summary className="font-semibold mb-2">Meine Projekte ({setups.length})</summary>
        {setups.length === 0 ? (<p className="empty">
            Noch keine Projekte. <Link href="/kunden">Zu den Kunden</Link>, um ein Projekt anzulegen.
          </p>
        ) : (
          <table className="list">
            <thead><tr><th>Projekt</th><th>Kunde</th><th>Status</th><th>BD</th><th>Zuletzt geändert</th></tr></thead>
            <tbody>
              {setups.map((s) => (
                <tr key={s.id}>
                  <td><Link href={`/setups/${s.id}`}>{s.name}</Link></td>
                  <td>{s.accountName}</td>
                  <td><Status label={setupStatusLabel[s.status] ?? s.status} /></td>
                  <td>{s.bdUserId ? "zugeordnet" : <Status label="Zuordnung offen" />}</td>
                  <td>{fmtDate(s.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        </details>
      </section>

      {outgoing.length > 0 && (
        <section className="card">
          <h2 className="font-semibold mb-2">Von mir angefragte Übergaben</h2>
          <ul className="text-sm space-y-1">
            {outgoing.map((h) => (
              <li key={h.id}>
                {h.responsibility} → {h.receiverName} · <Status label={handoverStatusLabel[h.status] ?? h.status} />
                {h.status === "ANGENOMMEN" && h.setupId && <> · <Link href={`/setups/${h.setupId}`}>Ergebnis im Projekt dokumentieren</Link></>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <details open={mySuggestions.length > 0 && mySuggestions.length <= 3}>
        <summary className="font-semibold mb-1">Vorschläge ({mySuggestions.length})</summary>
        {!ai.enabled ? (
          <p className="muted text-sm">KI-Anbieter ist deaktiviert. Es werden keine automatischen Vorschläge erzeugt; manuelle Dokumentation funktioniert vollständig <TechRef>Briefing 17.5</TechRef>.</p>
        ) : mySuggestions.length === 0 ? (<p className="empty">Keine offenen Vorschläge in deinen Projekten. Anbieter: {ai.description}</p>
        ) : (
          <ul className="space-y-3">{mySuggestions.map((x) => <SuggestionCard key={x.id} s={x} ownerName={x.proposedOwnerUserId ? userNames.get(x.proposedOwnerUserId) ?? null : null} canDecide back={back} users={allUsers} />)}</ul>
        )}
        </details>
      </section>
    </div>
  );
}
