import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { buildTalk, shiftQuarter } from "@/modules/principals/service";
import { DomainError } from "@/lib/errors";
import { Feedback } from "@/components/Feedback";
import { TargetProgress } from "@/components/TargetProgress";
import { fmtDate } from "@/lib/labels";
import { renewalStatusLabel } from "@/modules/engagements/care";
import { addPrincipalAgreementAction, savePrincipalTargetsAction } from "@/app/actions";

const RED = "#c0392b";
const AMBER = "#b7791f";

/** Gesprächsseite GF ↔ Principal (Etappe 38): Lage → Zahlen → offene Entscheidungen → Vereinbarungen. */
export default async function PrincipalTalkPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ fehler?: string; ok?: string; q?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  let t: Awaited<ReturnType<typeof buildTalk>>;
  try {
    t = await buildTalk(actor, id, sp.q ?? null);
  } catch (e) {
    if (e instanceof DomainError) notFound();
    throw e;
  }
  const { quarter: q, summary: s, canEdit } = t;
  const ref = s.actuals.ref;
  const base = `/meine-principals/${id}`;
  const formId = "ziele-form";
  const step = (n: number, title: string, note?: string) => (
    <h2 className="font-semibold text-lg flex flex-wrap items-baseline gap-2">
      <span className="muted">{n}</span> {title} {note ? <span className="muted text-sm font-normal">{note}</span> : null}
    </h2>
  );
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-semibold">{canEdit ? `Gespräch mit ${t.principal.name}` : "Meine Ziele als Principal"}</h1>
        <span className="muted text-sm">{q.label} · {ref ? (ref === q.end ? `Stichtag ${fmtDate(q.end)}` : `Stand heute, Stichtag ${fmtDate(q.end)}`) : "Quartal hat noch nicht begonnen"}</span>
        <span className="ml-auto text-sm flex gap-3">
          {canEdit && <Link href={`/meine-principals?q=${q.key}`}>Alle Principals</Link>}
          <Link href={`${base}?q=${shiftQuarter(q, -1).key}`}>← {shiftQuarter(q, -1).label}</Link>
          <Link href={`${base}?q=${shiftQuarter(q, 1).key}`}>{shiftQuarter(q, 1).label} →</Link>
        </span>
      </div>
      <Feedback params={sp} />
      {canEdit && <form id={formId} action={savePrincipalTargetsAction}><input type="hidden" name="principalUserId" value={id} /><input type="hidden" name="quarter" value={q.key} /></form>}

      <section className="card space-y-2" id="lage">
        {step(1, "Lage", `${t.lage.length} Kunden · ${t.bdCount} BDs`)}
        {t.lage.length === 0 ? <p className="muted text-sm">Keine Kunden zugeordnet.</p> : (
          <table className="list text-sm">
            <thead><tr><th>Kunde</th><th>BD</th><th>Köpfe heute</th><th>Nächstes Ende</th><th>Köpfe {ref === q.end ? "Stichtag" : "Ist"} / Ziel {q.label}</th></tr></thead>
            <tbody>
              {t.lage.map((a) => (
                <tr key={a.accountId}>
                  <td><Link href={`/meine-bds/${a.accountId}`}><strong>{a.name}</strong></Link></td>
                  <td className="text-xs">{a.bdName ?? <span style={{ color: AMBER }}>ohne BD</span>}</td>
                  <td style={{ fontVariantNumeric: "tabular-nums" }}>{a.headsNow}</td>
                  <td className="text-xs">{a.nextEnd ? fmtDate(a.nextEnd) : <span className="muted">–</span>}</td>
                  <td>
                    {canEdit ? (
                      <span className="flex items-center gap-2">
                        <span style={{ fontVariantNumeric: "tabular-nums", minWidth: 24 }}>{a.headsRef ?? "–"}</span>
                        <span className="muted">/</span>
                        <input form={formId} name={`head_${a.accountId}`} type="number" min={0} max={500} className="input" style={{ width: 72, padding: "2px 6px" }} defaultValue={a.headsTarget ?? ""} aria-label={`Ziel Köpfe ${a.name}`} />
                      </span>
                    ) : (
                      <TargetProgress actual={a.headsRef} target={a.headsTarget} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card space-y-3" id="zahlen">
        {step(2, "Zahlen", "gegen die Quartalsziele – kein Umsatz")}
        <div className="grid sm:grid-cols-3 gap-3">
          <div className="p-3" style={{ background: "var(--surface-2)", borderRadius: 8 }}>
            <div className="muted text-xs mb-1">Köpfe (Summe der Kunden)</div>
            <TargetProgress actual={ref ? s.actuals.headsTotal : null} target={s.targets.headsTotal} />
          </div>
          <div className="p-3" style={{ background: "var(--surface-2)", borderRadius: 8 }}>
            <div className="muted text-xs mb-1">Neukunden im Quartal</div>
            <TargetProgress actual={ref ? s.actuals.newCustomers.length : null} target={s.targets.newCustomers} />
            {s.actuals.newCustomers.length > 0 && <div className="text-xs mt-1">{s.actuals.newCustomers.map((n) => `${n.name} (seit ${fmtDate(n.since)})`).join(" · ")}</div>}
            {canEdit && <div className="mt-2 text-xs"><label htmlFor="nk">Ziel </label><input id="nk" form={formId} name="newCustomers" type="number" min={0} max={100} className="input" style={{ width: 72, padding: "2px 6px" }} defaultValue={s.targets.newCustomers ?? ""} /></div>}
          </div>
          <div className="p-3" style={{ background: "var(--surface-2)", borderRadius: 8 }}>
            <div className="muted text-xs mb-1">Verlängerungsquote</div>
            <TargetProgress actual={s.actuals.renewals.quote} target={s.targets.renewalQuote} unit=" %" />
            <div className="muted text-xs mt-1">{s.actuals.renewals.confirmed} bestätigt · {s.actuals.renewals.rejected} nicht verlängert</div>
            {canEdit && <div className="mt-2 text-xs"><label htmlFor="rq">Ziel in % </label><input id="rq" form={formId} name="renewalQuote" type="number" min={0} max={100} className="input" style={{ width: 72, padding: "2px 6px" }} defaultValue={s.targets.renewalQuote ?? ""} /></div>}
          </div>
        </div>
        {canEdit && <div className="flex flex-wrap items-center gap-3"><button form={formId} className="btn btn-small" type="submit">Ziele {q.label} speichern</button><span className="muted text-xs">Köpfe-Ziele je Kunde stehen oben in der Lage. Leeres Feld = kein Ziel.</span></div>}
      </section>

      <section className="card space-y-2" id="entscheidungen">
        {step(3, "Offene Entscheidungen", t.openDecisions.length ? `${t.openDecisions.length} Verlängerung(en)` : undefined)}
        {t.openDecisions.length === 0 ? <p className="muted text-sm">Keine offenen Verlängerungen bei den Kunden.</p> : (
          <ul className="space-y-1 text-sm">
            {t.openDecisions.map((d) => (
              <li key={d.engagementId}>
                <Link href={`/einsaetze/${d.engagementId}#verlaengerung`}><strong>{d.person}</strong> · {d.accountName}</Link>
                <span className="muted"> · {renewalStatusLabel[d.status] ?? d.status}{d.proposedTo ? ` bis ${fmtDate(d.proposedTo)}` : ""}{d.bdName ? ` · BD ${d.bdName}` : ""}</span>
                {d.daysToEnd !== null && <span style={d.daysToEnd < 28 ? { color: RED, fontWeight: 600 } : undefined}> · Ende in {d.daysToEnd} Tagen</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card space-y-2" id="vereinbarungen">
        {step(4, "Vereinbarungen", "jede wird ein Vorgang mit Frist beim Principal")}
        {t.agreements.length === 0 ? <p className="muted text-sm">Noch keine Vereinbarungen.</p> : (
          <ul className="space-y-1 text-sm">
            {t.agreements.map((a) => (
              <li key={a.id} style={a.done ? { opacity: 0.6 } : undefined}>
                <span className="status mr-2">{a.done ? "erledigt" : a.overdue ? "überfällig" : "offen"}</span>
                {a.workItemId ? <Link href={`/vorgaenge/${a.workItemId}`}>{a.text}</Link> : a.text}
                <span className="muted"> · Frist {a.dueDate ? fmtDate(a.dueDate) : "–"} · {a.quarter.replace(/(\d{4})-Q(\d)/, "Q$2 $1")}</span>
                {a.overdue && <span style={{ color: RED, fontWeight: 600 }}> · überfällig</span>}
              </li>
            ))}
          </ul>
        )}
        {canEdit && (
          <form action={addPrincipalAgreementAction} className="flex flex-wrap gap-2 items-end text-sm pt-2">
            <input type="hidden" name="principalUserId" value={id} />
            <input type="hidden" name="quarter" value={q.key} />
            <div style={{ flex: "1 1 22rem" }}><label className="label" htmlFor="ag-text">Vereinbarung</label><input id="ag-text" name="text" className="input" required minLength={3} maxLength={1000} placeholder="z. B. Bei Nordlicht zwei weitere Köpfe über das Testteam platzieren" /></div>
            <div><label className="label" htmlFor="ag-due">Frist</label><input id="ag-due" name="dueDate" type="date" className="input" required /></div>
            <button className="btn" type="submit">Festhalten</button>
          </form>
        )}
      </section>
    </div>
  );
}
