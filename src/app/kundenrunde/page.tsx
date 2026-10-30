import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { accountKindLabel, ampelLabel, buildRound, canSeeRound, type Ampel, type RoundAccount } from "@/modules/rounds/service";
import { levelLabel } from "@/modules/principals/service";
import { HealthBadge } from "@/components/HealthBadge";
import { Feedback } from "@/components/Feedback";
import { PendingButton } from "@/components/PendingButton";
import { fmtDate, fmtDateTime } from "@/lib/labels";
import { closeRoundAction, prepareRoundNoteAction } from "@/app/actions";

const COLOR: Record<Ampel, string> = { ROT: "#c0392b", GELB: "#b7791f", GRUEN: "#2f7d4f" };

function Dot({ a }: { a: Ampel }) {
  return <span aria-label={`Ampel ${ampelLabel[a]}`} title={`Ampel ${ampelLabel[a]}`} style={{ display: "inline-block", width: 12, height: 12, borderRadius: 999, background: COLOR[a], flexShrink: 0, marginTop: 4 }} />;
}

function Prep({ accountId, prep, mayPrepare, compact }: { accountId: string; prep: RoundAccount["prep"]; mayPrepare: boolean; compact?: boolean }) {
  return (
    <div className="text-sm mt-2">
      {prep && <p><span style={{ color: COLOR.GRUEN, fontWeight: 600 }}>✓ bestätigt</span> <span className="muted">von {prep.authorName}, {fmtDateTime(prep.at)}</span>{prep.note ? <> – {prep.note}</> : null}</p>}
      {mayPrepare && (
        <form action={prepareRoundNoteAction} className="flex flex-wrap gap-2 items-center mt-1">
          <input type="hidden" name="accountId" value={accountId} />
          <input name="note" className="input" style={{ flex: compact ? "1 1 14rem" : "1 1 24rem", padding: "2px 8px" }} maxLength={600} placeholder={prep ? "Satz ändern (optional)" : "Ein Satz zur Lage (optional)"} defaultValue={prep?.note ?? ""} aria-label="Kommentar für die Runde" />
          <PendingButton className={prep ? "btn btn-secondary btn-small" : "btn btn-small"} busy="…">{prep ? "Aktualisieren" : "Bestätigen"}</PendingButton>
        </form>
      )}
    </div>
  );
}

/** Kundenrunde (Etappe 45): alle zwei Wochen GF mit den Kundenverantwortlichen – Rot und Gelb zuerst, Grün nur bestätigen. */
export default async function KundenrundePage({ searchParams }: { searchParams: Promise<{ fehler?: string; ok?: string }> }) {
  const sp = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  if (!canSeeRound(actor)) notFound();
  const r = await buildRound(actor);
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-semibold">Kundenrunde</h1>
        <span className="muted text-sm">{r.lastRound ? `seit der letzten Runde am ${fmtDate(r.lastRound.heldOn)}` : `noch keine Runde abgeschlossen – „neu“ heißt: seit ${fmtDate(r.since)}`}</span>
      </div>
      <Feedback params={sp} />
      <section className="card flex flex-wrap gap-6 items-center text-sm">
        <span><strong className="text-xl">{r.stats.accounts}</strong> Bestandskunden</span>
        <span style={{ color: COLOR.ROT }}><strong className="text-xl">{r.stats.red}</strong> rot</span>
        <span style={{ color: COLOR.GELB }}><strong className="text-xl">{r.stats.yellow}</strong> gelb</span>
        <span><strong className="text-xl">{r.stats.prepared}</strong> von {r.stats.accounts} vorbereitet</span>
        {r.isGf && (
          <details className="ml-auto">
            <summary className="btn btn-secondary btn-small" style={{ listStyle: "none" }}>Runde abschließen</summary>
            <form action={closeRoundAction} className="flex flex-wrap gap-2 items-end mt-2">
              <div><label className="label" htmlFor="heldOn">Gehalten am</label><input id="heldOn" name="heldOn" type="date" className="input" /></div>
              <div><label className="label" htmlFor="rNote">Notiz (optional)</label><input id="rNote" name="note" className="input" style={{ width: "18rem" }} /></div>
              <button className="btn btn-small" type="submit">Abschließen</button>
            </form>
          </details>
        )}
      </section>
      <p className="muted text-xs">In der Runde: Kunden mit laufenden Einsätzen, ohne Nebengeschäft. Rot: Health-Check gefährdet oder Einsatz endet in höchstens 4 Wochen ohne Klärung. Gelb: wackelig, zu wenig Daten, Ende in 90 Tagen offen oder weniger Köpfe als bei der letzten Runde. Alles ist aus dem Tool vorbefüllt – die Verantwortlichen bestätigen je Kunde.</p>

      {r.groups.length === 0 && <p className="card muted text-sm">Keine Bestandskunden in deiner Verantwortung.</p>}
      {r.groups.map((g) => {
        const attention = g.accounts.filter((a) => a.ampel !== "GRUEN");
        const green = g.accounts.filter((a) => a.ampel === "GRUEN");
        return (
          <section key={g.userId ?? "ohne"} className="card space-y-3">
            <h2 className="font-semibold text-lg">
              {g.name}
              {g.level && <span className="muted text-sm font-normal"> · {levelLabel[g.level]}</span>}
              <span className="muted text-sm font-normal"> · {g.accounts.length} Kunden · {g.accounts.filter((a) => a.prep).length} vorbereitet</span>
            </h2>
            {g.userId === null && <p className="text-sm" style={{ color: COLOR.GELB }}>Diese Bestandskunden haben noch keine Kundenverantwortung (Verwaltung → Rolle zuweisen → Principal mit Stufe und Kunde).</p>}
            {attention.map((a) => (
              <article key={a.accountId} id={`k-${a.accountId}`} className="p-3" style={{ border: "1px solid var(--border)", borderLeft: `4px solid ${COLOR[a.ampel]}`, borderRadius: 8 }}>
                <div className="flex items-start gap-3">
                  <Dot a={a.ampel} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="flex flex-wrap items-baseline gap-3">
                      <Link href={`/kunden/${a.accountId}`}><strong>{a.name}</strong></Link>
                      {a.health && <HealthBadge score={a.health.score} level={a.health.level} coverage={a.health.coverage} />}
                    </div>
                    <ul className="text-sm mt-1" style={{ color: COLOR[a.ampel] }}>{a.reasons.map((x, i) => <li key={i}>{x}</li>)}</ul>
                    <div className="grid md:grid-cols-2 gap-4 text-sm mt-2">
                      <div>
                        <div className="muted text-xs">Nachhaltigkeit</div>
                        <div>Köpfe {a.headsNow}{a.headsNow !== a.headsBefore ? <span style={{ color: a.headsNow < a.headsBefore ? COLOR.ROT : COLOR.GRUEN }}> ({a.headsNow > a.headsBefore ? "+" : ""}{a.headsNow - a.headsBefore})</span> : <span className="muted"> (unverändert)</span>}</div>
                        {a.ending.map((e) => <div key={e.engagementId}><Link href={`/einsaetze/${e.engagementId}#verlaengerung`}>{e.person}</Link> <span className="muted">· Ende {fmtDate(e.plannedEnd)} (in {e.daysToEnd} T.) · {e.renewal}</span></div>)}
                        {a.ending.length === 0 && <div className="muted">kein Einsatzende in den nächsten 90 Tagen</div>}
                      </div>
                      <Interesting a={a} />
                    </div>
                    <Prep accountId={a.accountId} prep={a.prep} mayPrepare={a.mayPrepare} />
                  </div>
                </div>
              </article>
            ))}
            {green.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold mb-1" style={{ color: COLOR.GRUEN }}>Grün – nur bestätigen ({green.length})</h3>
                <ul className="space-y-2">
                  {green.map((a) => (
                    <li key={a.accountId} id={`k-${a.accountId}`} className="text-sm p-2" style={{ borderBottom: "1px solid var(--border)" }}>
                      <div className="flex flex-wrap items-baseline gap-3">
                        <Dot a="GRUEN" />
                        <Link href={`/kunden/${a.accountId}`}><strong>{a.name}</strong></Link>
                        <span className="muted">Köpfe {a.headsNow}{a.ending.length ? ` · ${a.ending.length} Einsatz/Einsätze enden in 90 T. (geklärt)` : ""}{a.interesting.newChances.length ? ` · ${a.interesting.newChances.length} neue Chance(n)` : ""}{a.interesting.openCards ? ` · ${a.interesting.openCards} KI-Vorschläge` : ""}</span>
                      </div>
                      <Prep accountId={a.accountId} prep={a.prep} mayPrepare={a.mayPrepare} compact />
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        );
      })}

      {r.radar.length > 0 && (
        <section className="card">
          <h2 className="font-semibold text-lg mb-1">Auf dem Radar ({r.radar.length})</h2>
          <p className="muted text-xs mb-2">Prospects und Ex-Kunden, die ihre Verantwortlichen hierher gesetzt haben – eine Zeile je Kunde.</p>
          <ul className="space-y-2">
            {r.radar.map((x) => (
              <li key={x.accountId} id={`k-${x.accountId}`} className="text-sm">
                <div className="flex flex-wrap items-baseline gap-3">
                  <Link href={`/kunden/${x.accountId}?b=strategie`}><strong>{x.name}</strong></Link>
                  <span className="muted">{accountKindLabel[x.kind]}{x.responsibleName ? ` · ${x.responsibleName}` : ""} · {x.openChances} offene Chance(n)</span>
                </div>
                <Prep accountId={x.accountId} prep={x.prep} mayPrepare={x.mayPrepare} compact />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Interesting({ a }: { a: RoundAccount }) {
  const i = a.interesting;
  const any = i.newChances.length || i.openCards || i.newPersons.length;
  return (
    <div>
      <div className="muted text-xs">Interessantes seit der letzten Runde</div>
      {!any && <div className="muted">nichts Neues dokumentiert</div>}
      {i.newChances.length > 0 && <div>{i.newChances.length} neue Chance(n): {i.newChances.slice(0, 3).map((c, n) => <span key={c.id}>{n ? ", " : ""}<Link href={`/bedarfe/${c.id}`}>{c.title}</Link></span>)}</div>}
      {i.openCards > 0 && <div><Link href={`/kunden/${a.accountId}?b=strategie`}>{i.openCards} offene KI-Vorschläge</Link></div>}
      {i.newPersons.length > 0 && <div>Neu beim Kunden: {i.newPersons.slice(0, 3).join(", ")}{i.newPersons.length > 3 ? " …" : ""}</div>}
    </div>
  );
}
