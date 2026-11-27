import Link from "next/link";
import { Hint } from "@/components/Hint";
import { Icon } from "@/components/Icon";
import { notFound, redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { buildPrincipalOverview, canSetTargets, levelLabel, shiftQuarter } from "@/modules/principals/service";
import { Feedback } from "@/components/Feedback";
import { TargetProgress } from "@/components/TargetProgress";
import { fmtDate } from "@/lib/labels";

/** „Meine Principals“ (Etappe 38): je Principal Köpfe, Neukunden und Verlängerungsquote gegen die Quartalsziele – Einstieg ins Gespräch. */
export default async function MeinePrincipalsPage({ searchParams }: { searchParams: Promise<{ fehler?: string; ok?: string; q?: string }> }) {
  const sp = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  if (!canSetTargets(actor)) notFound();
  const { quarter: q, rows } = await buildPrincipalOverview(actor, sp.q ?? null);
  const ref = rows[0]?.actuals.ref ?? null;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-semibold">Kundenverantwortliche</h1>
        <span className="muted text-sm">{q.label} · {(() => { const t = new Date().toISOString().slice(0, 10); return t < q.start ? "Quartal hat noch nicht begonnen" : t > q.end || ref === q.end ? `Stichtag ${fmtDate(q.end)}` : `Stand heute, Stichtag ${fmtDate(q.end)}`; })()}</span>
        <span className="ml-auto text-sm flex gap-3">
          <Link href={`/meine-principals?q=${shiftQuarter(q, -1).key}`}>← {shiftQuarter(q, -1).label}</Link>
          <Link href={`/meine-principals?q=${shiftQuarter(q, 1).key}`}>{shiftQuarter(q, 1).label} →</Link>
        </span>
      </div>
      <Feedback params={sp} />
      {rows.length === 0 ? (
        <section className="card empty-state">
          <Icon name="users" size={28} />
          <div>
            <h2 className="font-semibold">Noch keine Kundenverantwortung vergeben</h2>
            <p className="muted text-sm">Sobald Principals Kunden zugeordnet sind, stehen hier je Person Ziel und Stand des Quartals: Köpfe, Neukunden und Verlängerungsquote.</p>
            {actor.roles.has("ADMIN") ? <Link href="/verwaltung/rollen" className="btn btn-small mt-2">Rolle zuweisen</Link> : <p className="muted text-xs mt-1">Eine Principal-Rolle für den ganzen Arbeitsraum gibt Rechte bei allen Kunden, macht aber noch nicht verantwortlich. Vergeben wird die Verantwortung in der Verwaltung unter „Rolle zuweisen“ (Principal, Stufe und Kunde).</p>}
          </div>
        </section>
      ) : (
        <section className="card">
          <table className="list text-sm">
            <thead><tr><th>Kundenverantwortlich</th><th>Kunden</th><th>Köpfe</th><th>Neukunden</th><th>Verlängerungsquote</th><th>Vereinbarungen</th><th>Verlängerungen offen</th><th></th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.principal.userId}>
                  <td><Link href={`/meine-principals/${r.principal.userId}?q=${q.key}`}><strong>{r.principal.name}</strong></Link><div className="muted text-xs">{levelLabel[r.principal.level]}</div></td>
                  <td style={{ fontVariantNumeric: "tabular-nums" }}>{r.principal.accountIds.length}</td>
                  <td><TargetProgress actual={r.actuals.ref ? r.actuals.headsTotal : null} target={r.targets.headsTotal} /></td>
                  <td><TargetProgress actual={r.actuals.ref ? r.actuals.newCustomers.length : null} target={r.targets.newCustomers} /></td>
                  <td><TargetProgress actual={r.actuals.renewals.quote} target={r.targets.renewalQuote} unit=" %" hint={`${r.actuals.renewals.confirmed} bestätigt, ${r.actuals.renewals.rejected} nicht verlängert`} /></td>
                  <td className="text-xs">{r.openAgreements ? <>{r.openAgreements} offen{r.overdueAgreements ? <span style={{ color: "var(--danger)", fontWeight: 600 }}> · {r.overdueAgreements} überfällig</span> : null}</> : <span className="muted">–</span>}</td>
                  <td className="text-xs">{r.openRenewals ? <span style={{ color: "#b7791f", fontWeight: 600 }}>{r.openRenewals}</span> : <span className="muted">–</span>}</td>
                  <td><Link href={`/meine-principals/${r.principal.userId}?q=${q.key}`} className="btn btn-small">Gespräch</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      <Hint>Köpfe: verschiedene Personen mit laufendem Einsatz am Stichtag, summiert über die Kunden des Principals (Ziel = Summe der Kundenziele). Neukunden: erster Einsatz beim Kunden beginnt im Quartal. Verlängerungsquote: im Quartal entschiedene Verlängerungen, bestätigt ÷ (bestätigt + nicht verlängert). Kein Umsatz.</Hint>
    </div>
  );
}
