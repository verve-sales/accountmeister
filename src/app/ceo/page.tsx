import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { hasRole } from "@/modules/identity/actor";
import { buildCeoDashboard } from "@/modules/ceo/service";
import { maturityLabel } from "@/modules/strategy/chancen";
import { BarChart, GroupedBarChart } from "@/components/charts/BarChart";
import { Status } from "@/components/Status";
import { fmtDate, goalStatusLabel } from "@/lib/labels";
import { getFocus } from "@/modules/focus/service";
import { freelancerStatsByBd } from "@/modules/focus/standardTasks";
import { computeHealthFor } from "@/modules/health/service";
import { HealthBadge } from "@/components/HealthBadge";

export default async function CeoDashboardPage() {
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  if (!hasRole(actor, "CEO")) redirect("/start");
  const d = await buildCeoDashboard(actor);
  const focus = await getFocus(actor.workspaceId);
  const flByBd = focus.freelancerLever ? await freelancerStatsByBd(actor.workspaceId) : [];
  // Portfolio-Matrix: viele Einsätze und wacklige Position zuerst (Priorität = Einsätze × (100 − Score))
  const health = (await computeHealthFor(d.accounts.map((a) => ({ id: a.accountId, name: a.accountName })))).sort((x, y) => y.engagements.length * (100 - (y.score ?? 50)) - x.engagements.length * (100 - (x.score ?? 50)));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-semibold">CEO-Dashboard</h1>
        <span className="muted text-sm">Aktivität der letzten {d.sinceDays} Tage (seit {fmtDate(d.since)}) · <Link href="/ziele">Zu Ziele &amp; Portfolio</Link></span>
      </div>

      {d.accounts.length === 0 ? (
        <p className="card text-sm">Keine sichtbaren Kunden.</p>
      ) : (
        <div className="grid lg:grid-cols-2 gap-6">
          <section className="card">
            <h2 className="font-semibold mb-2">Aktivitätskoeffizient je Kunde</h2>
            <BarChart title="Aktivitätskoeffizient je Kunde" bars={d.accounts.map((a) => ({ label: a.accountName, value: a.activity.coefficient, detail: "Aktivitätskoeffizient" }))} />
          </section>
          {(() => {
            const goalBars = d.accounts.flatMap((a) => a.goals.filter((g) => g.targetHeadcount != null).map((g) => ({ label: g.roleFamilyLabel ? `${g.roleFamilyLabel} · ${a.accountName}` : a.accountName, values: [g.currentHeadcount ?? 0, g.targetHeadcount as number] as [number, number], detail: g.title })));
            return goalBars.length > 0 ? (
              <section className="card">
                <h2 className="font-semibold mb-2">Ist- vs. Zielbild (Positionen)</h2>
                <GroupedBarChart title="Ist- vs. Zielbild" legend={["Ist", "Ziel"]} bars={goalBars} />
              </section>
            ) : null;
          })()}
        </div>
      )}

      {health.length > 0 && (
        <section className="card">
          <h2 className="font-semibold mb-2">Sattelfestigkeit je Kunde (Health-Check)</h2>
          <table className="list">
            <thead><tr><th>Kunde</th><th>Sattelfestigkeit</th><th style={{ textAlign: "right" }}>Einsätze</th><th>Nächstes Ende</th><th>Offene Fragen</th></tr></thead>
            <tbody>
              {health.map((h) => (
                <tr key={h.accountId}>
                  <td><Link href={`/kunden/${h.accountId}/health`}>{h.accountName}</Link></td>
                  <td><HealthBadge score={h.score} level={h.level} coverage={h.coverage} /> <span className="muted text-xs">Datenlage {h.coverage} %</span></td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{h.engagements.length}</td>
                  <td className="text-sm">{h.engagements.find((e) => e.plannedEnd)?.plannedEnd ? fmtDate(h.engagements.find((e) => e.plannedEnd)!.plannedEnd) : "–"}</td>
                  <td style={{ fontVariantNumeric: "tabular-nums" }}>{h.questions.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted text-xs mt-2">Sortiert nach Handlungsbedarf: viele Einsätze bei niedriger Sattelfestigkeit zuerst. Transparente Regeln, Begründung je Kunde im Health-Check.</p>
        </section>
      )}

      {flByBd.length > 0 && (
        <section className="card">
          <h2 className="font-semibold mb-2">Freelancer-Hebel je BD (strategischer Fokus)</h2>
          <table className="list">
            <thead><tr><th>BD</th><th style={{ textAlign: "right" }}>Kunden</th><th style={{ textAlign: "right" }}>offene Freelancer-Chancen</th><th style={{ textAlign: "right" }}>neu (90 Tage)</th><th style={{ textAlign: "right" }}>vorgestellt (90 Tage)</th><th style={{ textAlign: "right" }}>Kunden ohne Freelancer-Chance</th></tr></thead>
            <tbody>
              {flByBd.map((r) => (
                <tr key={r.bdName}>
                  <td>{r.bdName}</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{r.accounts}</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{r.openFreelancerChances}</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{r.newFreelancerChances90d}</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{r.presentedOffers90d}</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{r.accountsWithoutFreelancerChance}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted text-xs mt-2">Zählungen aus dokumentierten Chancen und Angeboten der Art „Freelancer-Experte“ je zuständigem BD der aktiven Kunden.</p>
        </section>
      )}

      {d.accounts.length === 0 ? null : (
        <div className="space-y-4">
          {d.accounts.map((a) => (
            <article key={a.accountId} className="card">
              <div className="flex flex-wrap items-baseline gap-3">
                <h2 className="font-semibold text-lg">
                  <Link href={`/kunden/${a.accountId}`}>{a.accountName}</Link>
                </h2>
                <span className="muted text-sm">{a.responsibleBd ? `BD ${a.responsibleBd}` : "BD offen"}{a.lastConfirmedWeekly ? ` · letztes Weekly ${fmtDate(a.lastConfirmedWeekly)}` : " · noch kein bestätigtes Weekly"}</span>
                <span className="ml-auto text-sm">
                  Aktivitätskoeffizient <strong>{a.activity.coefficient}</strong>
                </span>
              </div>

              <div className="grid lg:grid-cols-3 gap-4 mt-3 text-sm">
                {/* Accountziele vs. dokumentierte Positionen */}
                <div>
                  <div className="font-medium mb-1">Ziele vs. Ist-Stand</div>
                  {a.goals.length === 0 ? (
                    <p className="muted">Keine laufenden Accountziele.</p>
                  ) : (
                    <ul className="space-y-1">
                      {a.goals.map((g) => (
                        <li key={g.id}>
                          {g.title} <Status label={goalStatusLabel[g.status] ?? g.status} />
                          {g.targetHeadcount != null && (
                            <div className="muted text-xs">
                              {g.currentHeadcount ?? 0} von {g.targetHeadcount} Position(en){g.roleFamilyLabel ? ` (${g.roleFamilyLabel})` : ""}{g.horizon ? ` · bis ${g.horizon}` : ""}
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {/* Top-Chancen */}
                <div>
                  <div className="font-medium mb-1">Top-Chancen</div>
                  {a.topOpportunities.length === 0 ? (
                    <p className="muted">Keine aktiven Chancen dokumentiert.</p>
                  ) : (
                    <ul className="space-y-1">
                      {a.topOpportunities.map((o) => (
                        <li key={o.id}>
                          {o.title} <span className="muted">· {maturityLabel[o.maturity]}{o.headcount > 1 ? ` · ${o.headcount} Positionen` : ""}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {/* Zusammenarbeit der letzten Woche */}
                <div>
                  <div className="font-medium mb-1">Zusammenarbeit diese Woche</div>
                  <ul className="space-y-1">
                    {(["PRINCIPAL", "BD", "ANKER"] as const).map((role) => {
                      const c = a.activity.byRole[role];
                      const total = c.weeklysBestaetigt + c.beobachtungenErfasst + c.aktionenErfasstOderErledigt + c.vorschlaegeEntschieden + c.kontakteGepflegt;
                      return (
                        <li key={role}>
                          {role === "BD" ? "BD Manager" : role === "ANKER" ? "Anker" : "Principal"}: {total ? <strong>{total}</strong> : <span className="muted">0</span>}
                        </li>
                      );
                    })}
                  </ul>
                  <p className="muted text-xs mt-1">{a.activity.note}</p>
                </div>
              </div>

              {(a.openChanges != null || a.blockedActions != null || a.openSupport != null) && (
                <p className="muted text-xs mt-3">
                  Aus dem Accountplan: {a.openChanges ?? 0} offene Veränderung(en) · {a.blockedActions ?? 0} blockierte Aktion(en) · {a.openSupport ?? 0} offene Unterstützungsanfrage(n).
                </p>
              )}
            </article>
          ))}
        </div>
      )}

      {d.leadershipGoals.length > 0 && (
        <section className="card">
          <h2 className="font-semibold mb-2">Führungsziele ohne Kundenzuordnung ({d.leadershipGoals.length})</h2>
          <ul className="space-y-1 text-sm">
            {d.leadershipGoals.map((g) => (
              <li key={g.id}>
                <Link href={`/ziele/${g.id}`}>{g.title}</Link> <Status label={goalStatusLabel[g.status] ?? g.status} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="muted text-xs">{d.note}</p>
    </div>
  );
}
